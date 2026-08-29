import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type MarkdownTheme, Text } from "@earendil-works/pi-tui";
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
const DETAILS_TOTAL_CAP = 512 * 1024;

const SessionSourceSchema = Type.Object({
	mode: StringEnum(["fork", "exclusive"] as const, {
		description: "How to adopt an existing saved Pi session: use fork by default to preserve the original; use exclusive only when the user explicitly wants in-place ownership and no other process has it open",
	}),
	path: Type.String({ description: "Existing saved Pi session path whose conversation history and project context should be continued" }),
});

const ControlSchema = Type.Object({
	delivery: StringEnum(["steer", "followUp"] as const, {
		description: "steer is delivered after the current child assistant turn and its tool calls, before the next model call; followUp runs after the child's current work finishes",
	}),
	message: Type.String({ description: "Control message for an already-running local persistent subagent" }),
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
	control: Type.Optional(ControlSchema),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Group independent model-session tasks inside one subagent Tool Call; each item may be stateless or persistent. Use only when one grouped parent Tool Call with child panels is desired." })),
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
	status: "running" | "completed" | "accepted" | "failed";
	output: string;
	transcript?: SubagentTranscriptSnapshot;
	usage: SubagentUsage;
	durationMs: number;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	persistent: boolean;
	outputTruncated?: boolean;
}

export interface StatefulSubagentDetails {
	mode: "single" | "parallel" | "chain" | "control";
	results: StatefulSubagentRunDetails[];
	durationMs: number;
}

export interface StatefulSubagentToolOptions {
	broker: SessionBroker | (() => SessionBroker);
	runStateless?: StatelessAgentRunner;
	getMarkdownTheme?: () => MarkdownTheme;
}

function markdownThemeFromTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
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

function utf8Prefix(value: string, maxBytes: number): string {
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let result = value.slice(0, low);
	if (result && /[\uD800-\uDBFF]$/u.test(result)) result = result.slice(0, -1);
	return result;
}

function truncateUtf8(value: string, maxBytes: number, suffix: string): { value: string; truncated: boolean } {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= maxBytes) return { value, truncated: false };
	const safeSuffix = utf8Prefix(suffix, maxBytes);
	const target = Math.max(0, maxBytes - Buffer.byteLength(safeSuffix, "utf8"));
	return { value: `${utf8Prefix(value, target)}${safeSuffix}`, truncated: true };
}

function truncateParentContent(value: string): string {
	return truncateUtf8(
		value,
		OUTPUT_CAP,
		"\n\n[Output truncated for the parent context. Expand the Tool Call for the retained final answer.]",
	).value;
}

function boundDetailTranscript(snapshot: SubagentTranscriptSnapshot): SubagentTranscriptSnapshot {
	return {
		...snapshot,
		entries: snapshot.entries.map((entry) => entry.initial
			? { ...entry, text: truncateUtf8(entry.text, 8 * 1024, "\n[initial task truncated in parent details]").value }
			: entry),
	};
}

function boundDetailOutputs(results: StatefulSubagentRunDetails[]): StatefulSubagentRunDetails[] {
	const metadataBounded = results.map((result) => ({
		...result,
		task: truncateUtf8(result.task, 8 * 1024, "\n[task truncated]").value,
		...(result.transcript ? { transcript: boundDetailTranscript(result.transcript) } : {}),
		...(result.errorMessage ? { errorMessage: truncateUtf8(result.errorMessage, 8 * 1024, "\n[error truncated]").value } : {}),
	}));
	const baseBytes = Buffer.byteLength(JSON.stringify(metadataBounded.map((result) => ({ ...result, output: "" }))), "utf8");
	const outputBudget = Math.max(0, DETAILS_TOTAL_CAP - 4096 - baseBytes);
	const perRun = Math.floor(outputBudget / Math.max(1, metadataBounded.length));
	return metadataBounded.map((result) => {
		const bounded = truncateUtf8(
			result.output,
			perRun,
			result.persistent
				? "\n\n[Final answer truncated in the parent session details. The full answer remains in the persistent child session.]"
				: "\n\n[Final answer truncated in the parent session details.]",
		);
		return bounded.truncated ? { ...result, output: bounded.value, outputTruncated: true } : result;
	});
}

