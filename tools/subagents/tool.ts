import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import {
	type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext, type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, type MarkdownTheme, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createChildContextSettings, normalizeContextWindow, resolveChildContextCwd, validateContextWindowReserve } from "./context-window";
import { supportsNativeFastMode, supportsNativeGptFastMode, type NativeFastModel } from "../../commands/rail-fast";
import { supportsNativeGptSearch } from "../../commands/rail-oai-search";
import { prompt, promptList } from "../../core/prompts";
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
import { fairShares } from "./text-budget";
import { emptySubagentUsage } from "./usage";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_TASKS = 8;
const MAX_CONCURRENCY = 4;
const OUTPUT_CAP = 50 * 1024;
const DETAILS_TOTAL_CAP = 512 * 1024;

const SessionSourceSchema = Type.Object({
	mode: StringEnum(["fork", "exclusive"] as const, {
		description: "fork (default) continues in a copy and leaves the original file untouched; exclusive takes over the original, only when the user explicitly asks and no other Pi process has it open",
	}),
	path: Type.String({ description: "Path of the saved Pi session .jsonl file to continue" }),
});

const ControlSchema = Type.Object({
	delivery: StringEnum(["steer", "followUp"] as const, {
		description: "steer: deliver before the helper's next model call (redirect now). followUp: queue until its current run finishes",
	}),
	message: Type.String({ description: "Message for the running persistent helper" }),
});

// Providers that fill every property need a real no-op value for these objects;
// otherwise they invent placeholders such as {"path":"/nonexistent"} or {"message":"start"}.
function sessionSourceSchema() {
	return Type.Optional(Type.Union([SessionSourceSchema, Type.Null()], {
		description: "Only to continue a saved Pi session file named by the user. Otherwise omit it (or null); never a placeholder path.",
	}));
}

function contextWindowSchema() {
	return Type.Optional(Type.Union([
		Type.Number(),
		Type.Null(),
	], {
		default: null,
		description: "Helper context budget in tokens. Omit it (or null) for the model's native default; a positive integer only when the user asks for a specific budget, using their exact number (64000 stays 64000). Never the string \"null\".",
	}));
}

function fastModeSchema() {
	return Type.Optional(Type.Union([
		Type.Boolean(),
		Type.Null(),
	], {
		default: null,
		description: "true only when the user asks for fast mode, on a one-off or new persistent helper. Ignored on a non-GPT model; a GPT model without native OpenAI fast mode is rejected. Not allowed with target (its policy is managed in /rail-agent). Omit (or null) for off.",
	}));
}

