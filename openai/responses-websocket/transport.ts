import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import WebSocket, { type RawData } from "ws";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";

const require = createRequire(import.meta.url);
const { HttpsProxyAgent } = require("https-proxy-agent") as typeof import("https-proxy-agent");
const { getProxyForUrl } = require("proxy-from-env") as typeof import("proxy-from-env");

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const CONNECTION_IDLE_TTL_MS = 5 * 60 * 1000;
const CONNECTION_MAX_AGE_MS = 55 * 60 * 1000;
const MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

type RequestBody = Record<string, unknown> & { input?: unknown; previous_response_id?: string };

interface Continuation {
	lastRequestBody: RequestBody;
	lastResponseId: string;
	lastResponseItems: unknown[];
}

interface ConnectionEntry {
	socket: WebSocket;
	response: WebSocketUpgradeResponse;
	busy: boolean;
	createdAt: number;
	idleTimer?: NodeJS.Timeout | undefined;
	continuation?: Continuation | undefined;
}

interface AcquiredConnection {
	socket: WebSocket;
	response: WebSocketUpgradeResponse;
	entry?: ConnectionEntry;
	reused: boolean;
	release(options?: { keep?: boolean }): void;
}

interface WebSocketUpgradeResponse {
	status: number;
	headers: Record<string, string>;
}

export interface ResponsesWebSocketStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastPreviousResponseId?: string;
}

export interface ResponsesWebSocketRequestOptions {
	endpoint: string;
	provider: string;
	apiKey?: string;
	headers?: Record<string, string | null>;
	sessionId?: string;
	signal?: AbortSignal;
	idleTimeoutMs?: number;
	connectTimeoutMs?: number;
	useCachedContext: boolean;
	responseItems(outputResponseId: string): unknown[];
	onStart(): void;
	onEvent?(event: ResponseStreamEvent): void;
}

const connectionCache = new Map<string, Map<string, ConnectionEntry>>();
const debugStats = new Map<string, ResponsesWebSocketStats>();

export class ResponsesWebSocketError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly payload?: unknown,
	) {
		super(message);
		this.name = "ResponsesWebSocketError";
	}
}

export class ResponsesWebSocketHandshakeError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ResponsesWebSocketHandshakeError";
	}
}

export function isSafeResponsesWebSocketFallback(error: unknown): boolean {
	if (error instanceof ResponsesWebSocketHandshakeError) return true;
	if (!(error instanceof ResponsesWebSocketError)) return false;
	return error.code === "model_not_found"
		|| /(?:no available|无可用).*(?:channel|distributor|渠道)/iu.test(error.message);
}

export function isResponsesWebSocketContinuationError(error: unknown): boolean {
	if (!(error instanceof ResponsesWebSocketError)) return false;
	return error.code === "previous_response_not_found"
		|| error.code === "response_not_found"
		|| /previous[_ ]response.*not found/iu.test(error.message);
}

export function resolveResponsesWebSocketProxy(endpoint: string): string | undefined {
	const websocketProxy = getProxyForUrl(endpoint);
	if (websocketProxy) return websocketProxy;
	const lookupUrl = new URL(endpoint);
	if (lookupUrl.protocol === "wss:") lookupUrl.protocol = "https:";
	else if (lookupUrl.protocol === "ws:") lookupUrl.protocol = "http:";
	return getProxyForUrl(lookupUrl.toString()) || undefined;
}

function credentialFingerprint(apiKey: string | undefined): string {
	return createHash("sha256").update(apiKey ?? "").digest("hex").slice(0, 24);
}

function stableHeadersFingerprint(headers: Record<string, string | null> | undefined): string {
	const entries = Object.entries(headers ?? {})
		.map(([key, value]) => [key.toLowerCase(), value] as const)
		.sort(([left], [right]) => left.localeCompare(right));
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 24);
}

function connectionIdentity(options: ResponsesWebSocketRequestOptions): string {
	return [
		options.provider,
		options.endpoint,
		credentialFingerprint(options.apiKey),
		stableHeadersFingerprint(options.headers),
	].join("\0");
}

