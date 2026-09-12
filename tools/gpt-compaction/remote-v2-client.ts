/**
 * Codex Remote Compaction v2 protocol client.
 *
 * The v2 handshake is a normal `POST /responses` request whose input ends with
 * `{ "type": "compaction_trigger" }` and which forces `store: false` and
 * `stream: true`. A successful response is a complete SSE stream containing a
 * single `response.completed` event with exactly one `compaction` output item.
 * Everything else (missing completion, duplicate/missing checkpoint, conflicting
 * metadata, malformed SSE) is a failure and must not install history.
 *
 * The stream is consumed incrementally so a checkpoint is only ever returned
 * after the terminal `response.completed` event, and so a huge or stalled
 * response can be cancelled without buffering the whole body.
 */
import type { CompactionItem } from "./types";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2_000;
/** Bounds on retained evidence; exceeding them is a protocol failure. */
const MAX_SSE_EVENTS = 4_096;
const MAX_SSE_BYTES = 8 * 1024 * 1024;
const COMPACTION_ITEM_KEYS = new Set(["type", "encrypted_content", "id", "response_id", "output_index"]);

export type RemoteCompactionFailureReason =
	| "aborted"
	| "network-error"
	| "timeout"
	| "non-2xx"
	| "empty-body"
	| "invalid-sse"
	| "error-event"
	| "missing-completed-event"
	| "duplicate-completed-event"
	| "invalid-event-order"
	| "incomplete-response"
	| "invalid-compaction-count"
	| "malformed-compaction-item"
	| "conflicting-compaction-item"
	| "invalid-compaction-metadata";

export type RemoteCompactionFailure = {
	ok: false;
	reason: RemoteCompactionFailureReason;
	status?: number;
	errorMessage?: string;
};

export type RemoteCompactionSuccess = {
	ok: true;
	status: number;
	checkpoint: CompactionItem;
	responseId?: string;
	createdAt?: string;
	usage?: RemoteCompactionUsage;
};

export type RemoteCompactionResult = RemoteCompactionFailure | RemoteCompactionSuccess;

export interface RemoteCompactionUsage {
	input?: number;
	output?: number;
	totalTokens?: number;
	[key: string]: unknown;
}

export interface RemoteCompactionRequest {
	/** Full request body; `input` must not include the trigger. */
	body: Record<string, unknown>;
	url: string;
	headers: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Injectable for tests; defaults to global fetch. */
	fetch?: typeof globalThis.fetch;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Report attempt count without leaking payloads. */
	onAttempt?: (attempt: number) => void;
}

export type ParsedSseEvent = {
	event?: string;
	dataText: string;
	data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isAbortError(error: unknown): boolean {
	return (error instanceof DOMException && error.name === "AbortError")
		|| (error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"));
}

function errorMessage(error: unknown): string {
	return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

/**
 * Parse one already-complete SSE block. Returns undefined for malformed JSON so
 * the caller can fail closed instead of guessing.
 */
function parseSseBlock(block: string): ParsedSseEvent | null | undefined {
	if (!block.trim()) return null;
	let event: string | undefined;
	const dataLines: string[] = [];
	let hasNonCommentLine = false;
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) continue;
		if (line.trim()) hasNonCommentLine = true;
		if (line.startsWith("event:")) {
			event = line.slice("event:".length).trim();
			continue;
		}
		if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /u, ""));
	}
	if (dataLines.length === 0) return hasNonCommentLine ? undefined : null;
	const dataText = dataLines.join("\n");
	if (dataText === "[DONE]") return event === undefined ? { dataText } : { event, dataText };
	try {
		const data: unknown = JSON.parse(dataText);
		return event === undefined ? { dataText, data } : { event, dataText, data };
	} catch {
		return undefined;
	}
}