function failedRun(run: WorkerRunResult): boolean {
	return run.stopReason === "error" || run.stopReason === "aborted" || Boolean(run.errorMessage);
}

function compactPersistentResult(result: DispatchResult, task: string, durationMs: number, step?: number): StatefulSubagentRunDetails {
	return {
		agentId: result.instance.agentId,
		alias: result.instance.alias,
		model: railModelReference(result.instance.model),
		sessionId: result.instance.sessionId,
		task,
		status: failedRun(result.run) ? "failed" : "completed",
		output: result.run.output,
		...(result.run.transcript ? { transcript: result.run.transcript } : {}),
		usage: result.run.usage,
		durationMs,
		...(result.run.stopReason ? { stopReason: result.run.stopReason } : {}),
		...(result.run.errorMessage ? { errorMessage: result.run.errorMessage } : {}),
		...(step !== undefined ? { step } : {}),
		persistent: true,
	};
}

function compactStatelessResult(alias: string, model: RailModelRef, task: string, run: StatelessRunResult, durationMs: number, step?: number): StatefulSubagentRunDetails {
	const reference = railModelReference(model);
	return {
		alias,
		model: reference,
		task,
		status: run.exitCode !== 0 || failedRun(run) ? "failed" : "completed",
		output: run.output,
		...(run.transcript ? { transcript: run.transcript } : {}),
		usage: run.usage,
		durationMs,
		...(run.stopReason ? { stopReason: run.stopReason } : {}),
		...(run.errorMessage ? { errorMessage: truncateParentContent(run.errorMessage) } : {}),
		...(step !== undefined ? { step } : {}),
		persistent: false,
	};
}

function errorResult(
	item: TaskParams,
	error: unknown,
	durationMs: number,
	aborted: boolean,
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
		output: truncateParentContent(message),
		transcript: appendSubagentTranscriptFailure(previous?.transcript, item.task, message),
		usage: previous?.usage ?? emptyUsage(),
		durationMs,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: truncateParentContent(message),
		...(step !== undefined ? { step } : {}),
		persistent: previous?.persistent ?? isPersistentTask(item),
	};
}

type SubagentParamsValue = Static<typeof SubagentParams>;
type SubagentMode = "single" | "parallel" | "chain" | "control";

function modeFor(params: SubagentParamsValue): SubagentMode {
	const hasSingle = Boolean(params.task?.trim());
	const hasParallel = (params.tasks?.length ?? 0) > 0;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasControl = Boolean(nonEmpty(params.control?.message));
	if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) + Number(hasControl) !== 1) {
		throw new Error("Provide exactly one mode: single, parallel, chain, or control");
	}
	return hasControl ? "control" : hasChain ? "chain" : hasParallel ? "parallel" : "single";
}

function filterParamsForMode(params: SubagentParamsValue, mode: SubagentMode): SubagentParamsValue {
	const confirmSessionAttach = typeof params.confirmSessionAttach === "boolean"
		? { confirmSessionAttach: params.confirmSessionAttach }
		: {};
	if (mode === "parallel") {
		return { tasks: params.tasks!.map(normalizeTask), ...confirmSessionAttach };
	}
	if (mode === "chain") {
		return { chain: params.chain!.map(normalizeTask), ...confirmSessionAttach };
	}
	if (mode === "control") {
		const target = nonEmpty(params.target);
		const message = nonEmpty(params.control?.message);
		return {
			...(target ? { target } : {}),
			...(params.control && message ? { control: { delivery: params.control.delivery, message } } : {}),
		};
	}
	const model = nonEmpty(params.model);
	const target = nonEmpty(params.target);
	const alias = nonEmpty(params.alias);
	const cwd = nonEmpty(params.cwd);
	const sessionPath = nonEmpty(params.session?.path);
	return {
		...(model ? { model } : {}),
		...(target ? { target } : {}),
		...(alias ? { alias } : {}),
		task: params.task!,
		...(cwd ? { cwd } : {}),
		...(params.session && sessionPath ? { session: { mode: params.session.mode, path: sessionPath } } : {}),
		...confirmSessionAttach,
	};
}