function statsFor(sessionId: string): ResponsesWebSocketStats {
	let stats = debugStats.get(sessionId);
	if (!stats) {
		stats = { requests: 0, connectionsCreated: 0, connectionsReused: 0, fullContextRequests: 0, deltaRequests: 0 };
		debugStats.set(sessionId, stats);
	}
	return stats;
}

export function getRailResponsesWebSocketStats(sessionId: string): ResponsesWebSocketStats | undefined {
	const stats = debugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

export function resetRailResponsesWebSocketStats(sessionId?: string): void {
	if (sessionId) debugStats.delete(sessionId);
	else debugStats.clear();
}

function closeSilently(socket: WebSocket, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {
		// Best-effort cleanup.
	}
}

function isReusable(socket: WebSocket): boolean {
	return socket.readyState === WebSocket.OPEN;
}

function removeEntry(sessionId: string, identity: string, entry: ConnectionEntry): void {
	const entries = connectionCache.get(sessionId);
	if (entries?.get(identity) === entry) entries.delete(identity);
	if (entries?.size === 0) connectionCache.delete(sessionId);
}

function scheduleExpiry(sessionId: string, identity: string, entry: ConnectionEntry): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		closeSilently(entry.socket, 1000, "idle_timeout");
		removeEntry(sessionId, identity, entry);
	}, CONNECTION_IDLE_TTL_MS);
	entry.idleTimer.unref?.();
}

export function closeRailResponsesWebSocketSessions(sessionId?: string): void {
	const closeEntry = (entry: ConnectionEntry) => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeSilently(entry.socket, 1000, "session_cleanup");
	};
	if (sessionId) {
		for (const entry of connectionCache.get(sessionId)?.values() ?? []) closeEntry(entry);
		connectionCache.delete(sessionId);
		return;
	}
	for (const entries of connectionCache.values()) for (const entry of entries.values()) closeEntry(entry);
	connectionCache.clear();
}

function headersForRequest(apiKey: string | undefined, headers: Record<string, string | null> | undefined, requestId: string): Record<string, string> {
	const result: Record<string, string> = {};
	const names = new Map<string, string>();
	const setHeader = (key: string, value: string) => {
		const lower = key.toLowerCase();
		const previous = names.get(lower);
		if (previous) delete result[previous];
		names.set(lower, key);
		result[key] = value;
	};
	const setDefaultHeader = (key: string, value: string) => {
		if (!names.has(key.toLowerCase())) setHeader(key, value);
	};
	for (const [key, value] of Object.entries(headers ?? {})) {
		const lower = key.toLowerCase();
		const previous = names.get(lower);
		if (previous) delete result[previous];
		names.set(lower, key);
		if (value !== null) result[key] = value;
	}
	const hasUsableHeader = (name: string) => {
		const key = names.get(name.toLowerCase());
		return key !== undefined && typeof result[key] === "string" && result[key].trim().length > 0;
	};
	if (!names.has("authorization") && apiKey) {
		setHeader("Authorization", `Bearer ${apiKey}`);
	}
	if (!hasUsableHeader("authorization") && !hasUsableHeader("cf-aig-authorization")) {
		throw new Error("No API key or authorization header for Responses WebSocket");
	}
	setDefaultHeader("OpenAI-Beta", "responses_websockets=2026-02-06");
	setDefaultHeader("User-Agent", "pi-rail-ui/openai-responses-websocket");
	setDefaultHeader("x-client-request-id", requestId);
	setDefaultHeader("session-id", requestId);
	return result;
}

function monitorCachedConnection(sessionId: string, identity: string, entry: ConnectionEntry): void {
	entry.socket.on("error", () => {
		delete entry.continuation;
		removeEntry(sessionId, identity, entry);
		if (!entry.busy) closeSilently(entry.socket, 1011, "socket_error");
	});
	entry.socket.on("close", () => {
		delete entry.continuation;
		removeEntry(sessionId, identity, entry);
	});
}

