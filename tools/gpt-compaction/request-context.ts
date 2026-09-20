import { isDeepStrictEqual } from "node:util";
import { getCurrentTools, hasApi, toToolDeclaration, type Api, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
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
	/** Declaration provenance, not wire tools: provider hooks may transform schemas. */
	tools?: Tool[];
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
	messages?: readonly Message[],
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
		if (messages?.some((message) => message.role === "system")) {
			record.tools = clone(getCurrentTools([...messages]).map(toToolDeclaration));
		}
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

/**
 * Collapse transcript tool deltas into a complete Responses loadout. Never copy
 * raw declarations into the wire payload. Stable declarations keep their exact
 * provider formatting; hosted tools and non-tool extras remain provider-owned.
 * Without provenance, only an exact canonical wire match is safe to reuse.
 */
export function resolveCompactionRequestExtras(
	model: Model<Api>,
	identity: CompactionIdentity,
	sessionId: string | undefined,
	messages: readonly Message[],
): CompactionRequestExtras {
	const extras = getCompactionRequestExtras(identity, sessionId) ?? {};
	// Legacy sessions have no declaration state; retain the old payload behavior.
	if (!messages.some((message) => message.role === "system")) return extras;
	const record = cached.get(cacheKey(identity, sessionId));
	const previous = record && requestIdentitiesMatch(record.identity, identity) && record.sessionId === sessionId
		? record.tools : undefined;
	const current = getCurrentTools([...messages]);
	const byName = new Map(current.map((tool) => [tool.name, tool]));
	const previousByName = new Map(previous?.map((tool) => [tool.name, tool]));
	const codex = model.api === "openai-codex-responses";
	const compat = hasApi(model, "openai-responses") || hasApi(model, "openai-codex-responses") || hasApi(model, "azure-openai-responses")
		? model.compat : undefined;
	const convert = (tool: Tool): unknown => convertResponsesTools([tool], {
		// Synthetic requests must not opt into server-inferred strict schemas
		// (Codex's ordinary default is null). Explicit constrained sampling still
		// goes through Pi's converter and can opt individual tools into strict.
		strict: false,
		supportsStrictMode: compat?.supportsStrictMode ?? codex,
		supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
	})[0];
	const tools: unknown[] = [];
	for (const wire of extras.tools ?? []) {
		if (!isRecord(wire)) continue;
		const local = wire["type"] === "function" || wire["type"] === "custom"
			|| (wire["type"] === undefined && typeof wire["name"] === "string");
		if (!local) {
			tools.push(wire);
			continue;
		}
		const name = wire["name"];
		if (typeof name !== "string") continue;
		const tool = byName.get(name);
		if (!tool) continue;
		const old = previousByName.get(name);
		const stable = old && isDeepStrictEqual(toToolDeclaration(old), toToolDeclaration(tool));
		const converted = stable ? undefined : convert(tool);
		tools.push(stable || isDeepStrictEqual(wire, converted) ? wire : converted);
		byName.delete(name);
	}
	// Tool-search/additional-tools transports may have omitted later declarations
	// from the top-level tools. Synthetic input has no such anchors: declare all.
	for (const tool of byName.values()) tools.push(convert(tool));
	// Rail's hosted search hook replaces the local web_search function. Restoring
	// transcript declarations must not undo that policy, even after tool changes.
	// Do not treat other omitted tools as suppressed: additive transports omit
	// declarations from top-level tools too, and those still need reconstruction.
	const hostedSearch = tools.some((tool) => isRecord(tool) && typeof tool["type"] === "string"
		&& /^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/.test(tool["type"]));
	const effectiveTools = hostedSearch
		? tools.filter((tool) => !isRecord(tool) || tool["type"] !== "function" || tool["name"] !== "web_search")
		: tools;
	// Non-strict conversion can return the transcript's original schema object.
	// Neither callers nor provider hooks may mutate session declaration state.
	return clone({ ...extras, tools: effectiveTools });
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