function initialTasksForRender(args: SubagentParamsValue | undefined): string[] {
	if (args?.chain?.length) return args.chain.map((item) => item.task);
	if (args?.tasks?.length) return args.tasks.map((item) => item.task);
	const task = nonEmpty(args?.task);
	return task ? [task] : [];
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
	if (result.status === "failed") return truncateParentContent(`Subagent ${result.alias} failed: ${result.errorMessage ?? result.output}`);
	if (!result.persistent) return truncateParentContent(`Stateless model session ${result.model ?? result.alias} completed.\n\n${result.output}`);
	return truncateParentContent([
		`Persistent model session ${result.alias} (${result.agentId}) completed with ${result.model}.`,
		`Reuse with target="${result.alias}" for related follow-up tasks.`,
		"",
		result.output,
	].join("\n"));
}

function aggregateText(mode: "parallel" | "chain", results: StatefulSubagentRunDetails[]): string {
	const succeeded = results.filter((result) => result.status === "completed").length;
	const summary = [
		`${mode === "parallel" ? "Parallel" : "Chain"}: ${succeeded}/${results.length} succeeded`,
		...results.map((result) => {
			const error = result.errorMessage?.replace(/\s+/gu, " ").trim();
			return `- ${result.alias} · ${result.status} · ${result.model ?? "model unavailable"}${error ? ` · ${error.slice(0, 300)}` : ""}`;
		}),
	].join("\n");
	const remaining = Math.max(1024, OUTPUT_CAP - Buffer.byteLength(summary, "utf8") - 512);
	const perRun = Math.max(512, Math.floor(remaining / Math.max(1, results.length)));
	const outputs = results.map((result) => {
		const snippet = truncateUtf8(result.output, perRun, "\n[answer snippet truncated]").value;
		return `### ${result.alias} [${result.status}]\n\n${snippet}`;
	}).join("\n\n---\n\n");
	return truncateParentContent(`${summary}\n\n${outputs}`);
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
		description: "Delegate work to Pi model sessions using the lifecycle that matches expected continuity. Continue an already linked persistent helper with target+task. Adopt an existing saved Pi session with session (fork by default) when its conversation history or project context matters, especially for cross-project work. Create a new persistent long-term helper with model+alias+concrete task only when future follow-ups are expected. Use model+task with no alias/target/session for one-off stateless work; stateless runs create no saved JSONL and do not appear in /resume. Use target+control to send steer or followUp to an already-running local persistent helper: steer is delivered before its next model call, while followUp runs after its current work finishes. Controls do not start stopped or idle sessions and must not be issued as a sibling of the dispatch they intend to control. This mode is mainly for host-side or external orchestration because a parent LLM normally cannot issue another Tool Call while its own dispatch is still pending. For independent work that should appear as separate top-level Tool Call panels, emit multiple sibling subagent calls in the same assistant turn, give each call one single-mode task, and do not use the tasks array; Pi executes those sibling calls concurrently. Use tasks only when one grouped parent Tool Call containing multiple child panels is desired. Use chain for sequential handoff. Persistent agents can be permanently deleted from /rail-agent; deletion removes only the Rail descriptor and child JSONL, intentionally does not rewrite other parent sessions, and their later calls will fail as unknown. Child sessions can use normal Pi tools but cannot recursively call subagent.",
		promptSnippet: "Delegate self-contained work to stateless Pi model sessions, or create and continue persistent model sessions",
		executionMode: "parallel",
		promptGuidelines: [
			"Choose the subagent lifecycle by continuity: use target for an already linked persistent helper; use session in fork mode to adopt an existing saved Pi session whose history or project context matters; use model+alias+task for a new long-term helper expected to receive follow-ups; otherwise use model+task as stateless one-off work.",
			"For an existing linked subagent, continue with target+task and no model. Reuse the exact alias so the same child conversation memory, session, and working context continue.",
			"When adopting an existing saved Pi session, use session mode fork by default so the original remains untouched. This is appropriate for continuing prior work or modifying another repository; preserve that session's project cwd when known. Use exclusive only with explicit user intent and no other writer.",
			"Create a new persistent subagent only when future follow-ups need the same child context. The first model+alias call must include a concrete initial task; do not create an empty, idle, or placeholder persistent session. One model can back many aliases with independent histories.",
			"For stateless subagent work, call subagent with task and optional model only. Omit alias, target, and session. Use it proactively for bounded code search, focused analysis, verification, comparison, or review, and make the task self-contained because no state persists. Stateless runs create no child JSONL and never appear in /resume.",
			"In subagent calls, omit model to use the current Pi model. Select an explicit model only when the delegated task benefits from a different model or thinking level.",
			"For independent parallel work that should have separate top-level Tool Call panels, emit multiple sibling subagent calls in the same assistant turn. Give each call exactly one single-mode task using model+task, target+task, or model+alias+task as appropriate; do not put those tasks in one tasks array. Pi preflights sibling calls in order and executes them concurrently.",
			"Use the tasks array only when the user wants one grouped subagent Tool Call with multiple child panels. Use chain only when each step depends on the previous result, inserting {previous} where the prior final output is needed.",
			"Live controls apply only to an already-running local persistent subagent. Use target+control with delivery=steer to redirect it before its next model call, or delivery=followUp to queue work after its current run. Do not include task, model, alias, session, tasks, or chain in a control call. Do not issue a control as a sibling of the initial dispatch because startup and preflight can race. A parent LLM normally cannot call control while its own subagent Tool Call is pending, so the practical interactive path is /rail-agent and the Tool control mode is primarily for host-side or external orchestration.",
			"When a child asks for input or another specialist in its ordinary final answer (for example by using the plain-language labels needs_input or specialist_request), keep orchestration in the parent: resolve the question or dispatch the specialist, then continue the original persistent child with target+task. These labels are guidance, not a structured wire protocol. Do not enable recursive child subagent calls.",
			"When the user names @agent/<alias> or agent://<alias>, use subagent with target set to that exact alias.",
			"When the user names @new/<provider>/<modelId> or new://<provider>/<modelId>, use subagent with model set to that canonical model reference and assign a concise alias.",
			"Subagent child sessions cannot recursively call subagent. Keep nested decomposition and orchestration in the parent session.",
			"In subagent calls, use session only to adopt an existing saved Pi session; do not set it for ordinary stateless work or a newly created persistent helper.",
			"Persistent subagents may be permanently deleted from the /rail-agent panel. Deletion intentionally removes only that child JSONL and Rail descriptor; it does not rewrite links stored in other parent sessions, so later target calls from those sessions fail with an unknown persistent subagent error.",
		],
		parameters: SubagentParams,
		prepareArguments(params: unknown): SubagentParamsValue {
			const candidate = params as SubagentParamsValue;
			try {
				return filterParamsForMode(candidate, modeFor(candidate));
			} catch {
				return candidate;
			}
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let toolStartedAt = performance.now();
			const mode = modeFor(params);
			params = filterParamsForMode(params, mode);
			const liveResults = new Map<number, StatefulSubagentRunDetails>();
			const runStartedAt = new Map<number, number>();
			const runDuration = (slot: number) => Math.max(0, Math.round(performance.now() - (runStartedAt.get(slot) ?? performance.now())));
			const resultDetails = (results: StatefulSubagentRunDetails[]): StatefulSubagentDetails => ({
				mode,
				results: boundDetailOutputs(boundSubagentRunTranscripts(results)),
				durationMs: Math.max(0, Math.round(performance.now() - toolStartedAt)),
			});
			if (mode === "control") {
				if (!params.target?.trim()) throw new Error("Control mode requires target for an existing persistent subagent");
				const message = params.control!.message.trim();
				if (!message) throw new Error("Subagent control message cannot be empty");
				if (signal?.aborted) throw new Error("Subagent control was aborted before delivery");
				const broker = typeof options.broker === "function" ? options.broker() : options.broker;
				try {
					const controlled = await broker.control({
						target: params.target.trim(),
						delivery: params.control!.delivery,
						message,
						...(signal ? { signal } : {}),
					});
					const label = controlled.delivery === "steer" ? "Steer" : "Follow-up";
					const output = `${label} accepted by ${controlled.instance.alias}`;
					const result: StatefulSubagentRunDetails = {
						agentId: controlled.instance.agentId,
						alias: controlled.instance.alias,
						model: railModelReference(controlled.instance.model),
						sessionId: controlled.instance.sessionId,
						task: message,
						status: "accepted",
						output,
						usage: emptyUsage(),
						durationMs: Math.max(0, Math.round(performance.now() - toolStartedAt)),
						stopReason: "accepted",
						persistent: true,
					};
					const details = resultDetails([result]);
					latestDetails.set(toolCallId, details);
					return { content: [{ type: "text", text: output }], details };
				} catch (error) {
					const failed = errorResult(
						{ target: params.target.trim(), task: message },
						error,
						Math.max(0, Math.round(performance.now() - toolStartedAt)),
						signal?.aborted ?? false,
					);
					latestDetails.set(toolCallId, resultDetails([failed]));
					throw error;
				}
			}
			const publishLive = (slot: number, result: StatefulSubagentRunDetails) => {
				liveResults.set(slot, result);
				const results = [...liveResults.entries()]
					.sort(([left], [right]) => left - right)
					.map(([, item]) => item);
				const details = resultDetails(results);
				latestDetails.set(toolCallId, details);
				onUpdate?.({
					content: [{ type: "text", text: truncateParentContent(result.output || "(running...)") }],
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
			toolStartedAt = performance.now();

			const dispatch = async (item: TaskParams, slot: number, step?: number): Promise<StatefulSubagentRunDetails> => {
				runStartedAt.set(slot, performance.now());
				const duration = () => runDuration(slot);
				if (signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
				if (item.target && item.model) throw new Error("A follow-up target cannot also select a model");
				const persistent = isPersistentTask(item);
				if (!persistent) {
					if (!options.runStateless) throw new Error("Stateless model-session runner is not configured");
					const model = resolveRailModel(item.model, ctx);
					const alias = mode === "single" ? railModelKey(model) : `${railModelKey(model)} #${slot + 1}`;
					publishLive(slot, {
						alias,
						model: railModelReference(model),
						task: item.task,
						status: "running",
						output: "(starting...)",
						usage: emptyUsage(),
						durationMs: duration(),
						...(step !== undefined ? { step } : {}),
						persistent: false,
					});
					const run = await options.runStateless({
						model,
						task: item.task,
						cwd: item.cwd ?? ctx.cwd,
						...(signal ? { signal } : {}),
						onUpdate: (partial) => publishLive(slot, {
							alias,
							model: railModelReference(model),
							task: item.task,
							status: "running",
							output: partial.output,
							...(partial.transcript ? { transcript: partial.transcript } : {}),
							usage: partial.usage,
							durationMs: duration(),
							...(step !== undefined ? { step } : {}),
							persistent: false,
						}),
					});
					const result = compactStatelessResult(alias, model, item.task, run, duration(), step);
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
						durationMs: duration(),
						...(step !== undefined ? { step } : {}),
						persistent: true,
					}),
				};
				const broker = typeof options.broker === "function" ? options.broker() : options.broker;
				const result = compactPersistentResult(await broker.dispatch(request), item.task, duration(), step);
				publishLive(slot, result);
				return result;
			};

			if (mode === "single") {
				let result: StatefulSubagentRunDetails;
				try {
					result = await dispatch(requestedItems[0]!, 0);
				} catch (error) {
					result = errorResult(requestedItems[0]!, error, runDuration(0), signal?.aborted ?? false, undefined, liveResults.get(0));
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
						const result = errorResult(item, error, runDuration(index), signal?.aborted ?? false, undefined, liveResults.get(index));
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
					const result = errorResult(item, error, runDuration(index), signal?.aborted ?? false, index + 1, liveResults.get(index));
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
			const controlMessage = nonEmpty(args.control?.message);
			const mode = controlMessage
				? `control ${args.control!.delivery} ${args.target ?? "target required"}`
				: args.chain?.length
				? `chain (${args.chain.length})`
				: args.tasks?.length
					? `parallel (${args.tasks.length})`
					: nonEmpty(args.target)
						? `persistent continue ${args.target!.trim()}`
						: nonEmpty(args.alias) || nonEmpty(args.session?.path)
							? `persistent new ${args.model || "current model"}`
							: `stateless ${args.model || "current model"}`;
			const task = controlMessage ?? args.task ?? args.tasks?.[0]?.task ?? args.chain?.[0]?.task ?? "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", mode)}\n${theme.fg("dim", task.slice(0, 100))}`, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as StatefulSubagentDetails | undefined;
			if (!details?.results.length) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			return renderSubagentTranscript(details.results, expanded, theme, {
				isPartial,
				durationMs: details.durationMs,
				initialTasks: initialTasksForRender(context?.args),
				markdownTheme: options.getMarkdownTheme?.() ?? markdownThemeFromTheme(theme),
			});
		},
	});
}