/** Buffered parser retained for tests and non-streaming fallbacks. */
export function parseSseEvents(raw: string): ParsedSseEvent[] | undefined {
	const normalized = raw.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
	const events: ParsedSseEvent[] = [];
	for (const block of normalized.split(/\n\n+/u)) {
		const parsed = parseSseBlock(block);
		if (parsed === undefined) {
			if (!block.trim()) continue;
			return undefined;
		}
		if (parsed === null) continue;
		events.push(parsed);
	}
	return events.length > 0 ? events : undefined;
}

export type SseEventType = string | undefined;

function eventType(event: ParsedSseEvent): string | undefined {
	return isRecord(event.data) && isNonEmptyString(event.data["type"]) ? event.data["type"] : event.event;
}

/** Structural events carry all evidence needed by reconciliation. */
function isStructuralEvent(event: ParsedSseEvent): boolean {
	const type = eventType(event);
	return type === "response.created"
		|| type === "response.output_item.done"
		|| type === "response.completed"
		|| type === "response.incomplete"
		|| type === "response.failed"
		|| type === "error"
		|| event.dataText === "[DONE]";
}

function isTerminalEvent(event: ParsedSseEvent): boolean {
	const type = eventType(event);
	return type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error";
}

/**
 * Incremental SSE reader. Feeds decoded text and yields structural events as
 * soon as complete blocks arrive, retaining a bounded amount of evidence.
 */
export class SseEventReader {
	private pending = "";
	private bytes = 0;
	private invalid = false;
	private overflow = false;
	private terminal = false;
	private readonly events: ParsedSseEvent[] = [];

	push(text: string): void {
		if (this.invalid || this.overflow) return;
		this.bytes += text.length;
		if (this.bytes > MAX_SSE_BYTES) {
			this.overflow = true;
			return;
		}
		this.pending += text;
		// Hold back a trailing carriage return so CRLF split across chunks is not
		// mistaken for a lone line break.
		let parseable = this.pending;
		if (parseable.endsWith("\r")) {
			parseable = parseable.slice(0, -1);
			this.pending = "\r";
		} else {
			this.pending = "";
		}
		const blocks = parseable.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split(/\n\n+/u);
		const rest = blocks.pop() ?? "";
		this.pending = `${rest}${this.pending}`;
		for (const block of blocks) this.consume(block);
	}

