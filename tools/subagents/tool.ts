import { TeamRunManager, teamCallSignal, teamStatus } from "./team-runner";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type MarkdownTheme, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { normalizeContextWindow, validateContextWindowReserve } from "./context-window";
import { supportsNativeFastMode, supportsNativeGptFastMode, type NativeFastModel } from "../../commands/rail-fast";
import { supportsNativeGptSearch } from "../../commands/rail-oai-search";
import { isGptModel } from "../../openai/model-eligibility";
import {
	railModelKey,
	railModelReference,
	resolveRailModel,
	type RailModelRef,
} from "./models";
import type { StatelessAgentRunner, StatelessRunResult } from "./stateless-runner";
import { runErrorMessage } from "./session-broker";
import type {
	DispatchRequest,
	DispatchResult,
	SessionBroker,
	SubagentUsage,
} from "./session-broker";
import {
	appendSubagentTranscriptFailure,
	boundSubagentRunTranscripts,
	renderSubagentTranscript,
	type SubagentTranscriptRun,
	type SubagentTranscriptSnapshot,
} from "./transcript";
import { emptySubagentUsage } from "./usage";

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

function contextWindowSchema() {
	return Type.Optional(Type.Union([
		Type.Number(),
		Type.Null(),
	], {
		default: null,
		description: "Child-local context/compaction budget. Use null by default; null or omission uses the selected child model's native default. Use a positive safe integer only when the user explicitly requests one.",
	}));
}

function fastModeSchema() {
	return Type.Optional(Type.Union([
		Type.Boolean(),
		Type.Null(),
	], {
		default: null,
		description: "Use native OpenAI priority fast mode for a stateless call or a new persistent agent. Ignored on a non-GPT model, where the dispatch still runs with Fast off; a GPT model on an API without native support still fails the eligibility check. null or omission means off. Existing targets are managed in /rail-agent.",
	}));
}

