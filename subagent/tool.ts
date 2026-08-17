import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	railModelKey,
	railModelReference,
	resolveRailModel,
	type RailModelRef,
} from "./models";
import type { StatelessAgentRunner, StatelessRunResult } from "./stateless-runner";
import type {
	DispatchRequest,
	DispatchResult,
	SessionBroker,
	SubagentUsage,
	WorkerRunResult,
} from "./session-broker";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_TASKS = 8;
const MAX_CONCURRENCY = 4;
const OUTPUT_CAP = 50 * 1024;

const SessionSourceSchema = Type.Object({
	mode: StringEnum(["fork", "exclusive"] as const, {
		description: "fork safely copies an existing saved session; exclusive opens it in place",
	}),
	path: Type.String({ description: "Existing Pi session path" }),
});

const TaskItem = Type.Object({
	model: Type.Optional(Type.String({ description: "Pi model reference; defaults to the current model" })),
	target: Type.Optional(Type.String({ description: "Persistent alias or agentId to continue" })),
	alias: Type.Optional(Type.String({ description: "Alias for a new persistent model session" })),
	task: Type.String({ description: "Task or follow-up message" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new session" })),
	session: Type.Optional(SessionSourceSchema),
});

const ChainItem = Type.Object({
	model: Type.Optional(Type.String({ description: "Pi model reference; defaults to the current model" })),
	target: Type.Optional(Type.String({ description: "Persistent alias or agentId to continue" })),
	alias: Type.Optional(Type.String({ description: "Alias for a new persistent model session" })),
	task: Type.String({ description: "Task with optional {previous} placeholder" }),
	cwd: Type.Optional(Type.String()),
	session: Type.Optional(SessionSourceSchema),
});

const SubagentParams = Type.Object({
	model: Type.Optional(Type.String({ description: "Pi model reference; defaults to the current model (single mode)" })),
	target: Type.Optional(Type.String({ description: "Persistent alias or agentId to continue (single mode)" })),
	alias: Type.Optional(Type.String({ description: "Alias for a new persistent model session (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task or follow-up message (single mode)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new session" })),
	session: Type.Optional(SessionSourceSchema),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel model-session tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential tasks with optional {previous}" })),
	confirmSessionAttach: Type.Optional(Type.Boolean({
		default: true,
		description: "Confirm before forking or exclusively opening an existing session",
	})),
});

export interface StatefulSubagentRunDetails {
	agentId?: string;
	alias: string;
	model?: string;
	sessionId?: string;
	task: string;
	status: "running" | "completed" | "failed";
	output: string;
	usage: SubagentUsage;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	persistent: boolean;
}

export interface StatefulSubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: StatefulSubagentRunDetails[];
}

export interface StatefulSubagentToolOptions {
	broker: SessionBroker | (() => SessionBroker);
	runStateless?: StatelessAgentRunner;
}

type TaskParams = {
	model?: string;
	target?: string;
	alias?: string;
	task: string;
	cwd?: string;
	session?: { mode: "fork" | "exclusive"; path: string };
};

function isPersistentTask(item: Pick<TaskParams, "target" | "alias" | "session">): boolean {
	return Boolean(item.target || item.alias || item.session?.path);
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeTask(item: TaskParams): TaskParams {
	const model = nonEmpty(item.model);
	const target = nonEmpty(item.target);
	const alias = nonEmpty(item.alias);
	const cwd = nonEmpty(item.cwd);
	const sessionPath = nonEmpty(item.session?.path);
	return {
		...(model ? { model } : {}),
		...(target ? { target } : {}),
		...(alias ? { alias } : {}),
		task: item.task,
		...(cwd ? { cwd } : {}),
		...(item.session && sessionPath ? { session: { mode: item.session.mode, path: sessionPath } } : {}),
	};
}

function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function truncateOutput(value: string): string {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= OUTPUT_CAP) return value;
	let result = value.slice(0, OUTPUT_CAP);
	while (Buffer.byteLength(result, "utf8") > OUTPUT_CAP) result = result.slice(0, -1);
	return `${result}\n\n[Output truncated: ${bytes - Buffer.byteLength(result, "utf8")} bytes omitted. Full output remains in the child session.]`;
}

function failedRun(run: WorkerRunResult): boolean {
	return run.stopReason === "error" || run.stopReason === "aborted" || Boolean(run.errorMessage);
}

function compactPersistentResult(result: DispatchResult, task: string, step?: number): StatefulSubagentRunDetails {
	return {
		agentId: result.instance.agentId,
		alias: result.instance.alias,
		model: railModelReference(result.instance.model),
		sessionId: result.instance.sessionId,
		task,
		status: failedRun(result.run) ? "failed" : "completed",
		output: truncateOutput(result.run.output),
		usage: result.run.usage,
		...(result.run.stopReason ? { stopReason: result.run.stopReason } : {}),
		...(result.run.errorMessage ? { errorMessage: result.run.errorMessage } : {}),
		...(step !== undefined ? { step } : {}),
		persistent: true,
	};
}

function compactStatelessResult(model: RailModelRef, task: string, run: StatelessRunResult, step?: number): StatefulSubagentRunDetails {
	const reference = railModelReference(model);
	return {
		alias: railModelKey(model),
		model: reference,
		task,
		status: run.exitCode !== 0 || failedRun(run) ? "failed" : "completed",
		output: truncateOutput(run.output),
		usage: run.usage,
		...(run.stopReason ? { stopReason: run.stopReason } : {}),
		...(run.errorMessage ? { errorMessage: truncateOutput(run.errorMessage) } : {}),
		...(step !== undefined ? { step } : {}),
		persistent: false,
	};
}

function errorResult(item: TaskParams, error: unknown, step?: number): StatefulSubagentRunDetails {
	const message = error instanceof Error ? error.message : String(error);
	return {
		alias: item.target ?? item.alias ?? item.model ?? "current-model",
		...(item.model ? { model: item.model } : {}),
		task: item.task,
		status: "failed",
		output: truncateOutput(message),
		usage: emptyUsage(),
		errorMessage: truncateOutput(message),
		...(step !== undefined ? { step } : {}),
		persistent: isPersistentTask(item),
	};
}

type SubagentParamsValue = Static<typeof SubagentParams>;

function modeFor(params: SubagentParamsValue): "single" | "parallel" | "chain" {
	const hasSingle = Boolean(params.task?.trim());
	const hasParallel = (params.tasks?.length ?? 0) > 0;
	const hasChain = (params.chain?.length ?? 0) > 0;
	if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
		throw new Error("Provide exactly one mode: single, parallel, or chain");
	}
	return hasChain ? "chain" : hasParallel ? "parallel" : "single";
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index]!, index);
		}
	}));
	return results;
}