	end(): void {
		this.consume(this.pending.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n"));
		this.pending = "";
	}

	get isInvalid(): boolean {
		return this.invalid || this.overflow;
	}

	get isTerminal(): boolean {
		return this.terminal;
	}

	snapshot(): readonly ParsedSseEvent[] {
		return this.events;
	}

	private consume(block: string): void {
		if (this.invalid || this.overflow) return;
		const parsed = parseSseBlock(block);
		if (parsed === null) return;
		if (parsed === undefined) {
			if (!block.trim()) return;
			this.invalid = true;
			return;
		}
		if (this.terminal && !isStructuralEvent(parsed) && eventType(parsed) !== "keepalive") {
			if (this.events.length >= MAX_SSE_EVENTS) {
				this.overflow = true;
				return;
			}
			this.events.push(parsed);
			return;
		}
		if (!isStructuralEvent(parsed) && !isTerminalEvent(parsed)) return;
		if (this.events.length >= MAX_SSE_EVENTS) {
			this.overflow = true;
			return;
		}
		this.events.push(parsed);
		if (isTerminalEvent(parsed)) this.terminal = true;
	}
}

function eventErrorMessage(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (isNonEmptyString(value["message"])) return redactSensitiveText(value["message"]);
	const nested = value["error"];
	if (isRecord(nested) && isNonEmptyString(nested["message"])) return redactSensitiveText(nested["message"]);
	if (isNonEmptyString(nested)) return redactSensitiveText(nested);
	return undefined;
}

function redactSensitiveText(text: string): string {
	return text
		.replace(/\b(Bearer)\s+[^\s,;]+/giu, "$1 [redacted]")
		.replace(/("?(?:encrypted_content|authorization|api[_-]?key|access[_-]?token)"?\s*:\s*")([^"\\]*)(")/giu, "$1[redacted]$3")
		.replace(/((?:encrypted[_ ]content|api\s*key|access\s*token|authorization)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
		.slice(0, 500);
}

function optionalNonEmptyString(value: Record<string, unknown>, key: string): { valid: boolean; value?: string } {
	if (!Object.prototype.hasOwnProperty.call(value, key)) return { valid: true };
	const candidate = value[key];
	return isNonEmptyString(candidate) ? { valid: true, value: candidate } : { valid: false };
}

function optionalOutputIndex(value: Record<string, unknown>): { valid: boolean; value?: number } {
	if (!Object.prototype.hasOwnProperty.call(value, "output_index")) return { valid: true };
	const index = value["output_index"];
	return typeof index === "number" && Number.isSafeInteger(index) && index >= 0
		? { valid: true, value: index }
		: { valid: false };
}

function readResponseId(value: Record<string, unknown>): { valid: boolean; value?: string } {
	const direct = optionalNonEmptyString(value, "response_id");
	if (!direct.valid) return direct;
	const nested = isRecord(value["response"]) ? optionalNonEmptyString(value["response"], "id") : { valid: true };
	if (!nested.valid) return nested;
	if (direct.value !== undefined && nested.value !== undefined && direct.value !== nested.value) return { valid: false };
	const resolved = direct.value ?? nested.value;
	return resolved === undefined ? { valid: true } : { valid: true, value: resolved };
}

interface Candidate {
	item: CompactionItem;
	responseId?: string;
	outputIndex?: number;
	outputPosition?: number;
}

function readCandidate(
	item: unknown,
	metadataSource: Record<string, unknown> | undefined,
	outputPosition?: number,
): { ok: true; candidate: Candidate } | { ok: false; reason: "malformed-compaction-item" | "invalid-compaction-metadata" } {
	if (!isRecord(item) || item["type"] !== "compaction" || !isNonEmptyString(item["encrypted_content"])) {
		return { ok: false, reason: "malformed-compaction-item" };
	}
	if (Object.keys(item).some((key) => !COMPACTION_ITEM_KEYS.has(key))) {
		return { ok: false, reason: "malformed-compaction-item" };
	}
	const itemId = optionalNonEmptyString(item, "id");
	const itemResponseId = readResponseId(item);
	const itemOutputIndex = optionalOutputIndex(item);
	if (!itemId.valid || !itemResponseId.valid || !itemOutputIndex.valid) return { ok: false, reason: "invalid-compaction-metadata" };

	const sourceResponseId = metadataSource ? readResponseId(metadataSource) : { valid: true };
	const sourceOutputIndex = metadataSource ? optionalOutputIndex(metadataSource) : { valid: true };
	if (!sourceResponseId.valid || !sourceOutputIndex.valid) return { ok: false, reason: "invalid-compaction-metadata" };
	if (itemResponseId.value !== undefined && sourceResponseId.value !== undefined && itemResponseId.value !== sourceResponseId.value) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}
	if (itemOutputIndex.value !== undefined && sourceOutputIndex.value !== undefined && itemOutputIndex.value !== sourceOutputIndex.value) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}
	const outputIndex = sourceOutputIndex.value ?? itemOutputIndex.value;
	if (outputPosition !== undefined && outputIndex !== undefined && outputIndex !== outputPosition) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}
	const resolvedResponseId = sourceResponseId.value ?? itemResponseId.value;
	const canonicalItem: CompactionItem = {
		type: "compaction",
		encrypted_content: item["encrypted_content"],
		...(itemId.value !== undefined ? { id: itemId.value } : {}),
	};
	return {
		ok: true,
		candidate: {
			item: canonicalItem,
			...(resolvedResponseId !== undefined ? { responseId: resolvedResponseId } : {}),
			...(outputIndex !== undefined ? { outputIndex } : {}),
			...(outputPosition !== undefined ? { outputPosition } : {}),
		},
	};
}

function mergeItems(done: CompactionItem, terminal: CompactionItem): CompactionItem | undefined {
	for (const [key, value] of Object.entries(done)) {
		if (Object.prototype.hasOwnProperty.call(terminal, key) && JSON.stringify(value) !== JSON.stringify(terminal[key])) {
			return undefined;
		}
	}
	return structuredClone({ ...done, ...terminal }) as CompactionItem;
}

/**
 * Reconcile the SSE stream into exactly one canonical checkpoint. The checkpoint
 * may be announced by `response.output_item.done` and/or appear in the terminal
 * response output; the two must agree when both are present.
 */
export function reconcileCheckpoint(events: readonly ParsedSseEvent[]): RemoteCompactionResult {
	const errorEvent = events.find((event) => {
		const type = eventType(event);
		return type === "error" || type === "response.failed" || type === "response.incomplete";
	});
	if (errorEvent) {
		const failure: RemoteCompactionFailure = { ok: false, reason: "error-event" };
		const detail = eventErrorMessage(errorEvent.data);
		if (detail !== undefined) failure.errorMessage = detail;
		return failure;
	}

	const completedIndexes = events.flatMap((event, index) => (eventType(event) === "response.completed" ? [index] : []));
	if (completedIndexes.length === 0) return { ok: false, reason: "missing-completed-event" };
	if (completedIndexes.length > 1) return { ok: false, reason: "duplicate-completed-event" };
	const terminalIndex = completedIndexes[0]!;

	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		if (index < terminalIndex && event.dataText === "[DONE]") return { ok: false, reason: "invalid-event-order" };
		if (index > terminalIndex && event.dataText !== "[DONE]" && eventType(event) !== "keepalive") {
			return { ok: false, reason: "invalid-event-order" };
		}
	}

