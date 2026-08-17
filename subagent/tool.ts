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
import {
	appendSubagentTranscriptFailure,
	boundSubagentRunTranscripts,
	renderSubagentTranscript,
	type SubagentTranscriptSnapshot,
} from "./transcript";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_TASKS = 8;
const MAX_CONCURRENCY = 4;
const OUTPUT_CAP = 50 * 1024;

const SessionSourceSchema = Type.Object({
	mode: StringEnum(["fork", "exclusive"] as const, {
		description: "How to adopt an existing saved Pi session: use fork by default to preserve the original; use exclusive only when the user explicitly wants in-place ownership and no other process has it open",
	}),
	path: Type.String({ description: "Existing saved Pi session path whose conversation history and project context should be continued" }),
});

const TaskItem = Type.Object({
	model: Type.Optional(Type.String({ description: "Pi model reference; omit to use the current model. Use with no alias/session for stateless work or with alias to create a persistent session." })),
	target: Type.Optional(Type.String({ description: "Exact linked persistent alias or agentId whose existing conversation memory should continue; omit model when target is set" })),
	alias: Type.Optional(Type.String({ description: "Alias for a new persistent long-term helper that is expected to receive follow-ups; omit for one-off stateless work" })),
	task: Type.String({ description: "Self-contained one-off task for stateless work, concrete initial task for a new persistent helper, or follow-up message for target" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new or adopted session; when adopting a cross-project saved session, use its original project directory when known" })),
	session: Type.Optional(SessionSourceSchema),
});

const ChainItem = Type.Object({
	model: Type.Optional(Type.String({ description: "Pi model reference; omit to use the current model" })),
	target: Type.Optional(Type.String({ description: "Exact linked persistent alias or agentId to continue; omit model when target is set" })),
	alias: Type.Optional(Type.String({ description: "Alias for a new persistent helper expected to receive follow-ups; omit for stateless work" })),
	task: Type.String({ description: "Self-contained task, persistent initial/follow-up task, and optional {previous} placeholder" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new or adopted session" })),
	session: Type.Optional(SessionSourceSchema),
});

const SubagentParams = Type.Object({
	model: Type.Optional(Type.String({ description: "Pi model reference; omit to use the current model. In single mode, model+task without alias/session is stateless; model+alias+task creates persistent." })),
	target: Type.Optional(Type.String({ description: "Continue the exact linked persistent alias or agentId and its existing conversation memory; do not also set model" })),
	alias: Type.Optional(Type.String({ description: "Create a new persistent long-term helper expected to receive future follow-ups; omit for one-off stateless work" })),
	task: Type.Optional(Type.String({ description: "Self-contained stateless task, concrete initial task for a new persistent helper, or persistent follow-up message" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new or adopted session; preserve the saved session project directory for cross-project work when known" })),
	session: Type.Optional(SessionSourceSchema),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Independent model-session tasks to run in parallel; each item may be stateless or persistent" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential model-session tasks; {previous} inserts the preceding final output" })),
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
	transcript?: SubagentTranscriptSnapshot;
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
		...(result.run.transcript ? { transcript: result.run.transcript } : {}),
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
		...(run.transcript ? { transcript: run.transcript } : {}),
		usage: run.usage,
		...(run.stopReason ? { stopReason: run.stopReason } : {}),
		...(run.errorMessage ? { errorMessage: truncateOutput(run.errorMessage) } : {}),
		...(step !== undefined ? { step } : {}),
		persistent: false,
	};
}

function errorResult(
	item: TaskParams,
	error: unknown,
	step?: number,
	previous?: StatefulSubagentRunDetails,
): StatefulSubagentRunDetails {
	const message = error instanceof Error ? error.message : String(error);
	return {
		...(previous ?? {}),
		alias: previous?.alias ?? item.target ?? item.alias ?? item.model ?? "current-model",
		...(previous?.model ? { model: previous.model } : item.model ? { model: item.model } : {}),
		task: item.task,
		status: "failed",
		output: truncateOutput(message),
		transcript: appendSubagentTranscriptFailure(previous?.transcript, item.task, message),
		usage: previous?.usage ?? emptyUsage(),
		errorMessage: truncateOutput(message),
		...(step !== undefined ? { step } : {}),
		persistent: previous?.persistent ?? isPersistentTask(item),
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
	const latestDetails = new Map<string, StatefulSubagentDetails>();
	const eventApi = pi as Partial<Pick<ExtensionAPI, "on">>;
	eventApi.on?.("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		const details = latestDetails.get(event.toolCallId);
		latestDetails.delete(event.toolCallId);
		if (event.isError && details) return { details };
		return undefined;
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate work to Pi model sessions using the lifecycle that matches expected continuity. Continue an already linked persistent helper with target+task. Adopt an existing saved Pi session with session (fork by default) when its conversation history or project context matters, especially for cross-project work. Create a new persistent long-term helper with model+alias+concrete task only when future follow-ups are expected. Use model+task with no alias/target/session for one-off stateless work. Use tasks for independent parallel work and chain for sequential handoff. Child sessions can use normal Pi tools but cannot recursively call subagent.",
		promptSnippet: "Delegate self-contained work to stateless Pi model sessions, or create and continue persistent model sessions",
		promptGuidelines: [
			"Choose the subagent lifecycle by continuity: use target for an already linked persistent helper; use session in fork mode to adopt an existing saved Pi session whose history or project context matters; use model+alias+task for a new long-term helper expected to receive follow-ups; otherwise use model+task as stateless one-off work.",
			"For an existing linked subagent, continue with target+task and no model. Reuse the exact alias so the same child conversation memory, session, and working context continue.",
			"When adopting an existing saved Pi session, use session mode fork by default so the original remains untouched. This is appropriate for continuing prior work or modifying another repository; preserve that session's project cwd when known. Use exclusive only with explicit user intent and no other writer.",
			"Create a new persistent subagent only when future follow-ups need the same child context. The first model+alias call must include a concrete initial task; do not create an empty, idle, or placeholder persistent session. One model can back many aliases with independent histories.",
			"For stateless subagent work, call subagent with task and optional model only. Omit alias, target, and session. Use it proactively for bounded code search, focused analysis, verification, comparison, or review, and make the task self-contained because no state persists.",
			"In subagent calls, omit model to use the current Pi model. Select an explicit model only when the delegated task benefits from a different model or thinking level.",
			"In subagent, use tasks for independent parallel delegation. Use chain only when each step depends on the previous result, inserting {previous} where the prior final output is needed.",
			"When the user names @agent/<alias> or agent://<alias>, use subagent with target set to that exact alias.",
			"When the user names @new/<provider>/<modelId> or new://<provider>/<modelId>, use subagent with model set to that canonical model reference and assign a concise alias.",
			"Subagent child sessions cannot recursively call subagent. Keep nested decomposition and orchestration in the parent session.",
			"In subagent calls, use session only to adopt an existing saved Pi session; do not set it for ordinary stateless work or a newly created persistent helper.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const mode = modeFor(params);
			const liveResults = new Map<number, StatefulSubagentRunDetails>();
			const resultDetails = (results: StatefulSubagentRunDetails[]): StatefulSubagentDetails => ({
				mode,
				results: boundSubagentRunTranscripts(results),
			});
			const publishLive = (slot: number, result: StatefulSubagentRunDetails) => {
				liveResults.set(slot, result);
				const results = [...liveResults.entries()]
					.sort(([left], [right]) => left - right)
					.map(([, item]) => item);
				const details = resultDetails(results);
				latestDetails.set(toolCallId, details);
				onUpdate?.({
					content: [{ type: "text", text: result.output || "(running...)" }],
					details,
				});
			};
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

			const dispatch = async (item: TaskParams, slot: number, step?: number): Promise<StatefulSubagentRunDetails> => {
				if (item.target && item.model) throw new Error("A follow-up target cannot also select a model");
				const persistent = isPersistentTask(item);
				if (!persistent) {
					if (!options.runStateless) throw new Error("Stateless model-session runner is not configured");
					const model = resolveRailModel(item.model, ctx);
					publishLive(slot, {
						alias: railModelKey(model),
						model: railModelReference(model),
						task: item.task,
						status: "running",
						output: "(starting...)",
						usage: emptyUsage(),
						...(step !== undefined ? { step } : {}),
						persistent: false,
					});
					const run = await options.runStateless({
						model,
						task: item.task,
						cwd: item.cwd ?? ctx.cwd,
						...(signal ? { signal } : {}),
						onUpdate: (partial) => publishLive(slot, {
							alias: railModelKey(model),
							model: railModelReference(model),
							task: item.task,
							status: "running",
							output: partial.output,
							...(partial.transcript ? { transcript: partial.transcript } : {}),
							usage: partial.usage,
							...(step !== undefined ? { step } : {}),
							persistent: false,
						}),
					});
					const result = compactStatelessResult(model, item.task, run, step);
					publishLive(slot, result);
					return result;
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
					onUpdate: ({ instance, run: partial }) => publishLive(slot, {
						agentId: instance.agentId,
						alias: instance.alias,
						model: railModelReference(instance.model),
						sessionId: instance.sessionId,
						task: item.task,
						status: "running",
						output: partial.output,
						...(partial.transcript ? { transcript: partial.transcript } : {}),
						usage: partial.usage,
						...(step !== undefined ? { step } : {}),
						persistent: true,
					}),
				};
				const broker = typeof options.broker === "function" ? options.broker() : options.broker;
				const result = compactPersistentResult(await broker.dispatch(request), item.task, step);
				publishLive(slot, result);
				return result;
			};

			if (mode === "single") {
				let result: StatefulSubagentRunDetails;
				try {
					result = await dispatch(requestedItems[0]!, 0);
				} catch (error) {
					result = errorResult(requestedItems[0]!, error, undefined, liveResults.get(0));
					publishLive(0, result);
				}
				if (result.status === "failed") throw new Error(finalText(result));
				const details = resultDetails([result]);
				latestDetails.set(toolCallId, details);
				return { content: [{ type: "text", text: finalText(result) }], details };
			}
			if (mode === "parallel") {
				const results = await mapWithConcurrency(requestedItems, MAX_CONCURRENCY, async (item, index) => {
					try {
						return await dispatch(item, index);
					} catch (error) {
						const result = errorResult(item, error, undefined, liveResults.get(index));
						publishLive(index, result);
						return result;
					}
				});
				const details = resultDetails(results);
				latestDetails.set(toolCallId, details);
				return { content: [{ type: "text", text: aggregateText(mode, results) }], details };
			}
			const results: StatefulSubagentRunDetails[] = [];
			let previous = "";
			for (let index = 0; index < requestedItems.length; index++) {
				const raw = requestedItems[index]!;
				const item = { ...raw, task: raw.task.replaceAll("{previous}", previous) };
				try {
					const result = await dispatch(item, index, index + 1);
					results.push(result);
					if (result.status === "failed") break;
					previous = result.output;
				} catch (error) {
					const result = errorResult(item, error, index + 1, liveResults.get(index));
					publishLive(index, result);
					results.push(result);
					break;
				}
			}
			const details = resultDetails(results);
			latestDetails.set(toolCallId, details);
			return { content: [{ type: "text", text: aggregateText(mode, results) }], details };
		},

		renderCall(args, theme) {
			const mode = args.chain?.length
				? `chain (${args.chain.length})`
				: args.tasks?.length
					? `parallel (${args.tasks.length})`
					: args.target
						? `persistent continue ${args.target}`
						: args.alias || args.session
							? `persistent new ${args.model || "current model"}`
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
			return renderSubagentTranscript(details.results, expanded, theme);
		},
	});
}