const TaskItem = Type.Object({
	model: Type.Optional(Type.String({ description: "Pi model reference; omit to use the current model. Use with no alias/session for stateless work or with alias to create a persistent session." })),
	target: Type.Optional(Type.String({ description: "Exact linked persistent alias or agentId whose existing conversation memory should continue; omit model when target is set" })),
	alias: Type.Optional(Type.String({ description: "Alias for a new persistent long-term helper that is expected to receive follow-ups; omit for one-off stateless work" })),
	task: Type.String({ description: "Self-contained one-off task for stateless work, concrete initial task for a new persistent helper, or follow-up message for target" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new or adopted session; when adopting a cross-project saved session, use its original project directory when known" })),
	session: Type.Optional(SessionSourceSchema),
	contextWindow: contextWindowSchema(),
	fastMode: fastModeSchema(),
});

const ChainItem = Type.Object({
	model: Type.Optional(Type.String({ description: "Pi model reference; omit to use the current model" })),
	target: Type.Optional(Type.String({ description: "Exact linked persistent alias or agentId to continue; omit model when target is set" })),
	alias: Type.Optional(Type.String({ description: "Alias for a new persistent helper expected to receive follow-ups; omit for stateless work" })),
	task: Type.String({ description: "Self-contained task, persistent initial/follow-up task, and optional {previous} placeholder" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new or adopted session" })),
	session: Type.Optional(SessionSourceSchema),
	contextWindow: contextWindowSchema(),
	fastMode: fastModeSchema(),
});

const SubagentParams = Type.Object({
	teamId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Prepared team id. Launch coordinator single and exact workers parallel as two sibling calls; new persistent aliases only." })),
	model: Type.Optional(Type.String({ description: "Pi model reference; omit to use the current model. In single mode, model+task without alias/session is stateless; model+alias+task creates persistent." })),
	target: Type.Optional(Type.String({ description: "Continue the exact linked persistent alias or agentId and its existing conversation memory; do not also set model" })),
	alias: Type.Optional(Type.String({ description: "Create a new persistent long-term helper expected to receive future follow-ups; omit for one-off stateless work" })),
	task: Type.Optional(Type.String({ description: "Self-contained stateless task, concrete initial task for a new persistent helper, or persistent follow-up message" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new or adopted session; preserve the saved session project directory for cross-project work when known" })),
	session: Type.Optional(SessionSourceSchema),
	contextWindow: contextWindowSchema(),
	fastMode: fastModeSchema(),
	control: Type.Optional(ControlSchema),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Group independent model-session tasks inside one subagent Tool Call; each item may be stateless or persistent. Use only when one grouped parent Tool Call with child panels is desired." })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential model-session tasks; {previous} inserts the preceding final output" })),
	confirmSessionAttach: Type.Optional(Type.Boolean({
		default: true,
		description: "Confirm before forking or exclusively opening an existing session",
	})),
});

export interface StatefulSubagentRunDetails extends SubagentTranscriptRun {
	agentId?: string;
	sessionId?: string;
	task: string;
	usage: SubagentUsage;
	durationMs: number;
}

export interface StatefulSubagentDetails {
	mode: "single" | "parallel" | "chain" | "control";
	results: StatefulSubagentRunDetails[];
	durationMs: number;
}

export interface StatefulSubagentToolOptions {
	team?: () => TeamRunManager;
	broker: SessionBroker | (() => SessionBroker);
	readonly knownFastMode?: (target: string) => boolean | undefined;
	readonly knownModel?: (target: string) => RailModelRef | undefined;
	readonly renderContext?: () => Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels" | "thinkingLevel"> | undefined;
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

type TaskParams = Static<typeof TaskItem>;

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
	const contextWindow = normalizeContextWindow(item.contextWindow);
	return {
		...(model ? { model } : {}),
		...(target ? { target } : {}),
		...(alias ? { alias } : {}),
		task: item.task,
		...(cwd ? { cwd } : {}),
		...(item.session && sessionPath ? { session: { mode: item.session.mode, path: sessionPath } } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(item.fastMode !== undefined ? { fastMode: item.fastMode } : {}),
	};
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

function compactPersistentResult(result: DispatchResult, task: string, durationMs: number, step?: number): StatefulSubagentRunDetails {
	return {
		agentId: result.instance.agentId,
		alias: result.instance.alias,
		model: railModelReference(result.instance.model),
		sessionId: result.instance.sessionId,
		task,
		status: runErrorMessage(result.run) ? "failed" : "completed",
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
		status: run.exitCode !== 0 || runErrorMessage(run) ? "failed" : "completed",
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
	const { isCompacting: _isCompacting, ...previousRun } = previous ?? {};
	return {
		...previousRun,
		alias: previous?.alias ?? item.target ?? item.alias ?? item.model ?? "current-model",
		...(previous?.model ? { model: previous.model } : item.model ? { model: item.model } : {}),
		task: item.task,
		status: "failed",
		output: truncateParentContent(message),
		transcript: appendSubagentTranscriptFailure(previous?.transcript, item.task, message),
		usage: previous?.usage ?? emptySubagentUsage(),
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
	if (params.teamId != null && (mode === "chain" || mode === "control" || params.chain !== undefined || params.control !== undefined || params.target !== undefined || params.session !== undefined
		|| params.tasks?.some((item) => item.target !== undefined || item.session !== undefined))) throw new Error("Team does not support target/session/chain/control");
	if (mode !== "single" && normalizeContextWindow(params.contextWindow) !== undefined) {
		throw new Error("contextWindow is only supported on the single task or on each parallel/chain item");
	}
	const confirmSessionAttach = {
		...(typeof params.confirmSessionAttach === "boolean" ? { confirmSessionAttach: params.confirmSessionAttach } : {}),
		...(params.teamId !== undefined ? { teamId: params.teamId } : {}),
	};
	if (mode === "parallel") {
		if ((params.fastMode !== undefined && params.fastMode !== null) || params.tasks!.some((item) => item.fastMode !== undefined && item.fastMode !== null)) {
			throw new Error("fastMode is not supported on grouped dispatch; use separate stateless calls or /rail-agent");
		}
		return { tasks: params.tasks!.map(normalizeTask), ...confirmSessionAttach };
	}
	if (mode === "chain") {
		if ((params.fastMode !== undefined && params.fastMode !== null) || params.chain!.some((item) => item.fastMode !== undefined && item.fastMode !== null)) {
			throw new Error("fastMode is not supported on grouped dispatch; use separate stateless calls or /rail-agent");
		}
		return { chain: params.chain!.map(normalizeTask), ...confirmSessionAttach };
	}
	if (mode === "control") {
		if (params.fastMode !== undefined && params.fastMode !== null) throw new Error("fastMode is not supported on control; manage persistent policy through /rail-agent");
		const target = nonEmpty(params.target);
		const message = nonEmpty(params.control?.message);
		return {
			...(target ? { target } : {}),
			...(params.control && message ? { control: { delivery: params.control.delivery, message } } : {}),
		};
	}
	const normalized = normalizeTask({ ...params, task: params.task! });
	if (normalized.target && normalized.fastMode !== undefined && normalized.fastMode !== null) {
		throw new Error("fastMode for an existing target is managed through /rail-agent");
	}
	return { ...normalized, ...confirmSessionAttach };
}

type RenderModelContext = Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels" | "thinkingLevel">;

function nativeModelForRailRef(model: RailModelRef, ctx: RenderModelContext): NativeFastModel | undefined {
	if (ctx.model?.provider === model.provider && ctx.model.id === model.modelId) return ctx.model;
	return ctx.modelRegistry.find(model.provider, model.modelId)
		?? ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === model.provider && candidate.id === model.modelId);
}

function modelForFastMode(
	item: TaskParams,
	ctx: RenderModelContext,
): NativeFastModel | undefined {
	if (!item.model) return ctx.model;
	return nativeModelForRailRef(resolveRailModel(item.model, ctx), ctx);
}

// Validate and normalize in both preflight and dispatch, so an ignored value
// cannot become a saved Fast policy when a non-GPT agent later changes models.
function effectiveFastModeRequest(
	item: TaskParams,
	model: NativeFastModel | undefined,
): boolean | undefined {
	if (item.fastMode === false) return false;
	if (item.fastMode !== true || !isGptModel(model)) return undefined;
	if (!supportsNativeFastMode(model)) {
		throw new Error("fastMode requires a GPT model using a supported native OpenAI API");
	}
	return true;
}

type FastModeDisplay = "on" | "off";
type SearchModeDisplay = "on" | "off";

interface DispatchDisplayMetadata {
	contextWindowText: string;
	fastModeText: FastModeDisplay;
	searchModeText: SearchModeDisplay;
}

function effectiveFastModeText(policy: boolean | undefined, model: NativeFastModel | undefined): FastModeDisplay {
	return policy === true && supportsNativeGptFastMode(model) ? "on" : "off";
}

function effectiveSearchModeText(model: NativeFastModel | undefined): SearchModeDisplay {
	return supportsNativeGptSearch(model) ? "on" : "off";
}

function resolveDisplayModel(reference: string, ctx: RenderModelContext): NativeFastModel | undefined {
	try {
		return nativeModelForRailRef(resolveRailModel(reference, ctx), ctx);
	} catch {
		return undefined;
	}
}

interface DisplayModelSources {
	knownModel?: ((target: string) => RailModelRef | undefined) | undefined;
	knownFastMode?: ((target: string) => boolean | undefined) | undefined;
	renderContext?: (() => RenderModelContext | undefined) | undefined;
}

function displayModelForSlot(
	item: TaskParams | undefined,
	resultModel: string | undefined,
	sources: DisplayModelSources,
	ctx = sources.renderContext?.(),
): NativeFastModel | undefined {
	if (!ctx) return undefined;
	if (item?.target) {
		const known = sources.knownModel?.(item.target.trim());
		const knownModel = known ? nativeModelForRailRef(known, ctx) : undefined;
		if (knownModel) return knownModel;
		return resultModel ? resolveDisplayModel(resultModel, ctx) : undefined;
	}
	if (item?.model) return resolveDisplayModel(item.model, ctx);
	if (resultModel) return resolveDisplayModel(resultModel, ctx);
	return ctx.model;
}

/**
 * Display metadata is cached per dispatch slot, and restored run arrays may be
 * sparse or out of slot order, so result models must be indexed by run.slot
 * rather than array position.
 */
function resultModelsBySlot(results: readonly StatefulSubagentRunDetails[]): Array<string | undefined> {
	const models: Array<string | undefined> = [];
	results.forEach((run, index) => {
		models[run.slot ?? index] = run.model;
	});
	return models;
}

function initialTasksForRender(
	args: SubagentParamsValue | undefined,
	mode: "single" | "parallel" | "chain" | "control" | undefined,
	resultCount: number,
	actualTasks?: ReadonlyMap<number, string>,
	fallbackTasks?: readonly (string | undefined)[],
): Array<string | undefined> {
	const renderMode = mode
		?? (args?.chain?.length ? "chain" : args?.tasks?.length ? "parallel" : args?.control?.message ? "control" : "single");
	const rawItems: TaskParams[] = renderMode === "chain"
		? (args?.chain ?? []) as TaskParams[]
		: renderMode === "parallel"
			? (args?.tasks ?? []) as TaskParams[]
			: args?.task !== undefined ? [{ ...args, task: args.task } as TaskParams] : [];
	if (renderMode === "control") return [];
	const count = Math.max(resultCount, rawItems.length, actualTasks?.size ?? 0);
	return Array.from({ length: count }, (_, index) => {
		const actual = actualTasks?.get(index);
		if (actual !== undefined) return actual;
		const raw = rawItems[index]?.task;
		const fallback = fallbackTasks?.[index];
		if (renderMode === "chain" && raw?.includes("{previous}")) {
			return fallback !== undefined && fallback !== raw ? fallback : undefined;
		}
		return raw ?? fallback;
	});
}

function formatContextWindowForDisplay(value: number | null | undefined): string {
	if (value === undefined || value === null) return "Default";
	if (!Number.isSafeInteger(value) || value <= 0) return String(value);
	const thousands = Math.floor(value / 1000);
	const remainder = value % 1000;
	if (remainder === 0) return `${thousands}K`;
	const fraction = String(remainder).padStart(3, "0").replace(/0+$/u, "");
	return `${thousands}.${fraction}K`;
}

function renderModeForArgs(args: SubagentParamsValue | undefined): "single" | "parallel" | "chain" | "control" {
	if (args?.control?.message) return "control";
	if (args?.chain?.length) return "chain";
	if (args?.tasks?.length) return "parallel";
	return "single";
}

function renderItemsForMode(
	args: SubagentParamsValue | undefined,
	mode: "single" | "parallel" | "chain" | "control",
): TaskParams[] {
	if (mode === "chain") return (args?.chain ?? []) as TaskParams[];
	if (mode === "parallel") return (args?.tasks ?? []) as TaskParams[];
	if (mode === "single" && args?.task !== undefined) return [{ ...args, task: args.task } as TaskParams];
	return [];
}

function dispatchMetadataText(metadata: readonly DispatchDisplayMetadata[], grouped: boolean): string {
	const firstContextWindow = metadata[0]?.contextWindowText ?? "Default";
	const sameContextWindow = metadata.every((item) => item.contextWindowText === firstContextWindow);
	const contextWindow = grouped && !sameContextWindow
		? `ContextWindow ${metadata.map((item, index) => `${index + 1}=${item.contextWindowText}`).join(", ")}`
		: `ContextWindow ${firstContextWindow}`;
	const firstFastMode = metadata[0]?.fastModeText ?? "off";
	const sameFastMode = metadata.every((item) => item.fastModeText === firstFastMode);
	const fast = grouped && !sameFastMode
		? metadata.map((item, index) => `${index + 1}=${item.fastModeText}`).join(", ")
		: firstFastMode;
	const firstSearchMode = metadata[0]?.searchModeText ?? "off";
	const sameSearchMode = metadata.every((item) => item.searchModeText === firstSearchMode);
	const search = grouped && !sameSearchMode
		? metadata.map((item, index) => `${index + 1}=${item.searchModeText}`).join(", ")
		: firstSearchMode;
	return `${contextWindow} · FAST ${fast} · SEARCH ${search}`;
}

function dispatchMetadataForRender(
	args: SubagentParamsValue | undefined,
	mode: "single" | "parallel" | "chain" | "control" | undefined,
	count: number,
	cached: ReadonlyMap<number, DispatchDisplayMetadata> | undefined,
	sources: DisplayModelSources,
	resultModels?: readonly (string | undefined)[],
): DispatchDisplayMetadata[] {
	const renderMode = mode ?? renderModeForArgs(args);
	if (renderMode === "control") return [];
	const items = renderItemsForMode(args, renderMode);
	const total = Math.max(count, items.length, cached?.size ?? 0, resultModels?.length ?? 0, 1);
	return Array.from({ length: total }, (_, index) => {
		const cachedMetadata = cached?.get(index);
		if (cachedMetadata) return cachedMetadata;
		const item = items[index];
		const model = displayModelForSlot(item, resultModels?.[index], sources);
		const fastModePolicy = item?.target
			? sources.knownFastMode?.(item.target.trim())
			: item?.fastMode === true;
		return {
			contextWindowText: formatContextWindowForDisplay(item?.contextWindow),
			fastModeText: effectiveFastModeText(fastModePolicy, model),
			searchModeText: effectiveSearchModeText(model),
		};
	});
}

class SingleLineText implements Component {
	constructor(private readonly value: string | (() => string)) {}

	render(width: number): string[] {
		const value = typeof this.value === "function" ? this.value() : this.value;
		return [truncateToWidth(value, Math.max(1, width), "", true)];
	}

	invalidate(): void {}
}

async function validateTaskContextWindows(items: TaskParams[], broker: SessionBroker | undefined, defaultCwd: string): Promise<void> {
	for (const item of items) {
		const contextWindow = normalizeContextWindow(item.contextWindow);
		if (contextWindow === undefined) continue;
		if (item.target) {
			if (!broker) throw new Error("A broker is required to validate a targeted contextWindow");
			await broker.validateContextWindowForTarget(item.target, contextWindow);
			continue;
		}
		const settings = SettingsManager.create(item.cwd ?? defaultCwd, getAgentDir()).getCompactionSettings();
		validateContextWindowReserve(contextWindow, settings.reserveTokens, settings.enabled);
	}
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
	const actualTasksByCall = new Map<string, Map<number, string>>();
	const actualTasksByDetails = new WeakMap<StatefulSubagentDetails, Map<number, string>>();
	const dispatchMetadataByCall = new Map<string, Map<number, DispatchDisplayMetadata>>();
	const dispatchMetadataByDetails = new WeakMap<StatefulSubagentDetails, Map<number, DispatchDisplayMetadata>>();
	const callHeaderInvalidators = new Map<string, () => void>();
	const eventApi = pi as Partial<Pick<ExtensionAPI, "on">>;
	eventApi.on?.("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		const details = latestDetails.get(event.toolCallId);
		latestDetails.delete(event.toolCallId);
		actualTasksByCall.delete(event.toolCallId);
		dispatchMetadataByCall.delete(event.toolCallId);
		callHeaderInvalidators.delete(event.toolCallId);
		if (event.isError && details) return { details };
		return undefined;
	});
	const knownFastModeForRender = (target: string): boolean | undefined => {
		return options.knownFastMode?.(target.trim());
	};
	const knownModelForRender = (target: string): RailModelRef | undefined => {
		return options.knownModel?.(target.trim());
	};
	const displaySources: DisplayModelSources = {
		knownFastMode: knownFastModeForRender,
		knownModel: knownModelForRender,
		renderContext: options.renderContext,
	};
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate work to Pi model sessions. Use exactly one mode: single, parallel, chain, or control.\n"
			+ "Context budget rule: Set contextWindow to null by default. Null or omission uses the selected child model's native default. Only use a positive safe integer when the user explicitly requests a specific child context or compaction budget. Top-level numeric contextWindow is only for single mode; each tasks or chain item owns its own numeric contextWindow. A top-level null is tolerated in grouped/control calls as the default sentinel. Explicit single example: {\"task\":\"work\",\"contextWindow\":64000}. Explicit grouped example: {\"tasks\":[{\"task\":\"A\",\"contextWindow\":64000},{\"task\":\"B\",\"contextWindow\":128000}]}.\n"
			+ "1. single: dispatch one task. Lifecycle options:\n"
			+ "   - stateless (one-off, no saved JSONL): {\"model\":\"provider/model:thinking\",\"task\":\"one-off work\",\"contextWindow\":null} (omit model to use current model)\n"
			+ "   - new persistent (expected follow-ups): {\"model\":\"provider/model:thinking\",\"alias\":\"worker\",\"task\":\"initial work\",\"contextWindow\":null}\n"
			+ "   - continue linked helper: {\"target\":\"worker\",\"task\":\"follow-up\",\"contextWindow\":null} (do not provide model)\n"
			+ "   - adopt existing saved session: {\"session\":{\"mode\":\"fork\",\"path\":\"/path/to/session.jsonl\"},\"task\":\"continue work\",\"contextWindow\":null} (use fork unless the user explicitly requests exclusive ownership)\n"
			+ "2. parallel: group independent tasks into one parent Tool Call panel: {\"tasks\":[{\"task\":\"A\",\"contextWindow\":null},{\"model\":\"provider/model\",\"alias\":\"worker\",\"task\":\"B\",\"contextWindow\":null}]}. For independent work that should appear as separate top-level Tool Call panels, emit multiple sibling subagent calls in the same assistant turn and do not use tasks; Pi executes sibling calls concurrently.\n"
			+ "3. chain: sequential pipeline where {previous} inserts the preceding final output: {\"chain\":[{\"task\":\"plan\",\"contextWindow\":null},{\"target\":\"worker\",\"task\":\"implement {previous}\",\"contextWindow\":null}]}.\n"
			+ "4. control: steer or queue follow-up for an already-running local persistent helper: {\"target\":\"worker\",\"control\":{\"delivery\":\"steer\",\"message\":\"redirect now\"}}. Controls apply only to active persistent targets; do not include task, model, alias, session, tasks, or chain. contextWindow must be null or omitted, never numeric, and control must never be issued as a sibling of the dispatch it intends to control.\n"
			+ "Fast mode: set fastMode:true only for a stateless call or the initial creation of a new persistent agent. On a non-GPT model the value is silently ignored and the call runs with Fast off. GPT models retain the supported native OpenAI API requirement. This ignore rule applies only to legal parameter positions; target, grouped, and control calls still cannot set fastMode. fastMode:false keeps that new call or agent off; null or omission means off. Existing target policy is stored in its descriptor and changed only through /rail-agent. Native hosted search is an internal live policy for eligible GPT children; there is no search parameter. Non-GPT dispatch headers and grouped child panels always show FAST off · SEARCH off.\n"
			+ "Child sessions cannot recursively call subagent. Persistent agents can be permanently deleted from /rail-agent.",
		promptSnippet: "Delegate self-contained work to stateless Pi model sessions, or create and continue persistent model sessions",
		executionMode: "parallel",
		promptGuidelines: [
			"Choose the subagent lifecycle by continuity: use target for an already linked persistent helper; use session in fork mode to adopt an existing saved Pi session whose history or project context matters; use model+alias+task for a new long-term helper expected to receive follow-ups; otherwise use model+task as stateless one-off work.",
			"For an existing linked subagent, continue with target+task and no model. Reuse the exact alias so the same child conversation memory, session, and working context continue.",
			"When adopting an existing saved Pi session, use session mode fork by default so the original remains untouched. This is appropriate for continuing prior work or modifying another repository; preserve that session's project cwd when known. Use exclusive only with explicit user intent and no other writer.",
			"Create a new persistent subagent only when future follow-ups need the same child context. The first model+alias call must include a concrete initial task; do not create an empty, idle, or placeholder persistent session. One model can back many aliases with independent histories.",
			"For stateless subagent work, call subagent with task, optional model, and contextWindow:null by default. Omit alias, target, and session. Use it proactively for bounded code search, focused analysis, verification, comparison, or review, and make the task self-contained because no state persists. Stateless runs create no child JSONL and never appear in /resume.",
			"In subagent calls, omit model to use the current Pi model. Select an explicit model only when the delegated task benefits from a different model or thinking level.",
			"Use contextWindow:null by default. Null or omission uses the selected child model's native default. Only use a positive integer when the user explicitly requests a specific child context or compaction budget; for parallel and chain calls, put an explicit numeric value on the individual item that owns it.",
			"Use fastMode:true only for a stateless call or a new persistent agent. On a non-GPT model it is silently ignored and the call runs with Fast off. GPT models retain the supported native OpenAI API requirement. Keep fastMode null or omitted by default. Existing persistent target policy is managed through /rail-agent; do not put fastMode on target, grouped, or control calls. Hosted Search is an internal policy with no search parameter; non-GPT dispatch headers and grouped child panels always show FAST off · SEARCH off.",
			"For independent parallel work that should have separate top-level Tool Call panels, emit multiple sibling subagent calls in the same assistant turn. Give each call exactly one single-mode task using model+task, target+task, or model+alias+task as appropriate; do not put those tasks in one tasks array. Pi preflights sibling calls in order and executes them concurrently.",
			"Use the tasks array only when the user wants one grouped subagent Tool Call with multiple child panels. Use chain only when each step depends on the previous result, inserting {previous} where the prior final output is needed.",
			"Live controls apply only to an already-running local persistent subagent. Use target+control with delivery=steer to redirect it before its next model call, or delivery=followUp to queue work after its current run. Do not include task, model, alias, session, tasks, or chain in a control call; contextWindow must be null or omitted, never numeric. Do not issue a control as a sibling of the initial dispatch because startup and preflight can race. A parent LLM normally cannot call control while its own subagent Tool Call is pending, so the practical interactive path is /rail-agent and the Tool control mode is primarily for host-side or external orchestration.",
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
			const teamId = params.teamId ?? undefined;
			const team = teamId !== undefined ? options.team?.() : undefined;
			let teamScope: ReturnType<typeof teamCallSignal> | undefined;
			let unsubscribeTeam: (() => void) | undefined;
			let joinedTeam = false;
			try {
			if (teamId !== undefined && !team) throw new Error("Team runtime is not ready");
			const mode = modeFor(params);
			params = filterParamsForMode(params, mode);
			const actualTasks = new Map<number, string>();
			actualTasksByCall.set(toolCallId, actualTasks);
			const dispatchMetadata = new Map<number, DispatchDisplayMetadata>();
			dispatchMetadataByCall.set(toolCallId, dispatchMetadata);
			const liveResults = new Map<number, StatefulSubagentRunDetails>();
			const runStartedAt = new Map<number, number>();
			const runDuration = (slot: number) => Math.max(0, Math.round(performance.now() - (runStartedAt.get(slot) ?? performance.now())));
			const setDispatchMetadata = (
				item: TaskParams,
				slot: number,
				actual?: { model: RailModelRef; fastMode: boolean | undefined },
			) => {
				const model = actual
					? nativeModelForRailRef(actual.model, ctx)
					: displayModelForSlot(item, undefined, displaySources, ctx);
				const fastModePolicy = actual
					? actual.fastMode
					: item.target
						? knownFastModeForRender(item.target)
						: item.fastMode === true;
				const metadata: DispatchDisplayMetadata = {
					contextWindowText: formatContextWindowForDisplay(item.contextWindow),
					fastModeText: effectiveFastModeText(fastModePolicy, model),
					searchModeText: effectiveSearchModeText(model),
				};
				dispatchMetadata.set(slot, metadata);
				callHeaderInvalidators.get(toolCallId)?.();
			};
			const resultDetails = (results: StatefulSubagentRunDetails[]): StatefulSubagentDetails => {
				if (team && teamId !== undefined) {
					const members = new Map(team.hub.get(teamId).members.map((member) => [member.id, member]));
					results = results.map((result) => {
						const member = members.get(result.alias);
						return member ? { ...result, coordination: { state: member.state, ...(member.waitingFor !== undefined ? { waitingFor: member.waitingFor } : {}) } } : result;
					});
				}
				const details: StatefulSubagentDetails = {
					mode,
					results: boundDetailOutputs(boundSubagentRunTranscripts(results)),
					durationMs: Math.max(0, Math.round(performance.now() - toolStartedAt)),
				};
				actualTasksByDetails.set(details, actualTasks);
				dispatchMetadataByDetails.set(details, dispatchMetadata);
				return details;
			};
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
						usage: emptySubagentUsage(),
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
			const orderedLiveResults = () => [...liveResults.entries()]
				.sort(([left], [right]) => left - right)
				.map(([slot, item]) => ({ ...item, slot }));
			const publishLive = (slot: number, result: StatefulSubagentRunDetails) => {
				liveResults.set(slot, result);
				const details = resultDetails(orderedLiveResults());
				latestDetails.set(toolCallId, details);
				onUpdate?.({
					content: [{ type: "text", text: truncateParentContent(result.output || "(running...)") + (team && teamId ? `\n${teamStatus(team.hub.get(teamId))}` : "") }],
					details,
				});
			};
			const requestedItems: TaskParams[] = mode === "single"
				? [{ ...params, task: params.task! } as TaskParams]
				: (mode === "parallel" ? params.tasks! : params.chain!) as TaskParams[];
			requestedItems.forEach((item, index) => setDispatchMetadata(item, index));
			if (mode === "parallel" && requestedItems.length > MAX_PARALLEL_TASKS) {
				throw new Error(`Too many parallel tasks (${requestedItems.length}); max is ${MAX_PARALLEL_TASKS}`);
			}
			if (mode === "chain" && requestedItems.length > MAX_CHAIN_TASKS) {
				throw new Error(`Too many chain tasks (${requestedItems.length}); max is ${MAX_CHAIN_TASKS}`);
			}
			for (const item of requestedItems) {
				if (team) resolveRailModel(item.model, ctx);
				if (item.fastMode === true) effectiveFastModeRequest(item, modelForFastMode(item, ctx));
			}
			const contextTargetItems = requestedItems.filter((item) => item.target && item.contextWindow != null);
			const broker = contextTargetItems.length > 0
				? (typeof options.broker === "function" ? options.broker() : options.broker)
				: undefined;
			await validateTaskContextWindows(requestedItems, broker, ctx.cwd);
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
			const bindings = team && teamId !== undefined ? team.join(teamId, mode, requestedItems) : undefined;
			joinedTeam = bindings !== undefined;
			if (team && teamId !== undefined) {
				teamScope = teamCallSignal(team.hub, teamId, signal);
				signal = teamScope.signal;
				unsubscribeTeam = team.hub.subscribe((snapshot) => {
					if (snapshot.id !== teamId) return;
					const details = resultDetails(orderedLiveResults());
					latestDetails.set(toolCallId, details);
					onUpdate?.({ content: [{ type: "text", text: teamStatus(snapshot) }], details });
				});
			}
			toolStartedAt = performance.now();

			const dispatch = async (item: TaskParams, slot: number, step?: number): Promise<StatefulSubagentRunDetails> => {
				actualTasks.set(slot, item.task);
				runStartedAt.set(slot, performance.now());
				const duration = () => runDuration(slot);
				if (signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
				if (item.target && item.model) throw new Error("A follow-up target cannot also select a model");
				const persistent = isPersistentTask(item);
				if (!persistent) {
					if (!options.runStateless) throw new Error("Stateless model-session runner is not configured");
					const model = resolveRailModel(item.model, ctx);
					const fastMode = effectiveFastModeRequest(item, nativeModelForRailRef(model, ctx));
					setDispatchMetadata(item, slot, { model, fastMode });
					const alias = mode === "single" ? railModelKey(model) : `${railModelKey(model)} #${slot + 1}`;
					publishLive(slot, {
						alias,
						model: railModelReference(model),
						task: item.task,
						status: "running",
						output: "(starting...)",
						usage: emptySubagentUsage(),
						durationMs: duration(),
						...(step !== undefined ? { step } : {}),
						persistent: false,
					});
					const run = await options.runStateless({
						model,
						task: item.task,
						cwd: item.cwd ?? ctx.cwd,
						...(item.contextWindow != null ? { contextWindow: item.contextWindow } : {}),
						...(fastMode !== undefined ? { fastMode } : {}),
						...(signal ? { signal } : {}),
						onUpdate: (partial) => publishLive(slot, {
							alias,
							model: railModelReference(model),
							task: item.task,
							status: "running",
							output: partial.output,
							...(partial.transcript ? { transcript: partial.transcript } : {}),
							...(partial.isCompacting ? { isCompacting: true } : {}),
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
				const fastMode = effectiveFastModeRequest(item, model ? nativeModelForRailRef(model, ctx) : undefined);
				const request: DispatchRequest = {
					...(team && bindings?.[slot] ? { team: team.channel(bindings[slot]!) } : {}),
					...(model ? { model } : {}),
					...(item.target ? { target: item.target } : {}),
					...(item.alias ? { alias: item.alias } : {}),
					task: item.task,
					...(item.cwd ? { cwd: item.cwd } : {}),
					...(item.session ? { session: item.session } : {}),
					...(item.contextWindow != null ? { contextWindow: item.contextWindow } : {}),
					...(fastMode !== undefined ? { fastMode } : {}),
					...(signal ? { signal } : {}),
					onUpdate: ({ instance, run: partial }) => {
						setDispatchMetadata(item, slot, { model: instance.model, fastMode: instance.fastMode === true });
						publishLive(slot, {
							agentId: instance.agentId,
							alias: instance.alias,
							model: railModelReference(instance.model),
							sessionId: instance.sessionId,
							task: item.task,
							status: "running",
							output: partial.output,
							...(partial.transcript ? { transcript: partial.transcript } : {}),
							...(partial.isCompacting ? { isCompacting: true } : {}),
							usage: partial.usage,
							durationMs: duration(),
							...(step !== undefined ? { step } : {}),
							persistent: true,
						});
					},
				};
				const broker = typeof options.broker === "function" ? options.broker() : options.broker;
				const dispatched = await broker.dispatch(request);
				setDispatchMetadata(item, slot, { model: dispatched.instance.model, fastMode: dispatched.instance.fastMode === true });
				const result = compactPersistentResult(dispatched, item.task, duration(), step);
				publishLive(slot, result);
				return result;
			};

			const runTask = async (item: TaskParams, slot: number, step?: number): Promise<StatefulSubagentRunDetails> => {
				try {
					return await dispatch(item, slot, step);
				} catch (error) {
					if (team && bindings?.[slot]) team.fail(bindings[slot]!, error, signal?.aborted);
					const result = errorResult(item, error, runDuration(slot), signal?.aborted ?? false, step, liveResults.get(slot));
					publishLive(slot, result);
					return result;
				}
			};

			if (mode === "single") {
				const result = await runTask(requestedItems[0]!, 0);
				if (result.status === "failed") throw new Error(finalText(result));
				const details = resultDetails([result]);
				latestDetails.set(toolCallId, details);
				return { content: [{ type: "text", text: finalText(result) }], details };
			}
			if (mode === "parallel") {
				let results: StatefulSubagentRunDetails[];
				if (bindings) {
					// Even an unexpected progress/finalization failure must not release the
					// grouped call while another member is starting or cleaning its lease.
					const settled = await Promise.allSettled(requestedItems.map((item, index) => runTask(item, index)));
					results = settled.map((result) => { if (result.status === "rejected") throw result.reason; return result.value; });
				} else results = await mapWithConcurrency(requestedItems, MAX_CONCURRENCY, (item, index) => runTask(item, index));
				const details = resultDetails(results);
				latestDetails.set(toolCallId, details);
				return { content: [{ type: "text", text: aggregateText(mode, results) }], details };
			}
			const results: StatefulSubagentRunDetails[] = [];
			let previous = "";
			for (let index = 0; index < requestedItems.length; index++) {
				const raw = requestedItems[index]!;
				const item = { ...raw, task: raw.task.replaceAll("{previous}", previous) };
				const result = await runTask(item, index, index + 1);
				results.push(result);
				if (result.status === "failed") break;
				previous = result.output;
			}
			const details = resultDetails(results);
			latestDetails.set(toolCallId, details);
			return { content: [{ type: "text", text: aggregateText(mode, results) }], details };
			} catch (error) {
				if (joinedTeam && team && teamId !== undefined) {
					try { team.hub.cancel(teamId, error instanceof Error ? error.message : String(error)); }
					catch { /* An unknown team must not replace the original validation error. */ }
				}
				throw error;
			} finally { unsubscribeTeam?.(); teamScope?.dispose(); }
		},

		renderCall(args, theme, context) {
			const controlMessage = nonEmpty(args.control?.message);
			const alias = nonEmpty(args.alias);
			const model = nonEmpty(args.model);
			const persistentIdentity = alias ?? model ?? "current model";
			const persistentModel = alias && model ? ` · ${model}` : "";
			const modeText = controlMessage
				? `${args.control!.delivery === "followUp" ? "follow-up" : "steer"} · ${nonEmpty(args.target) ?? "target required"}`
				: args.chain?.length
				? `chain · ${args.chain.length}`
				: args.tasks?.length
					? `parallel · ${args.tasks.length}`
					: nonEmpty(args.target)
						? `continue · ${args.target!.trim()}`
						: alias || nonEmpty(args.session?.path)
							? `${args.session?.path ? `adopt ${args.session.mode}` : "new"} · ${persistentIdentity}${persistentModel}`
							: `stateless · ${args.model || "current model"}`;
			const renderMode = renderModeForArgs(args);
			const grouped = renderMode === "parallel" || renderMode === "chain";
			if (context?.toolCallId) {
				if (context.isPartial && context.executionStarted) callHeaderInvalidators.set(context.toolCallId, context.invalidate);
				else callHeaderInvalidators.delete(context.toolCallId);
			}
			return new SingleLineText(() => {
				const dispatchMetadata = controlMessage
					? []
					: dispatchMetadataForRender(
						args,
						renderMode,
						grouped ? Math.max(args.tasks?.length ?? 0, args.chain?.length ?? 0) : 1,
						context?.toolCallId ? dispatchMetadataByCall.get(context.toolCallId) : undefined,
						displaySources,
					);
				const metadata = dispatchMetadata.length > 0
					? theme.fg("dim", ` · ${dispatchMetadataText(dispatchMetadata, grouped)}`)
					: "";
				return `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", modeText)}${metadata}`;
			});
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (context?.toolCallId && !isPartial) callHeaderInvalidators.delete(context.toolCallId);
			const details = result.details as StatefulSubagentDetails | undefined;
			if (!details?.results.length) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			const isControl = details.mode === "control" || Boolean(context?.args?.control?.message);
			const actualTasks = (context?.toolCallId ? actualTasksByCall.get(context.toolCallId) : undefined)
				?? actualTasksByDetails.get(details);
			const dispatchMetadata = isControl ? [] : dispatchMetadataForRender(
				context?.args,
				details.mode,
				details.results.length,
				(context?.toolCallId ? dispatchMetadataByCall.get(context.toolCallId) : undefined) ?? dispatchMetadataByDetails.get(details),
				displaySources,
				resultModelsBySlot(details.results),
			);
			const fallbackTasks = details.results.map((run) => run.transcript?.entries.some((entry) => entry.initial)
				? undefined
				: run.task);
			return renderSubagentTranscript(details.results, expanded, theme, {
				isPartial,
				durationMs: details.durationMs,
				initialTasks: initialTasksForRender(context?.args, details.mode, details.results.length, actualTasks, fallbackTasks),
				mode: details.mode,
				...(isControl ? { control: true } : {}),
				...(details.mode === "chain" ? { sequenceTotal: context?.args?.chain?.length ?? details.results.length } : {}),
				...(dispatchMetadata.length > 0 ? {
					contextWindows: dispatchMetadata.map((item) => item.contextWindowText),
					fastModes: dispatchMetadata.map((item) => item.fastModeText),
					searchModes: dispatchMetadata.map((item) => item.searchModeText),
				} : {}),
				markdownTheme: options.getMarkdownTheme?.() ?? markdownThemeFromTheme(theme),
			});
		},
	});
}