	const completedEvent = events[terminalIndex]!;
	const completedData = isRecord(completedEvent.data) ? completedEvent.data : undefined;
	const completedResponse = completedData && isRecord(completedData["response"]) ? completedData["response"] : undefined;
	if (!completedResponse) return { ok: false, reason: "incomplete-response" };
	if (completedResponse["status"] !== "completed") return { ok: false, reason: "incomplete-response" };

	const hasOutput = Object.prototype.hasOwnProperty.call(completedResponse, "output");
	if (hasOutput && !Array.isArray(completedResponse["output"])) return { ok: false, reason: "incomplete-response" };
	const terminalOutput = Array.isArray(completedResponse["output"]) ? (completedResponse["output"] as unknown[]) : undefined;
	if (hasOutput && (!terminalOutput || terminalOutput.length !== 1)) return { ok: false, reason: "invalid-compaction-count" };
	if (terminalOutput?.some((item) => !isRecord(item) || item["type"] !== "compaction")) {
		return { ok: false, reason: "invalid-compaction-count" };
	}

	const terminalResponseId = optionalNonEmptyString(completedResponse, "id");
	const completedEventResponseId = completedData ? readResponseId(completedData) : { valid: true };
	if (!terminalResponseId.valid || !completedEventResponseId.valid) return { ok: false, reason: "invalid-compaction-metadata" };
	if (
		terminalResponseId.value !== undefined
		&& completedEventResponseId.value !== undefined
		&& terminalResponseId.value !== completedEventResponseId.value
	) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}
	let responseId = terminalResponseId.value ?? completedEventResponseId.value;
	for (const event of events.slice(0, terminalIndex)) {
		if (eventType(event) !== "response.created" || !isRecord(event.data)) continue;
		const created = readResponseId(event.data);
		if (!created.valid || (created.value !== undefined && responseId !== undefined && created.value !== responseId)) {
			return { ok: false, reason: "invalid-compaction-metadata" };
		}
		responseId ??= created.value;
	}

	let doneCandidate: Candidate | undefined;
	for (let index = 0; index < terminalIndex; index += 1) {
		const event = events[index]!;
		if (eventType(event) !== "response.output_item.done") continue;
		if (!isRecord(event.data) || !isRecord(event.data["item"])) return { ok: false, reason: "malformed-compaction-item" };
		const item = event.data["item"];
		if (item["type"] !== "compaction") return { ok: false, reason: "invalid-compaction-count" };
		if (doneCandidate) return { ok: false, reason: "invalid-compaction-count" };
		const candidate = readCandidate(item, event.data);
		if (!candidate.ok) return { ok: false, reason: candidate.reason };
		doneCandidate = candidate.candidate;
	}

	let terminalCandidate: Candidate | undefined;
	let terminalPosition: number | undefined;
	if (terminalOutput) {
		const positions = terminalOutput.flatMap((item, index) => (isRecord(item) && item["type"] === "compaction" ? [index] : []));
		if (positions.length > 1) return { ok: false, reason: "invalid-compaction-count" };
		if (positions.length === 1) {
			terminalPosition = positions[0]!;
			const candidate = readCandidate(terminalOutput[terminalPosition], undefined, terminalPosition);
			if (!candidate.ok) return { ok: false, reason: candidate.reason };
			terminalCandidate = candidate.candidate;
		}
	}

	if (!doneCandidate && !terminalCandidate) return { ok: false, reason: "invalid-compaction-count" };
	for (const candidate of [doneCandidate, terminalCandidate]) {
		if (candidate?.responseId !== undefined && responseId !== undefined && candidate.responseId !== responseId) {
			return { ok: false, reason: "invalid-compaction-metadata" };
		}
	}
	if (
		doneCandidate?.responseId !== undefined
		&& terminalCandidate?.responseId !== undefined
		&& doneCandidate.responseId !== terminalCandidate.responseId
	) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}
	if (
		doneCandidate?.outputIndex !== undefined
		&& terminalCandidate?.outputPosition !== undefined
		&& doneCandidate.outputIndex !== terminalCandidate.outputPosition
	) {
		return { ok: false, reason: "invalid-compaction-metadata" };
	}

	let checkpoint: CompactionItem;
	if (doneCandidate && terminalCandidate) {
		const merged = mergeItems(doneCandidate.item, terminalCandidate.item);
		if (!merged) return { ok: false, reason: "conflicting-compaction-item" };
		checkpoint = merged;
	} else {
		checkpoint = structuredClone((doneCandidate ?? terminalCandidate)!.item);
	}

	const success: RemoteCompactionSuccess = { ok: true, status: 200, checkpoint };
	if (responseId !== undefined) success.responseId = responseId;
	const createdAt = normalizeTimestamp(completedResponse["created_at"]);
	if (createdAt !== undefined) success.createdAt = createdAt;
	if (isRecord(completedResponse["usage"])) success.usage = structuredClone(completedResponse["usage"]) as RemoteCompactionUsage;
	return success;
}

function normalizeTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
		return new Date(milliseconds).toISOString();
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString();
}

function mergeSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Remote compaction timed out")), timeoutMs);
	timer.unref?.();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableFailure(failure: RemoteCompactionFailure): boolean {
	return failure.reason === "network-error" || failure.reason === "timeout"
		|| (failure.reason === "non-2xx" && (failure.status === 408 || failure.status === 409))
		|| (failure.reason === "non-2xx" && (failure.status ?? 0) >= 500)
		|| (failure.reason === "non-2xx" && failure.status === 429);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		if (!signal) return;
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("aborted"));
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function buildRemoteV2RequestBody(body: Record<string, unknown>): Record<string, unknown> {
	const input = Array.isArray(body["input"]) ? body["input"] : [];
	const clonedInput = (structuredClone(input) as unknown[]).filter((item) => !isRecord(item) || item["type"] !== "compaction_trigger");
	return {
		...structuredClone(body),
		input: [...clonedInput, { type: "compaction_trigger" }],
		store: false,
		stream: true,
	};
}

/** Never surface provider ciphertext; error bodies are truncated plain text. */
function extractUpstreamError(responseText: string): string | undefined {
	if (!responseText.trim()) return undefined;
	try {
		const parsed = JSON.parse(responseText) as unknown;
		const message = isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"]["message"] : undefined;
		if (typeof message === "string" && message.trim()) return redactSensitiveText(message.trim());
	} catch {
		// Do not expose arbitrary upstream bodies: a gateway can echo request items.
	}
	return undefined;
}