const TaskItem = Type.Object({
	model: Type.Optional(Type.String({ description: "Model as provider/id, optionally :thinking (e.g. openai/gpt-5.5:high). Omit to use the current model. Not with target." })),
	target: Type.Optional(Type.String({ description: "Alias of an existing persistent helper to continue; do not also set model or alias" })),
	alias: Type.Optional(Type.String({ description: "Name for a NEW persistent helper that keeps its history for later target calls; omit for one-off work" })),
	task: Type.String({ description: "Self-contained instructions: a one-off helper does not see this conversation" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new or adopted helper; defaults to the current directory" })),
	session: sessionSourceSchema(),
	contextWindow: contextWindowSchema(),
	fastMode: fastModeSchema(),
});

const ChainItem = Type.Object({
	model: Type.Optional(Type.String({ description: "Model as provider/id, optionally :thinking (e.g. openai/gpt-5.5:high). Omit to use the current model. Not with target." })),
	target: Type.Optional(Type.String({ description: "Alias of an existing persistent helper to continue; do not also set model or alias" })),
	alias: Type.Optional(Type.String({ description: "Name for a NEW persistent helper that keeps its history for later target calls; omit for one-off work" })),
	task: Type.String({ description: "Self-contained instructions: a one-off helper does not see this conversation. {previous} is replaced by the previous step's final answer." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new or adopted helper; defaults to the current directory" })),
	session: sessionSourceSchema(),
	contextWindow: contextWindowSchema(),
	fastMode: fastModeSchema(),
});

const SubagentParams = Type.Object({
	teamId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Retired. Omit or null; Teams run only through subagent_team." })),
	model: Type.Optional(Type.String({ description: "Model as provider/id, optionally :thinking (e.g. openai/gpt-5.5:high). Omit to use the current model. Not with target." })),
	target: Type.Optional(Type.String({ description: "Alias of an existing persistent helper to continue; do not also set model or alias" })),
	alias: Type.Optional(Type.String({ description: "Name for a NEW persistent helper that keeps its history for later target calls; omit for one-off work" })),
	task: Type.Optional(Type.String({ description: "SINGLE mode. Self-contained instructions: a one-off helper does not see this conversation. For target, the follow-up message." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new or adopted helper; defaults to the current directory" })),
	session: sessionSourceSchema(),
	contextWindow: contextWindowSchema(),
	fastMode: fastModeSchema(),
	control: Type.Optional(Type.Union([ControlSchema, Type.Null()], {
		description: "CONTROL mode only (with target, no task). Otherwise omit it (or null); any non-empty message makes the call a control.",
	})),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode: up to 8 independent helpers in one grouped panel; each item takes the single-mode fields. Leave top-level task empty." })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN mode: up to 8 steps run in order; {previous} in a step's task is replaced by the previous step's final answer. Leave top-level task empty." })),
	confirmSessionAttach: Type.Optional(Type.Boolean({
		default: true,
		description: "The tool itself shows a confirmation dialog before opening a saved session; leave the default. Do not ask the user yourself. false is honored only without a UI (headless).",
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
	broker: SessionBroker | (() => SessionBroker);
	readonly knownFastMode?: (target: string) => boolean | undefined;
	readonly knownModel?: (target: string) => RailModelRef | undefined;
	readonly renderContext?: () => Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels" | "thinkingLevel"> | undefined;
	runStateless?: StatelessAgentRunner;
	getMarkdownTheme?: () => MarkdownTheme;
}

export function markdownThemeFromTheme(theme: Theme): MarkdownTheme {
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
		const found = [
			hasSingle ? "single (task)" : undefined,
			hasParallel ? "parallel (tasks)" : undefined,
			hasChain ? "chain (chain)" : undefined,
			hasControl ? `control (control.message=${JSON.stringify(params.control!.message.slice(0, 80))})` : undefined,
		].filter((mode) => mode !== undefined);
		throw new Error(`Provide exactly one mode: single, parallel, chain, or control. This call sets ${found.length ? found.join(" + ") : "none of task, tasks, chain or control.message"}. `
			+ "Omit the fields of unused modes or set them to null (tasks/chain may also be []).");
	}
	return hasControl ? "control" : hasChain ? "chain" : hasParallel ? "parallel" : "single";
}

function validateFastModePlacement(item: TaskParams): void {
	if (item.target && item.fastMode !== undefined && item.fastMode !== null) {
		throw new Error("fastMode for an existing target is managed through /rail-agent");
	}
}

function filterParamsForMode(params: SubagentParamsValue, mode: SubagentMode): SubagentParamsValue {
	if (nonEmpty(params.teamId ?? undefined)) {
		throw new Error("subagent no longer starts Team members: teamId is retired. Run a Team with subagent_team prepare (members, lead, brief, initialRequests) and then launch with the returned teamId.");
	}
	if (mode !== "single" && normalizeContextWindow(params.contextWindow) !== undefined) {
		throw new Error("contextWindow is only supported on the single task or on each parallel/chain item");
	}
	const confirmSessionAttach = typeof params.confirmSessionAttach === "boolean" ? { confirmSessionAttach: params.confirmSessionAttach } : {};
	if (mode === "parallel") {
		if (params.fastMode !== undefined && params.fastMode !== null) {
			throw new Error("fastMode is only supported on the single task or on each parallel/chain item");
		}
		const tasks = params.tasks!.map(normalizeTask);
		tasks.forEach(validateFastModePlacement);
		return { tasks, ...confirmSessionAttach };
	}
	if (mode === "chain") {
		if (params.fastMode !== undefined && params.fastMode !== null) {
			throw new Error("fastMode is only supported on the single task or on each parallel/chain item");
		}
		const chain = params.chain!.map(normalizeTask);
		chain.forEach(validateFastModePlacement);
		return { chain, ...confirmSessionAttach };
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
	validateFastModePlacement(normalized);
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

export function formatContextWindowForDisplay(value: number | null | undefined): string {
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

async function validateTaskContextWindows(items: TaskParams[], models: (RailModelRef | undefined)[], broker: SessionBroker | undefined, defaultCwd: string): Promise<void> {
	for (const [index, item] of items.entries()) {
		const contextWindow = normalizeContextWindow(item.contextWindow);
		if (contextWindow === undefined) continue;
		if (item.target) {
			if (!broker) throw new Error("A broker is required to validate a targeted contextWindow");
			await broker.validateContextWindowForTarget(item.target, contextWindow);
			continue;
		}
		const model = models[index]!;
		const cwd = await resolveChildContextCwd(item.cwd ?? defaultCwd, item.session ?? undefined);
		const settings = createChildContextSettings(cwd).getCompactionSettings({ provider: model.provider, id: model.modelId });
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
	const headings = results.map((result) => `### ${result.alias} [${result.status}]\n\n`);
	const overhead = headings.reduce((sum, heading) => sum + Buffer.byteLength(heading, "utf8"), 0) + 7 * Math.max(0, results.length - 1);
	// Short answers stay complete; only the longest ones share what is left of the parent budget.
	const shares = fairShares(results.map((result) => Buffer.byteLength(result.output, "utf8")),
		Math.max(1024, OUTPUT_CAP - Buffer.byteLength(summary, "utf8") - 512 - overhead), 512);
	const outputs = results.map((result, index) => {
		const suffix = result.persistent && result.status === "completed"
			? `\n[answer truncated; the full answer remains in persistent session ${result.alias}]`
			: "\n[answer snippet truncated]";
		return `${headings[index]}${truncateUtf8(result.output, shares[index]!, suffix).value}`;
	}).join("\n\n---\n\n");
	return truncateParentContent(`${summary}\n\n${outputs}`);
}

function nestedToolUsage(results: readonly StatefulSubagentRunDetails[]): Usage | undefined {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let observed = false;
	for (const result of results) {
		const usage = result.usage;
		if (usage.turns > 0 || usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0 || usage.cost !== 0) observed = true;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
	}
	if (!observed) return undefined;
	return {
		input: total.input,
		output: total.output,
		cacheRead: total.cacheRead,
		cacheWrite: total.cacheWrite,
		totalTokens: total.input + total.output + total.cacheRead + total.cacheWrite,
		// SubagentUsage retains aggregate cost only; do not invent a provider breakdown.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: total.cost },
	};
}

/** A Team member's effective native policy, resolved once at prepare and pinned until launch. */
export interface ResolvedTeamMemberPolicy {
	model: RailModelRef;
	modelReference: string;
	cwd: string;
	fastMode: boolean;
	searchMode: SearchModeDisplay;
	nativeContextWindow: number;
	compactionReserveTokens: number;
	compactionEnabled: boolean;
	contextWindow?: number;
}

/**
 * Resolve a new Team member's model, cwd, effective Fast/Search and contextWindow with the same rules
 * as a new persistent subagent: the real model, a real directory, and a context reserve checked
 * against the child's project-trust-aware compaction settings. Nothing is started.
 */
export async function resolveTeamMemberPolicy(
	input: { model?: string; cwd?: string; fastMode?: boolean; contextWindow?: number },
	ctx: RenderModelContext & Pick<ExtensionContext, "cwd">,
): Promise<ResolvedTeamMemberPolicy> {
	const model = resolveRailModel(input.model, ctx);
	const native = nativeModelForRailRef(model, ctx);
	const fastRequest = effectiveFastModeRequest({ task: "", ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}) }, native);
	const cwd = resolvePath(ctx.cwd, input.cwd ?? ".");
	if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
	const contextWindow = normalizeContextWindow(input.contextWindow);
	if (input.contextWindow !== undefined && contextWindow === undefined) throw new Error("contextWindow must be a positive safe integer or null");
	const nativeContextWindow = native?.contextWindow;
	if (typeof nativeContextWindow !== "number" || !Number.isSafeInteger(nativeContextWindow) || nativeContextWindow <= 0) {
		throw new Error(`model ${railModelReference(model)} does not expose a verifiable native contextWindow`);
	}
	const compaction = createChildContextSettings(cwd).getCompactionSettings({ provider: model.provider, id: model.modelId });
	validateContextWindowReserve(contextWindow ?? nativeContextWindow, compaction.reserveTokens, compaction.enabled);
	return {
		model, modelReference: railModelReference(model), cwd,
		fastMode: effectiveFastModeText(fastRequest, native) === "on", searchMode: effectiveSearchModeText(native),
		nativeContextWindow, compactionReserveTokens: compaction.reserveTokens, compactionEnabled: compaction.enabled,
		...(contextWindow !== undefined ? { contextWindow } : {}),
	};
}

/** Re-check the pinned N09 policy immediately before launch; changed model or project trust requires prepare again. */
export function verifyPinnedTeamMemberPolicy(policy: ResolvedTeamMemberPolicy, ctx: RenderModelContext): void {
	const native = nativeModelForRailRef(policy.model, ctx);
	if (!native || native.contextWindow !== policy.nativeContextWindow) {
		throw new Error(`${policy.modelReference}: native model/contextWindow changed after prepare; prepare the Team again`);
	}
	const compaction = createChildContextSettings(policy.cwd).getCompactionSettings({ provider: policy.model.provider, id: policy.model.modelId });
	if (compaction.reserveTokens !== policy.compactionReserveTokens || compaction.enabled !== policy.compactionEnabled) {
		throw new Error(`${policy.modelReference}: project trust/compaction policy changed after prepare; prepare the Team again`);
	}
	validateContextWindowReserve(policy.contextWindow ?? policy.nativeContextWindow, policy.compactionReserveTokens, policy.compactionEnabled);
	const fastRequest = effectiveFastModeRequest({ task: "", fastMode: policy.fastMode }, native);
	if ((effectiveFastModeText(fastRequest, native) === "on") !== policy.fastMode
		|| effectiveSearchModeText(native) !== policy.searchMode) {
		throw new Error(`${policy.modelReference}: Fast/Search policy changed after prepare; prepare the Team again`);
	}
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
		if (event.isError && details) {
			const usage = nestedToolUsage(details.results);
			return { details, ...(usage ? { usage } : {}) };
		}
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
	const runDispatch = async (
		toolCallId: string,
		params: SubagentParamsValue,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<StatefulSubagentDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<StatefulSubagentDetails>> => {
		let toolStartedAt = performance.now();
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
				content: [{ type: "text", text: truncateParentContent(result.output || "(running...)") }],
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
			if (item.fastMode === true) effectiveFastModeRequest(item, modelForFastMode(item, ctx));
		}
		const contextTargetItems = requestedItems.filter((item) => item.target && item.contextWindow != null);
		const broker = contextTargetItems.length > 0
			? (typeof options.broker === "function" ? options.broker() : options.broker)
			: undefined;
		// Pin budgeted selections before asynchronous preflight/confirmation so a parent
		// model switch cannot change the child after its reserve was validated.
		const budgetModels = requestedItems.map((item) => !item.target && item.contextWindow != null ? resolveRailModel(item.model, ctx) : undefined);
		await validateTaskContextWindows(requestedItems, budgetModels, broker, ctx.cwd);
		const sessionAttachments = requestedItems.filter((item) => item.session != null);
		if (sessionAttachments.length > 0 && (ctx.hasUI || (params.confirmSessionAttach ?? true))) {
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
			actualTasks.set(slot, item.task);
			runStartedAt.set(slot, performance.now());
			const duration = () => runDuration(slot);
			if (signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
			if (item.target && item.model) throw new Error("A follow-up target cannot also select a model");
			const persistent = isPersistentTask(item);
			if (!persistent) {
				if (!options.runStateless) throw new Error("Stateless model-session runner is not configured");
				const model = budgetModels[slot] ?? resolveRailModel(item.model, ctx);
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
			const model = item.target ? undefined : budgetModels[slot] ?? resolveRailModel(item.model, ctx);
			const fastMode = effectiveFastModeRequest(item, model ? nativeModelForRailRef(model, ctx) : undefined);
			const request: DispatchRequest = {
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
			const usage = nestedToolUsage(details.results);
			return { content: [{ type: "text", text: finalText(result) }], details, ...(usage ? { usage } : {}) };
		}
		if (mode === "parallel") {
			const results = await mapWithConcurrency(requestedItems, MAX_CONCURRENCY, (item, index) => runTask(item, index));
			const details = resultDetails(results);
			latestDetails.set(toolCallId, details);
			const usage = nestedToolUsage(details.results);
			return { content: [{ type: "text", text: aggregateText(mode, results) }], details, ...(usage ? { usage } : {}) };
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
		const usage = nestedToolUsage(details.results);
		return { content: [{ type: "text", text: aggregateText(mode, results) }], details, ...(usage ? { usage } : {}) };
	};

	const renderDispatchResult = (
		result: AgentToolResult<unknown>,
		{ expanded, isPartial }: ToolRenderResultOptions,
		theme: Theme,
		context: { readonly toolCallId?: string; readonly args?: SubagentParamsValue } | undefined,
	): Component => {
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
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: prompt("subagent", "description"),
		promptSnippet: prompt("subagent", "prompt_snippet"),
		executionMode: "parallel",
		promptGuidelines: promptList("subagent", "prompt_guidelines"),
		parameters: SubagentParams,
		prepareArguments(params: unknown): SubagentParamsValue {
			const candidate = params as SubagentParamsValue;
			try {
				return filterParamsForMode(candidate, modeFor(candidate));
			} catch {
				return candidate;
			}
		},

		execute: (toolCallId, params, signal, onUpdate, ctx) => runDispatch(toolCallId, params, signal, onUpdate, ctx),

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

		renderResult: (result, renderOptions, theme, context) => renderDispatchResult(result, renderOptions, theme, context),
	});
}
