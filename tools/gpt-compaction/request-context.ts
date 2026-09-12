import { requestIdentitiesMatch, type CompactionIdentity } from "./model-eligibility";

/**
 * Explicit allowlist of fields mirrored from the latest live Responses request.
 * A synthetic v2 compaction request cannot observe Pi's provider payload, so it
 * reuses only these compact-relevant fields for the same runtime identity.
 * `stream`, `store`, `input`, `instructions`, and the trigger are always forced
 * separately by the client.
 */
export interface CompactionRequestExtras {
	tools?: unknown[];
	parallel_tool_calls?: boolean;
	reasoning?: Record<string, unknown>;
	service_tier?: string;
	text?: Record<string, unknown>;
	max_output_tokens?: number;
	prompt_cache_key?: string;
}

interface CachedRequestContext {
	identity: CompactionIdentity;
	sessionId?: string;
	extras: CompactionRequestExtras;
}

const cached = new Map<string, CachedRequestContext>();

function cacheKey(identity: CompactionIdentity, sessionId?: string): string {
	return `${sessionId ?? "sessionless"}:${identity.provider}:${identity.api}:${identity.model}:${identity.baseUrl}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

/**
 * Remember compact-relevant fields from a live Responses payload. Failures are
 * swallowed: caching must never break the provider request path.
 */
export function rememberRequestContext(
	payload: unknown,
	identity: CompactionIdentity,
	sessionId?: string,
): void {
	try {
		if (!isRecord(payload) || payload["model"] !== identity.model) {
			cached.delete(cacheKey(identity, sessionId));
			return;
		}
		const extras: CompactionRequestExtras = {};
		if (Array.isArray(payload["tools"])) extras.tools = clone(payload["tools"]);
		if (typeof payload["parallel_tool_calls"] === "boolean") extras.parallel_tool_calls = payload["parallel_tool_calls"];
		if (isRecord(payload["reasoning"])) extras.reasoning = clone(payload["reasoning"]);
		if (typeof payload["service_tier"] === "string" && payload["service_tier"].trim()) extras.service_tier = payload["service_tier"];
		if (isRecord(payload["text"])) extras.text = clone(payload["text"]);
		if (typeof payload["max_output_tokens"] === "number" && Number.isFinite(payload["max_output_tokens"])) {
			extras.max_output_tokens = payload["max_output_tokens"];
		}
		if (typeof payload["prompt_cache_key"] === "string" && payload["prompt_cache_key"].trim()) {
			extras.prompt_cache_key = payload["prompt_cache_key"];
		}
		const record: CachedRequestContext = { identity: clone(identity), extras };
		if (sessionId) record.sessionId = sessionId;
		const key = cacheKey(identity, sessionId);
		cached.set(key, record);
		while (cached.size > 32) cached.delete(cached.keys().next().value as string);
	} catch {
		cached.delete(cacheKey(identity, sessionId));
	}
}

/**
 * Look up extras for the exact live-request identity. A mismatched identity or
 * session returns undefined so the synthetic request never inherits unrelated
 * tool definitions or cache keys.
 */
export function getCompactionRequestExtras(
	identity: CompactionIdentity,
	sessionId?: string,
): CompactionRequestExtras | undefined {
	const record = cached.get(cacheKey(identity, sessionId));
	if (!record || !requestIdentitiesMatch(record.identity, identity)) return undefined;
	if (record.sessionId !== sessionId) return undefined;
	try {
		return clone(record.extras);
	} catch {
		return undefined;
	}
}

export function clearRequestContextCache(sessionId?: string): void {
	if (sessionId === undefined) {
		cached.clear();
		return;
	}
	for (const [key, record] of cached) {
		if (record.sessionId === sessionId) cached.delete(key);
	}
}
