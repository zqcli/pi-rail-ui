import { randomUUID } from "node:crypto";
import { calculateCost, createAssistantMessageEventStream, type Api, type ImageContent, type Model, type TextContent, type ThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	convertToLlm,
	estimateTokens,
	sessionEntryToContextMessages,
	generateSummaryWithUsage,
	type CompactionEntry,
	type CompactionResult,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildCompactionHeaders, buildResponsesUrl, resolveCompactionAuth, resolveSessionId } from "./auth";
import { rebuildNativeHistory, rebuildNativeHistoryPrefix, collectMessages, findEntryIndex, findLatestNativeHistoryBoundaryInRange, resolveCheckpointBoundary, type CheckpointBoundary } from "./history";
import { compactionIdentity, identitiesMatch, type CompactionIdentity } from "./model-eligibility";
import { getCompactionRequestExtras, rememberRequestContext } from "./request-context";
import {
	executeRemoteCompactionV2,
	type RemoteCompactionResult,
	type RemoteCompactionUsage,
} from "./remote-v2-client";
import { serializeMessagesToResponsesInput } from "./serializer";
import {
	getGptCompactionDetails,
	gptCompactionSummary,
	resolveSessionCheckpoint,
	GPT_COMPACTION_DETAILS_VERSION,
	GPT_COMPACTION_STRATEGY,
	isCompactionItem,
	type GptCompactionDetails,
} from "./types";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

export interface CompactionRunnerDeps {
	executeRemote?: typeof executeRemoteCompactionV2;
	/** Injectable native summarizer for tests. */
	nativeSummary?: typeof generateSummaryWithUsage;
}

export type CompactionOutcome =
	| { outcome: "success"; compaction: CompactionResult }
	| { outcome: "aborted" }
	| { outcome: "failed"; reason: string; detail?: string };