async function connectWebSocket(
	endpoint: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<{ socket: WebSocket; response: WebSocketUpgradeResponse }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		let socket: WebSocket;
		let response: WebSocketUpgradeResponse = { status: 101, headers: {} };
		try {
			const proxy = resolveResponsesWebSocketProxy(endpoint);
			socket = new WebSocket(endpoint, {
				headers,
				...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
			});
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			reject(new ResponsesWebSocketHandshakeError(cause.message, { cause }));
			return;
		}
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			socket.off("open", onOpen);
			socket.off("upgrade", onUpgrade);
			socket.off("error", onError);
			socket.off("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error, closeReason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (closeReason) {
				const suppressLateError = () => undefined;
				socket.on("error", suppressLateError);
				socket.once("close", () => socket.off("error", suppressLateError));
				if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
				else closeSilently(socket, 1000, closeReason);
			}
			reject(new ResponsesWebSocketHandshakeError(error.message, { cause: error }));
		};
		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ socket, response });
		};
		const onUpgrade = (upgrade: import("node:http").IncomingMessage) => {
			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(upgrade.headers)) {
				if (typeof value === "string") headers[key] = value;
				else if (Array.isArray(value)) headers[key] = value.join(", ");
			}
			response = { status: upgrade.statusCode ?? 101, headers };
		};
		const onError = (error: Error) => fail(error);
		const onClose = (code: number, reason: Buffer) => fail(webSocketCloseError(code, reason.toString()));
		const onAbort = () => fail(new Error("Request was aborted"), "aborted");
		socket.once("open", onOpen);
		socket.once("upgrade", onUpgrade);
		socket.once("error", onError);
		socket.once("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (connectTimeoutMs > 0) {
			timeout = setTimeout(() => fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout"), connectTimeoutMs);
			timeout.unref?.();
		}
		if (signal?.aborted) onAbort();
	});
}

async function acquireConnection(options: ResponsesWebSocketRequestOptions): Promise<AcquiredConnection> {
	const requestId = options.sessionId ?? crypto.randomUUID();
	const headers = headersForRequest(options.apiKey, options.headers, requestId);
	if (!options.sessionId) {
		const connected = await connectWebSocket(options.endpoint, headers, options.signal, options.connectTimeoutMs);
		return { ...connected, reused: false, release: () => closeSilently(connected.socket) };
	}
	const identity = connectionIdentity(options);
	let entries = connectionCache.get(options.sessionId);
	const cached = entries?.get(identity);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			delete cached.idleTimer;
		}
		if (!cached.busy && Date.now() - cached.createdAt >= CONNECTION_MAX_AGE_MS) {
			closeSilently(cached.socket, 1000, "connection_age_limit");
			removeEntry(options.sessionId, identity, cached);
		} else if (!cached.busy && isReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				response: cached.response,
				entry: cached,
				reused: true,
				release: ({ keep } = {}) => {
					if (!keep || !isReusable(cached.socket)) {
						closeSilently(cached.socket);
						removeEntry(options.sessionId!, identity, cached);
						return;
					}
					cached.busy = false;
					scheduleExpiry(options.sessionId!, identity, cached);
				},
			};
		} else if (!cached.busy) {
			closeSilently(cached.socket);
			removeEntry(options.sessionId, identity, cached);
		}
	}
	const connected = await connectWebSocket(options.endpoint, headers, options.signal, options.connectTimeoutMs);
	entries = connectionCache.get(options.sessionId);
	if (entries?.has(identity)) {
		return { ...connected, reused: false, release: () => closeSilently(connected.socket) };
	}
	const entry: ConnectionEntry = { ...connected, busy: true, createdAt: Date.now(), idleTimer: undefined, continuation: undefined };
	entries = connectionCache.get(options.sessionId);
	if (!entries) {
		entries = new Map();
		connectionCache.set(options.sessionId, entries);
	}
	entries.set(identity, entry);
	monitorCachedConnection(options.sessionId, identity, entry);
	return {
		socket: connected.socket,
		response: connected.response,
		entry,
		reused: false,
		release: ({ keep } = {}) => {
			if (!keep || !isReusable(entry.socket)) {
				closeSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				removeEntry(options.sessionId!, identity, entry);
				return;
			}
			entry.busy = false;
			scheduleExpiry(options.sessionId!, identity, entry);
		},
	};
}