function finalText(result: StatefulSubagentRunDetails): string {
	if (result.status === "failed") return `Subagent ${result.alias} failed: ${result.errorMessage ?? result.output}`;
	if (!result.persistent) return `Stateless model session ${result.model ?? result.alias} completed.\n\n${truncateOutput(result.output)}`;
	return [
		`Persistent model session ${result.alias} (${result.agentId}) completed with ${result.model}.`,
		`Reuse with target="${result.alias}" for related follow-up tasks.`,
		"",
		truncateOutput(result.output),
	].join("\n");
}

function aggregateText(mode: "parallel" | "chain", results: StatefulSubagentRunDetails[]): string {
	const succeeded = results.filter((result) => result.status === "completed").length;
	return `${mode === "parallel" ? "Parallel" : "Chain"}: ${succeeded}/${results.length} succeeded\n\n${results
		.map((result) => `### ${result.alias} [${result.status}]\n\n${truncateOutput(result.output)}`)
		.join("\n\n---\n\n")}`;
}

export function installStatefulSubagentTool(pi: ExtensionAPI, options: StatefulSubagentToolOptions): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run a one-off Pi model session or create/continue persistent model sessions. Omit alias/session for stateless work, add alias for a new persistent session, use target for follow-ups, and use session only to attach an existing saved session. One model may own many independent sessions.",
		promptSnippet: "Run stateless Pi model sessions or create and continue persistent model sessions",
		promptGuidelines: [
			"For one-off delegation, use model+task without alias or session; omit model to use the current Pi model.",
			"When the user names @agent/<alias> or agent://<alias>, use subagent with target set to that exact alias.",
			"When the user names @new/<provider>/<modelId> or new://<provider>/<modelId>, use subagent with model set to that canonical model reference and assign a concise alias.",
			"For follow-up work on the same files or feature, reuse the existing target instead of creating a new session.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const mode = modeFor(params);
			const rawItems: TaskParams[] = mode === "single"
				? [{
					...(params.model ? { model: params.model } : {}),
					...(params.target ? { target: params.target } : {}),
					...(params.alias ? { alias: params.alias } : {}),
					task: params.task!,
					...(params.cwd ? { cwd: params.cwd } : {}),
					...(params.session ? { session: params.session } : {}),
				}]
				: (mode === "parallel" ? params.tasks! : params.chain!) as TaskParams[];
			const requestedItems = rawItems.map(normalizeTask);
			if (mode === "parallel" && requestedItems.length > MAX_PARALLEL_TASKS) {
				throw new Error(`Too many parallel tasks (${requestedItems.length}); max is ${MAX_PARALLEL_TASKS}`);
			}
			if (mode === "chain" && requestedItems.length > MAX_CHAIN_TASKS) {
				throw new Error(`Too many chain tasks (${requestedItems.length}); max is ${MAX_CHAIN_TASKS}`);
			}
			const sessionAttachments = requestedItems.filter((item) => item.session !== undefined);
			if (sessionAttachments.length > 0 && (params.confirmSessionAttach ?? true)) {
				if (!ctx.hasUI) throw new Error("Attaching an existing session requires UI confirmation or confirmSessionAttach=false");
				const approved = await ctx.ui.confirm(
					"Attach existing session as a Rail model session?",
					sessionAttachments
						.map((item) => `${item.alias ?? item.model ?? "current-model"}: ${item.session!.mode} ${item.session!.path}`)
						.join("\n"),
				);
				if (!approved) throw new Error("Existing session attachment was not approved");
			}

			const dispatch = async (item: TaskParams, step?: number): Promise<StatefulSubagentRunDetails> => {
				if (item.target && item.model) throw new Error("A follow-up target cannot also select a model");
				const persistent = isPersistentTask(item);
				if (!persistent) {
					if (!options.runStateless) throw new Error("Stateless model-session runner is not configured");
					const model = resolveRailModel(item.model, ctx);
					const run = await options.runStateless({
						model,
						task: item.task,
						cwd: item.cwd ?? ctx.cwd,
						...(signal ? { signal } : {}),
						onUpdate: (partial) => onUpdate?.({
							content: [{ type: "text", text: partial.output || "(running...)" }],
							details: {
								mode,
								results: [{
									alias: railModelKey(model),
									model: railModelReference(model),
									task: item.task,
									status: "running",
									output: partial.output,
									usage: partial.usage,
									...(step !== undefined ? { step } : {}),
									persistent: false,
								}],
							},
						}),
					});
					return compactStatelessResult(model, item.task, run, step);
				}
				const model = item.target ? undefined : resolveRailModel(item.model, ctx);
				const request: DispatchRequest = {
					...(model ? { model } : {}),
					...(item.target ? { target: item.target } : {}),
					...(item.alias ? { alias: item.alias } : {}),
					task: item.task,
					...(item.cwd ? { cwd: item.cwd } : {}),
					...(item.session ? { session: item.session } : {}),
					...(signal ? { signal } : {}),
					onUpdate: (partial) => onUpdate?.({
						content: [{ type: "text", text: partial.output || "(running...)" }],
						details: {
							mode,
							results: [{
								alias: item.target ?? item.alias ?? (model ? railModelKey(model) : "model-session"),
								...(model ? { model: railModelReference(model) } : {}),
								task: item.task,
								status: "running",
								output: partial.output,
								usage: partial.usage,
								...(step !== undefined ? { step } : {}),
								persistent: true,
							}],
						},
					}),
				};
				const broker = typeof options.broker === "function" ? options.broker() : options.broker;
				return compactPersistentResult(await broker.dispatch(request), item.task, step);
			};

			if (mode === "single") {
				const result = await dispatch(requestedItems[0]!);
				if (result.status === "failed") throw new Error(finalText(result));
				return { content: [{ type: "text", text: finalText(result) }], details: { mode, results: [result] } };
			}
			if (mode === "parallel") {
				const results = await mapWithConcurrency(requestedItems, MAX_CONCURRENCY, async (item) => {
					try {
						return await dispatch(item);
					} catch (error) {
						return errorResult(item, error);
					}
				});
				return { content: [{ type: "text", text: aggregateText(mode, results) }], details: { mode, results } };
			}
			const results: StatefulSubagentRunDetails[] = [];
			let previous = "";
			for (let index = 0; index < requestedItems.length; index++) {
				const raw = requestedItems[index]!;
				const item = { ...raw, task: raw.task.replaceAll("{previous}", previous) };
				try {
					const result = await dispatch(item, index + 1);
					results.push(result);
					if (result.status === "failed") break;
					previous = result.output;
				} catch (error) {
					results.push(errorResult(item, error, index + 1));
					break;
				}
			}
			return { content: [{ type: "text", text: aggregateText(mode, results) }], details: { mode, results } };
		},

		renderCall(args, theme) {
			const mode = args.chain?.length
				? `chain (${args.chain.length})`
				: args.tasks?.length
					? `parallel (${args.tasks.length})`
					: args.target
						? `continue ${args.target}`
						: args.alias || args.session
							? `persistent ${args.model || "current model"}`
							: `stateless ${args.model || "current model"}`;
			const task = args.task ?? args.tasks?.[0]?.task ?? args.chain?.[0]?.task ?? "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", mode)}\n${theme.fg("dim", task.slice(0, 100))}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as StatefulSubagentDetails | undefined;
			if (!details?.results.length) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			const lines: string[] = [];
			for (const item of details.results) {
				const icon = item.status === "failed" ? theme.fg("error", "✗") : item.status === "running" ? theme.fg("warning", "…") : theme.fg("success", "✓");
				lines.push(`${icon} ${theme.fg("toolTitle", theme.bold(item.alias))}${item.agentId ? theme.fg("dim", ` ${item.agentId}`) : theme.fg("dim", " stateless")}`);
				const output = expanded ? item.output : item.output.split("\n").slice(0, 5).join("\n");
				if (output) lines.push(theme.fg("toolOutput", output));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