function isAbortError(error: unknown): boolean {
	return (error instanceof DOMException && error.name === "AbortError")
		|| (error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"));
}

function usageFromResponse(usage: RemoteCompactionUsage | undefined, model: Model<Api>): Usage | undefined {
	if (!usage) return undefined;
	const nestedInputDetails = usage["input_tokens_details"] && typeof usage["input_tokens_details"] === "object"
		? usage["input_tokens_details"] as Record<string, unknown>
		: undefined;
	const rawInput = typeof usage["input"] === "number" ? usage["input"] : typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
	const cacheRead = typeof usage["cacheRead"] === "number"
		? usage["cacheRead"]
		: typeof usage["cached_tokens"] === "number"
			? usage["cached_tokens"]
			: typeof nestedInputDetails?.["cached_tokens"] === "number" ? nestedInputDetails["cached_tokens"] : 0;
	const cacheWrite = typeof usage["cacheWrite"] === "number"
		? usage["cacheWrite"]
		: typeof usage["cache_write_tokens"] === "number"
			? usage["cache_write_tokens"]
			: typeof nestedInputDetails?.["cache_write_tokens"] === "number" ? nestedInputDetails["cache_write_tokens"] : 0;
	const input = Math.max(0, rawInput - cacheRead - cacheWrite);
	const output = typeof usage["output"] === "number" ? usage["output"] : typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
	const total = typeof usage["totalTokens"] === "number" ? usage["totalTokens"] : typeof usage["total_tokens"] === "number" ? usage["total_tokens"] : input + output + cacheRead + cacheWrite;
	const resolved: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	resolved.cost = calculateCost(model, resolved);
	return resolved;
}

/**
 * Rebuild the real, provider-independent conversation from session entries.
 *
 * Pi stores every original entry, so flattening non-compaction entries restores
 * the exact conversation that existed before any Rail checkpoint. Compaction
 * entries are skipped because their ciphertext is bound to one provider.
 */
export function rebuiltBranchMessages(branchEntries: readonly SessionEntry[]): AgentMessage[] {
	return rebuildNativeHistory(branchEntries).messages;
}

/** Responses-format text for the rebuilt history, used when no checkpoint applies. */
export function rebuiltBranchInput(model: Model<Api>, branchEntries: readonly SessionEntry[]): unknown[] {
	return serializeMessagesToResponsesInput(model, convertToLlm(rebuiltBranchMessages(branchEntries)));
}

function serializeEntries(model: Model<Api>, entries: readonly SessionEntry[]): unknown[] {
	return serializeMessagesToResponsesInput(model, convertToLlm(collectMessages(entries)));
}

function serializeLogicalCompactionInterval(
	model: Model<Api>,
	branchEntries: readonly SessionEntry[],
	startIndex: number,
	endIndex: number,
): unknown[] {
	const nativeBoundary = findLatestNativeHistoryBoundaryInRange(branchEntries, startIndex, endIndex);
	if (!nativeBoundary) {
		return serializeEntries(model, branchEntries.slice(startIndex, endIndex).filter((entry) => entry.type !== "compaction"));
	}
	const messages = [
		...sessionEntryToContextMessages(nativeBoundary.entry),
		...collectMessages(branchEntries.slice(nativeBoundary.firstKeptIndex, endIndex).filter((entry) => entry.type !== "compaction")),
	];
	return serializeMessagesToResponsesInput(model, convertToLlm(messages));
}

function safeHistoryPrefixInput(model: Model<Api>, branchEntries: readonly SessionEntry[], endIndex: number): unknown[] | undefined {
	const rebuilt = rebuildNativeHistoryPrefix(branchEntries, endIndex);
	return rebuilt ? serializeMessagesToResponsesInput(model, convertToLlm(rebuilt.messages)) : undefined;
}

function cloneCheckpointItems(items: readonly unknown[]): unknown[] {
	return items.map((item) => structuredClone(item));
}

/**
 * Build the synthetic v2 compaction request input.
 *
 * A replayed checkpoint continues the previous remote context: the stored
 * replacement window plus the retained and live-tail entries that Pi kept. A
 * branch whose checkpoint belongs to a different provider identity, or whose
 * latest compaction was native, restarts from the rebuilt real history so no
 * summary placeholder is ever summarized.
 */
export function buildRemoteCompactionRequest(args: {
	model: Model<Api>;
	branchEntries: readonly SessionEntry[];
	identity?: CompactionIdentity;
	/** First entry Pi will retain after this compaction cut. */
	firstKeptEntryId?: string;
}): { ok: true; input: unknown[] } | { ok: false; reason: string } {
	const cutIndex = args.firstKeptEntryId === undefined
		? undefined
		: findEntryIndex(args.branchEntries, args.firstKeptEntryId);
	if (args.firstKeptEntryId !== undefined && (cutIndex === undefined || cutIndex < 0)) {
		return { ok: false, reason: "checkpoint-boundary-not-found" };
	}
	const checkpoint = resolveSessionCheckpoint(args.branchEntries);
	if (checkpoint.status === "native") {
		const input = cutIndex === undefined ? rebuiltBranchInput(args.model, args.branchEntries) : safeHistoryPrefixInput(args.model, args.branchEntries, cutIndex);
		return input ? { ok: true, input } : { ok: false, reason: "checkpoint-boundary-not-found" };
	}
	if (checkpoint.status === "invalid") {
		const input = cutIndex === undefined ? undefined : safeHistoryPrefixInput(args.model, args.branchEntries, cutIndex);
		return input ? { ok: true, input } : { ok: false, reason: "checkpoint-invalid" };
	}
	if (checkpoint.status === "none") {
		const input = cutIndex === undefined ? rebuiltBranchInput(args.model, args.branchEntries) : safeHistoryPrefixInput(args.model, args.branchEntries, cutIndex);
		return input ? { ok: true, input } : { ok: false, reason: "checkpoint-boundary-not-found" };
	}

	const identity = args.identity ?? compactionIdentity(args.model);
	if (!identitiesMatch(checkpoint.details.consumer, identity)) {
		// Opaque ciphertext never crosses identities; restart from real records.
		const input = cutIndex === undefined ? rebuiltBranchInput(args.model, args.branchEntries) : safeHistoryPrefixInput(args.model, args.branchEntries, cutIndex);
		return input ? { ok: true, input } : { ok: false, reason: "checkpoint-boundary-not-found" };
	}
	const boundary = resolveCheckpointBoundary(args.branchEntries, checkpoint.entry, checkpoint.details);
	if (!boundary) return { ok: false, reason: "checkpoint-boundary-not-found" };
	if (cutIndex !== undefined) {
		if (cutIndex <= boundary.firstKeptIndex) return { ok: false, reason: "checkpoint-boundary-not-found" };
		return {
			ok: true,
			input: [
				...cloneCheckpointItems(checkpoint.details.replacement),
				...serializeLogicalCompactionInterval(args.model, args.branchEntries, boundary.firstKeptIndex, cutIndex),
			],
		};
	}
	return {
		ok: true,
		input: [
			...cloneCheckpointItems(checkpoint.details.replacement),
			...serializeLogicalCompactionInterval(args.model, args.branchEntries, boundary.firstKeptIndex, boundary.boundaryIndex),
			...serializeEntries(args.model, boundary.liveTail),
		],
	};
}

function mergeCompactionInstructions(systemPrompt: string, customInstructions: string | undefined): string {
	const custom = customInstructions?.trim();
	if (!custom) return systemPrompt;
	if (!systemPrompt.trim()) return custom;
	return `${systemPrompt}\n\nAdditional instructions for this compaction only:\n${custom}`;
}

/** Run remote v2 compaction for one `session_before_compact` event. */
export async function runRemoteCompaction(args: {
	event: SessionBeforeCompactEvent;
	ctx: ExtensionContext;
	deps?: CompactionRunnerDeps;
}): Promise<CompactionOutcome> {
	const { event, ctx } = args;
	const model = ctx.model;
	if (!model) return { outcome: "failed", reason: "missing-model" };
	if (event.signal.aborted) return { outcome: "aborted" };

	const sessionId = resolveSessionId(ctx);
	const auth = await resolveCompactionAuth(ctx, model);
	if (!auth.ok) return { outcome: "failed", reason: auth.reason, detail: auth.detail };
	const identity = auth.identity;

	const request = buildRemoteCompactionRequest({
		model,
		branchEntries: event.branchEntries,
		identity: auth.identity,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
	});
	if (!request.ok) return { outcome: "failed", reason: request.reason };

	const instructions = mergeCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const body: Record<string, unknown> = { model: model.id, input: request.input, instructions };
	const extras = getCompactionRequestExtras(auth.identity, sessionId);
	if (extras) {
		if (extras.tools) body["tools"] = extras.tools;
		if (extras.parallel_tool_calls !== undefined) body["parallel_tool_calls"] = extras.parallel_tool_calls;
		if (extras.reasoning) body["reasoning"] = extras.reasoning;
		if (extras.service_tier !== undefined) body["service_tier"] = extras.service_tier;
		if (extras.text) body["text"] = extras.text;
		if (extras.max_output_tokens !== undefined) body["max_output_tokens"] = extras.max_output_tokens;
		if (extras.prompt_cache_key !== undefined) body["prompt_cache_key"] = extras.prompt_cache_key;
	}

	const execute = args.deps?.executeRemote ?? executeRemoteCompactionV2;
	let result: RemoteCompactionResult;
	try {
		result = await execute({
			url: buildResponsesUrl(auth.baseUrl, identity.api),
			headers: buildCompactionHeaders({ auth, ...(sessionId ? { sessionId } : {}) }),
			body,
			signal: event.signal,
		});
	} catch (error) {
		if (event.signal.aborted || isAbortError(error)) return { outcome: "aborted" };
		return { outcome: "failed", reason: "client-error", detail: error instanceof Error ? error.message : String(error) };
	}

	if (!result.ok) {
		if (result.reason === "aborted") return { outcome: "aborted" };
		return { outcome: "failed", reason: result.reason, ...(result.errorMessage ? { detail: result.errorMessage } : {}) };
	}

	const createdAt = result.createdAt ?? new Date().toISOString();
	const checkpointId = randomUUID();
	const details: GptCompactionDetails = {
		version: GPT_COMPACTION_DETAILS_VERSION,
		strategy: GPT_COMPACTION_STRATEGY,
		checkpointId,
		consumer: identity,
		producer: identity,
		checkpoint: structuredClone(result.checkpoint),
		replacement: [structuredClone(result.checkpoint)],
		boundary: {
			parentEntryId: event.branchEntries.at(-1)?.id ?? null,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		},
		...(result.responseId ? { compactResponseId: result.responseId } : {}),
		createdAt,
		requestMeta: {
			tokensBefore: event.preparation.tokensBefore,
			previousSummaryPresent: Boolean(event.preparation.previousSummary),
		},
	};

	const usage = usageFromResponse(result.usage, model);
	return {
		outcome: "success",
		compaction: {
			summary: gptCompactionSummary(checkpointId),
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details,
			...(usage ? { usage } : {}),
		},
	};
}

/**
 * Native Pi summary used when remote v2 must not run but the latest compaction
 * is a Rail checkpoint. Pi's own preparation would treat the display placeholder
 * as the previous summary and silently drop everything before the checkpoint, so
 * this summarizes the rebuilt real history instead.
 */
export async function runNativeRepairCompaction(args: {
	event: SessionBeforeCompactEvent;
	ctx: ExtensionContext;
	deps?: CompactionRunnerDeps;
}): Promise<CompactionOutcome> {
	const { event, ctx } = args;
	const model = ctx.model;
	if (!model) return { outcome: "failed", reason: "missing-model" };
	if (event.signal.aborted) return { outcome: "aborted" };
	const preparation = repairedPreparation(event);
	if (!preparation) return { outcome: "failed", reason: "no-repair-source" };

	const auth = await resolveCompactionAuth(ctx, model);
	if (!auth.ok) return { outcome: "failed", reason: auth.reason, detail: auth.detail };
	const summarize = args.deps?.nativeSummary ?? generateSummaryWithUsage;
	const chunks = chunkNativeRepairMessages(preparation.messagesToSummarize, model, preparation.settings.reserveTokens);
	if (!chunks) return { outcome: "failed", reason: "native-repair-budget-exhausted" };
	try {
		let summary: string | undefined;
		let usage: Usage | undefined;
		for (const chunk of chunks) {
			const result = await summarize(
				chunk,
				model,
				preparation.settings.reserveTokens,
				auth.apiKey,
				auth.headers,
				event.signal,
				event.customInstructions,
				summary,
				ctx.thinkingLevel,
				providerStreamFn(ctx),
				undefined,
				undefined,
				undefined,
				resolveSessionId(ctx),
			);
			if (event.signal.aborted) return { outcome: "aborted" };
			if (!result.text.trim()) return { outcome: "failed", reason: "empty-summary" };
			summary = result.text;
			usage = addUsage(usage, result.usage);
		}
		if (!summary) return { outcome: "failed", reason: "empty-summary" };
		return {
			outcome: "success",
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				...(usage ? { usage } : {}),
				details: { readFiles: [], modifiedFiles: [] },
			},
		};
	} catch (error) {
		if (event.signal.aborted || isAbortError(error)) return { outcome: "aborted" };
		return { outcome: "failed", reason: "native-summary-failed", detail: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Route the native summarizer through Pi's model registry so custom providers
 * (registered `streamSimple`) keep working instead of falling back to the
 * built-in OpenAI APIs.
 */
function providerStreamFn(ctx: ExtensionContext): StreamFn {
	return ((model, context, options) => {
		const pending = ctx.modelRegistry.complete(model as Model<Api>, context, options as never).then((message) => {
			const stream = createAssistantMessageEventStream();
			const partial = { ...message, content: [] as never, stopReason: "pending" as const };
			stream.push({ type: "start", partial } as never);
			stream.push({ type: "done", reason: message.stopReason, message } as never);
			stream.end(message);
			return stream;
		});
		return pending;
	}) as StreamFn;
}

function addUsage(left: Usage | undefined, right: Usage): Usage {
	if (!left) return structuredClone(right);
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

function splitText(text: string, maxChars: number): string[] {
	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += maxChars) chunks.push(text.slice(start, start + maxChars));
	return chunks.length > 0 ? chunks : [""];
}

function splitOversizedSummaryMessage(message: AgentMessage, budget: number): AgentMessage[] | undefined {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
	const content = message.content;
	if (typeof content === "string") {
		return splitText(content, Math.max(64, budget * 3)).map((text) => ({ ...message, content: text } as AgentMessage));
	}
	if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") return undefined;
	const block = content[0];
	return splitText(block.text, Math.max(64, budget * 3)).map((text) => ({
		...message,
		content: [{ ...block, text }],
	} as AgentMessage));
}

/**
 * Bound each native repair request. A single native summary call is allowed
 * when it fits; otherwise summaries are folded in order through the same
 * provider, never by sending the entire recovered branch over the context
 * window. Oversized plain-text messages are split only for this summary input;
 * tool calls and rich messages fail closed rather than being truncated.
 */
function chunkNativeRepairMessages(messages: readonly AgentMessage[], model: Model<Api>, reserveTokens: number): AgentMessage[][] | undefined {
	const outputBudget = Math.max(16, Math.min(Math.floor(reserveTokens * 0.8), model.maxTokens));
	const available = model.contextWindow - outputBudget - 512;
	if (available < 128) return undefined;
	// Leave room for the previous folded summary on every call after the first.
	const budget = Math.max(64, Math.floor((available - outputBudget) * 0.5));
	if (budget < 64) return undefined;
	const chunks: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	let currentTokens = 0;
	for (const message of messages) {
		const pieces = estimateTokens(message) > budget
			? splitOversizedSummaryMessage(message, budget)
			: [message];
		if (!pieces || pieces.some((piece) => estimateTokens(piece) > budget)) return undefined;
		for (const piece of pieces) {
			const tokens = estimateTokens(piece);
			if (current.length > 0 && currentTokens + tokens > budget) {
				chunks.push(current);
				current = [];
				currentTokens = 0;
			}
			current.push(piece);
			currentTokens += tokens;
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks.length > 0 ? chunks : undefined;
}

/**
 * Rewrite Pi's preparation so the native summarizer sees real history. The
 * placeholder summary is dropped so the model produces a fresh summary instead
 * of merging marker text.
 */
function repairedPreparation(event: SessionBeforeCompactEvent): CompactionPreparation | undefined {
	const messages = currentBranchMessagesBeforeCut(event.branchEntries, event.preparation.firstKeptEntryId);
	if (!messages || messages.length === 0) return undefined;
	const { previousSummary: _previousSummary, ...rest } = event.preparation;
	return {
		...rest,
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
	};
}

function currentBranchMessagesBeforeCut(
	branchEntries: readonly SessionEntry[],
	firstKeptEntryId: string,
): AgentMessage[] | undefined {
	const cutIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (cutIndex < 0) return undefined;
	return rebuildNativeHistoryPrefix(branchEntries, cutIndex)?.messages;
}

export function rememberLiveRequestContext(ctx: ExtensionContext, payload: unknown): void {
	const model = ctx.model;
	if (!model) return;
	rememberRequestContext(payload, compactionIdentity(model), resolveSessionId(ctx));
}

export type ContextReplayDecision =
	| { action: "none" }
	| { action: "replace"; messages: AgentMessage[] }
	| { action: "abort"; reason: string };

function sameMessage(left: AgentMessage, right: AgentMessage): boolean {
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return left.role === right.role && left.timestamp === right.timestamp;
	}
}

function rebuiltContextMessages(args: {
		branchEntries: readonly SessionEntry[];
		messages?: readonly AgentMessage[];
		storedMessages?: readonly AgentMessage[];
	}): AgentMessage[] | undefined {
	const rebuilt = rebuiltBranchMessages(args.branchEntries);
	if (!args.messages || !args.storedMessages) return rebuilt;
	const startsWith = (prefix: readonly AgentMessage[]): boolean => {
		if (args.messages!.length < prefix.length) return false;
		for (let index = 0; index < prefix.length; index += 1) {
			const expected = prefix[index];
			const current = args.messages![index];
			if (!expected || !current || !sameMessage(expected, current)) return false;
		}
		return true;
	};
	if (startsWith(rebuilt)) return args.messages.map((message) => structuredClone(message));
	if (!startsWith(args.storedMessages)) return undefined;
	return [...rebuilt, ...args.messages.slice(args.storedMessages.length).map((message) => structuredClone(message))];
}

/**
 * Decide whether Pi's outgoing conversation must be rebuilt from original
 * records. That is required whenever the latest compaction is a Rail checkpoint
 * and its opaque window cannot be replayed: the feature is off, or the active
 * provider/account/gateway differs from the producer.
 */
export function planContextReplay(args: {
	ctx: ExtensionContext;
	branchEntries: readonly SessionEntry[];
	remoteEnabled: boolean;
	identity?: CompactionIdentity;
	messages?: readonly AgentMessage[];
	storedMessages?: readonly AgentMessage[];
}): ContextReplayDecision {
	const checkpoint = resolveSessionCheckpoint(args.branchEntries);
	const model = args.ctx.model;
	if (!model) return { action: "abort", reason: "missing-model" };
	if (checkpoint.status === "remote"
		&& args.remoteEnabled
		&& identitiesMatch(checkpoint.details.consumer, args.identity ?? compactionIdentity(model))) {
		return { action: "none" };
	}
	if (checkpoint.status !== "remote" && checkpoint.status !== "invalid") return { action: "none" };
	const messages = rebuiltContextMessages(args);
	if (!messages) return { action: "abort", reason: "live-context-prefix-mismatch" };
	const estimatedTokens = messages.reduce((total, message) => total + estimateTokens(message), 0);
	if (estimatedTokens > model.contextWindow) {
		return { action: "abort", reason: "rebuilt-history-exceeds-context-window" };
	}
	return { action: "replace", messages };
}

export type PayloadRewriteDecision =
	| { action: "none" }
	| { action: "rewrite"; payload: unknown }
	| { action: "fail"; reason: string };

/**
 * Replace the placeholder summary item with the stored opaque window in the
 * provider payload. Returns `fail` when a matching checkpoint exists and the
 * payload is a Responses request that still carries the placeholder but cannot
 * be rewritten: sending it would silently lose the compacted history.
 */
export function planPayloadRewrite(args: {
	ctx: ExtensionContext;
	branchEntries: readonly SessionEntry[];
	payload: unknown;
	remoteEnabled: boolean;
	identity?: CompactionIdentity;
}): PayloadRewriteDecision {
	const checkpoint = resolveSessionCheckpoint(args.branchEntries);
	const model = args.ctx.model;
	if (!model) return { action: "fail", reason: "missing-model" };
	const input = readResponsesInput(args.payload);
	if (checkpoint.status === "invalid") {
		if (!input) return { action: "fail", reason: "responses-input-missing" };
		return containsGptCompactionMarker(input)
			? { action: "fail", reason: "checkpoint-details-invalid" }
			: { action: "none" };
	}
	if (checkpoint.status !== "remote") return { action: "none" };
	const identity = args.identity ?? compactionIdentity(model);
	const markerPresent = input ? findSummaryIndex(input, gptCompactionSummary(checkpoint.details.checkpointId)) >= 0 : false;
	const matchingCheckpointCount = input?.filter((item) => isMatchingCheckpointItem(item, checkpoint.details.checkpoint)).length ?? 0;
	if (matchingCheckpointCount > 1 || (markerPresent && matchingCheckpointCount > 0)) {
		return { action: "fail", reason: "checkpoint-anchor-ambiguous" };
	}
	if (!args.remoteEnabled || !identitiesMatch(checkpoint.details.consumer, identity)) {
		return markerPresent ? { action: "fail", reason: "checkpoint-anchor-not-replayed" } : { action: "none" };
	}
	if (!input) return { action: "fail", reason: "responses-input-missing" };
	if (matchingCheckpointCount === 0 && !markerPresent) {
		const rebuiltInput = rebuiltBranchInput(model, args.branchEntries);
		if (inputStartsWith(input, rebuiltInput)) return { action: "none" };
	}
	if (matchingCheckpointCount === 1 && !markerPresent) {
		const boundary = resolveCheckpointBoundary(args.branchEntries, checkpoint.entry, checkpoint.details);
		return boundary ? { action: "none" } : { action: "fail", reason: "checkpoint-boundary-not-found" };
	}
	const summaryIndex = findSummaryIndex(input, gptCompactionSummary(checkpoint.details.checkpointId));
	if (summaryIndex < 0) return { action: "fail", reason: "payload-summary-anchor-missing" };
	const boundary = resolveCheckpointBoundary(args.branchEntries, checkpoint.entry, checkpoint.details);
	if (!boundary) return { action: "fail", reason: "checkpoint-boundary-not-found" };
	return {
		action: "rewrite",
		payload: {
			...(args.payload as Record<string, unknown>),
			input: [
				...input.slice(0, summaryIndex).map((item) => structuredClone(item)),
				...cloneCheckpointItems(checkpoint.details.replacement),
				...input.slice(summaryIndex + 1).map((item) => structuredClone(item)),
			],
		},
	};
}

function isMatchingCheckpointItem(value: unknown, checkpoint: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value) || !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	const expected = checkpoint as Record<string, unknown>;
	return candidate["type"] === "compaction"
		&& candidate["encrypted_content"] === expected["encrypted_content"]
		&& typeof candidate["encrypted_content"] === "string";
}

function readResponsesInput(payload: unknown): unknown[] | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const input = (payload as Record<string, unknown>)["input"];
	return Array.isArray(input) ? input : undefined;
}

function inputStartsWith(input: readonly unknown[], prefix: readonly unknown[]): boolean {
	if (input.length < prefix.length) return false;
	for (let index = 0; index < prefix.length; index += 1) {
		try {
			if (JSON.stringify(input[index]) !== JSON.stringify(prefix[index])) return false;
		} catch {
			return false;
		}
	}
	return true;
}

function findSummaryIndex(input: readonly unknown[], marker: string): number {
	return input.findIndex((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return false;
		const record = item as Record<string, unknown>;
		if (record["role"] !== "user") return false;
		const content = record["content"];
		if (typeof content === "string") return content.includes(marker);
		if (!Array.isArray(content)) return false;
		return content.some((part) => {
			if (!part || typeof part !== "object" || Array.isArray(part)) return false;
			const text = (part as Record<string, unknown>)["text"];
			return typeof text === "string" && text.includes(marker);
		});
	});
}

function containsGptCompactionMarker(input: readonly unknown[]): boolean {
	return input.some((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return false;
		const record = item as Record<string, unknown>;
		const content = record["content"];
		if (typeof content === "string") return content.includes("[GPT remote compaction checkpoint ");
		if (!Array.isArray(content)) return false;
		return content.some((part) => part && typeof part === "object" && !Array.isArray(part)
			&& typeof (part as Record<string, unknown>)["text"] === "string"
			&& ((part as Record<string, unknown>)["text"] as string).includes("[GPT remote compaction checkpoint "));
	});
}

export function checkpointFromEntry(entry: CompactionEntry | undefined): GptCompactionDetails | undefined {
	return getGptCompactionDetails(entry);
}

export function describeFailure(reason: string, detail?: string): string {
	const label = reason.replaceAll("-", " ");
	return detail ? `${label}: ${detail}` : label;
}

export type { CheckpointBoundary };
export { isCompactionItem };
export type { CompactionIdentity, TextContent, ImageContent, ThinkingLevel };