function webSocketCloseError(code: number, reason: string): Error {
	const detail = reason || (code === MESSAGE_TOO_BIG_CLOSE_CODE ? "message too big" : "");
	return new Error(`WebSocket closed ${code}${detail ? ` ${detail}` : ""}`);
}

function decodeRawData(data: RawData): string {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return data.toString("utf8");
}

function createEventStream(
	socket: WebSocket,
	signal: AbortSignal | undefined,
	idleTimeoutMs: number | undefined,
	onEvent?: (event: ResponseStreamEvent) => void,
): { events: AsyncGenerator<ResponseStreamEvent>; dispose(): void } {
	const queue: ResponseStreamEvent[] = [];
	let wake: (() => void) | undefined;
	let done = false;
	let failure: Error | undefined;
	let sawTerminal = false;
	const notify = () => {
		const pending = wake;
		wake = undefined;
		pending?.();
	};
	const onMessage = (data: RawData) => {
		try {
			const parsed = JSON.parse(decodeRawData(data)) as ResponseStreamEvent;
			try {
				onEvent?.(parsed);
			} catch {
				// Event observation must not affect the provider stream.
			}
			const type = typeof parsed.type === "string" ? String(parsed.type) : "";
			if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
				sawTerminal = true;
				done = true;
			}
			queue.push(parsed);
			notify();
		} catch (error) {
			failure = new Error(`Invalid Responses WebSocket JSON: ${error instanceof Error ? error.message : String(error)}`);
			done = true;
			notify();
		}
	};
	const onError = (error: Error) => {
		failure = error;
		done = true;
		notify();
	};
	const onClose = (code: number, reason: Buffer) => {
		if (!sawTerminal && !failure) failure = webSocketCloseError(code, reason.toString());
		done = true;
		notify();
	};
	const onAbort = () => {
		failure = new Error("Request was aborted");
		done = true;
		notify();
	};
	socket.on("message", onMessage);
	socket.on("error", onError);
	socket.on("close", onClose);
	signal?.addEventListener("abort", onAbort, { once: true });
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		socket.off("message", onMessage);
		socket.off("error", onError);
		socket.off("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	};
	const events = (async function* () {
		try {
			for (;;) {
				if (signal?.aborted) throw new Error("Request was aborted");
				if (queue.length > 0) {
					yield queue.shift()!;
					continue;
				}
				if (done) break;
				let timeout: NodeJS.Timeout | undefined;
				await new Promise<void>((resolve, reject) => {
					wake = resolve;
					if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
						timeout = setTimeout(() => {
							const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
							failure = error;
							done = true;
							wake = undefined;
							closeSilently(socket, 1000, "idle_timeout");
							reject(error);
						}, idleTimeoutMs);
						timeout.unref?.();
					}
				}).finally(() => {
					if (timeout) clearTimeout(timeout);
				});
			}
			if (failure) throw failure;
			if (!sawTerminal) throw new Error("WebSocket stream closed before response.completed");
		} finally {
			dispose();
		}
	})();
	return { events, dispose };
}

async function* normalizedEvents(events: AsyncIterable<ResponseStreamEvent>): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = String(event.type);
		if (type === "error") {
			const payload = event as unknown as { error?: { code?: string; message?: string }; code?: string; message?: string };
			const code = payload.code ?? payload.error?.code;
			const message = payload.message ?? payload.error?.message;
			throw new ResponsesWebSocketError(message || code || "Responses WebSocket error", code, event);
		}
		if (type === "response.failed") {
			const payload = event as unknown as { response?: { error?: { code?: string; message?: string } } };
			throw new ResponsesWebSocketError(payload.response?.error?.message ?? "Responses WebSocket response failed", payload.response?.error?.code, event);
		}
		if (type === "response.done" || type === "response.incomplete") {
			yield { ...event, type: "response.completed" } as ResponseStreamEvent;
			return;
		}
		yield event;
		if (type === "response.completed") return;
	}
}