interface StreamOutcome {
	result: RemoteCompactionResult;
	retryable: boolean;
}

async function consumeResponseStream(response: Response): Promise<StreamOutcome> {
	const reader = new SseEventReader();
	const body = response.body;
	if (!body) {
		const text = await response.text();
		if (!text.trim()) return { result: { ok: false, reason: "empty-body" }, retryable: false };
		const events = parseSseEvents(text);
		if (!events) return { result: { ok: false, reason: "invalid-sse" }, retryable: false };
		return { result: reconcileCheckpoint(events), retryable: false };
	}

	const decoder = new TextDecoder();
	const streamReader = body.getReader();
	try {
		while (true) {
			const { done, value } = await streamReader.read();
			if (done) break;
			reader.push(decoder.decode(value, { stream: true }));
			if (reader.isInvalid) {
				await streamReader.cancel().catch(() => undefined);
				return { result: { ok: false, reason: "invalid-sse" }, retryable: false };
			}
		}
		reader.push(decoder.decode());
		reader.end();
	} finally {
		// Consume through EOF so events after response.completed cannot be hidden.
		if (!reader.isTerminal || reader.isInvalid) await streamReader.cancel().catch(() => undefined);
	}

	if (reader.isInvalid) return { result: { ok: false, reason: "invalid-sse" }, retryable: false };
	const events = reader.snapshot();
	if (events.length === 0) return { result: { ok: false, reason: "empty-body" }, retryable: false };
	return { result: reconcileCheckpoint(events), retryable: false };
}

export async function executeRemoteCompactionV2(request: RemoteCompactionRequest): Promise<RemoteCompactionResult> {
	const fetchFn = request.fetch ?? globalThis.fetch;
	if (request.signal?.aborted) return { ok: false, reason: "aborted" };
	const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep = request.sleep ?? defaultSleep;
	// The trigger, store:false, and stream:true are protocol invariants owned by
	// this client so no caller can send an ordinary (non-compaction) request.
	const body = buildRemoteV2RequestBody(request.body);
	let lastFailure: RemoteCompactionFailure | undefined;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		request.onAttempt?.(attempt);
		if (attempt > 1) {
			const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 2));
			try {
				await sleep(delay, request.signal);
			} catch {
				return { ok: false, reason: "aborted" };
			}
			if (request.signal?.aborted) return { ok: false, reason: "aborted" };
		}

		const merged = mergeSignals(request.signal, timeoutMs);
		let failure: RemoteCompactionFailure;
		try {
			const response = await fetchFn(request.url, {
				method: "POST",
				headers: request.headers,
				body: JSON.stringify(body),
				signal: merged.signal,
			});
			if (!response.ok) {
				const responseText = await response.text().catch(() => "");
				if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
					failure = { ok: false, reason: "non-2xx", status: response.status };
				} else {
					const result: RemoteCompactionFailure = { ok: false, reason: "non-2xx", status: response.status };
					const detail = extractUpstreamError(responseText);
					if (detail !== undefined) result.errorMessage = detail;
					return result;
				}
			} else {
				const outcome = await consumeResponseStream(response);
				if (outcome.result.ok || !outcome.retryable) {
					return outcome.result.ok ? { ...outcome.result, status: response.status } : { ...outcome.result, status: response.status };
				}
				failure = outcome.result;
			}
		} catch (error) {
			if (request.signal?.aborted) {
				return { ok: false, reason: "aborted" };
			}
			if (merged.signal.aborted) {
				failure = { ok: false, reason: "timeout", errorMessage: "Remote compaction timed out" };
			} else if (isAbortError(error)) {
				return { ok: false, reason: "aborted" };
			} else {
				failure = { ok: false, reason: "network-error", errorMessage: errorMessage(error) };
			}
		} finally {
			merged.dispose();
		}

		lastFailure = failure;
		if (!isRetryableFailure(failure)) return failure;
	}

	return lastFailure ?? { ok: false, reason: "network-error" };
}