function requestWithoutInput(body: RequestBody): Record<string, unknown> {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function inputDelta(body: RequestBody, continuation: Continuation): unknown[] | undefined {
	if (JSON.stringify(requestWithoutInput(body)) !== JSON.stringify(requestWithoutInput(continuation.lastRequestBody))) return undefined;
	if (!Array.isArray(body.input) || !Array.isArray(continuation.lastRequestBody.input)) return undefined;
	const current = body.input;
	const previous = continuation.lastRequestBody.input;
	const baseline = [...previous, ...continuation.lastResponseItems];
	if (current.length < baseline.length) return undefined;
	if (JSON.stringify(current.slice(0, baseline.length)) !== JSON.stringify(baseline)) return undefined;
	return current.slice(baseline.length);
}

function cachedRequestBody(entry: ConnectionEntry, body: RequestBody): RequestBody {
	if (body.previous_response_id !== undefined) return body;
	if (!entry.continuation) return body;
	const delta = inputDelta(body, entry.continuation);
	if (!delta) {
		delete entry.continuation;
		return body;
	}
	return { ...body, previous_response_id: entry.continuation.lastResponseId, input: delta };
}

export async function runResponsesWebSocketRequest(
	body: RequestBody,
	options: ResponsesWebSocketRequestOptions,
): Promise<{
	events: AsyncIterable<ResponseStreamEvent>;
	finalize(responseId: string | undefined): void;
	reused: boolean;
	requestBody: RequestBody;
	response: WebSocketUpgradeResponse;
}> {
	if (options.signal?.aborted) throw new Error("Request was aborted");
	const acquired = await acquireConnection(options);
	if (options.signal?.aborted) {
		acquired.release({ keep: false });
		throw new Error("Request was aborted");
	}
	const { type: _protocolType, ...createBody } = body;
	const requestBody = options.useCachedContext && acquired.entry ? cachedRequestBody(acquired.entry, createBody) : createBody;
	const stats = options.sessionId ? statsFor(options.sessionId) : undefined;
	if (stats) {
		stats.requests++;
		if (acquired.reused) stats.connectionsReused++;
		else stats.connectionsCreated++;
		if (requestBody.previous_response_id) {
			stats.deltaRequests++;
			stats.lastPreviousResponseId = requestBody.previous_response_id;
		} else {
			stats.fullContextRequests++;
			delete stats.lastPreviousResponseId;
		}
	}
	const eventStream = createEventStream(acquired.socket, options.signal, options.idleTimeoutMs, options.onEvent);
	if (options.signal?.aborted) {
		eventStream.dispose();
		acquired.release({ keep: false });
		throw new Error("Request was aborted");
	}
	try {
		acquired.socket.send(JSON.stringify({ ...requestBody, type: "response.create" }));
	} catch (error) {
		eventStream.dispose();
		acquired.release({ keep: false });
		throw error;
	}
	let started = false;
	let finished = false;
	const events = (async function* () {
		try {
			for await (const event of normalizedEvents(eventStream.events)) {
				if (!started) {
					started = true;
					options.onStart();
				}
				yield event;
			}
			finished = true;
		} catch (error) {
			if (acquired.entry) delete acquired.entry.continuation;
			throw error;
		}
	})();
	return {
		events,
		reused: acquired.reused,
		requestBody,
		response: acquired.response,
		finalize: (responseId) => {
			let keep = finished && !options.signal?.aborted;
			if (keep && options.useCachedContext && acquired.entry && responseId) {
				acquired.entry.continuation = {
					lastRequestBody: createBody,
					lastResponseId: responseId,
					lastResponseItems: options.responseItems(responseId),
				};
			} else if (acquired.entry) {
				delete acquired.entry.continuation;
			}
			if (!finished) keep = false;
			acquired.release({ keep });
		},
	};
}