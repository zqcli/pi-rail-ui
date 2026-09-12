import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { compactionIdentity, normalizeBaseUrl, type CompactionIdentity } from "./model-eligibility";

export type CompactionAuthFailureReason =
	| "missing-model"
	| "auth-resolution-failed"
	| "missing-api-key"
	| "missing-base-url";

export type CompactionAuthResult =
	| {
			ok: true;
			apiKey?: string;
			baseUrl: string;
			headers: Record<string, string> | undefined;
			identity: CompactionIdentity;
	  }
	| { ok: false; reason: CompactionAuthFailureReason; detail: string };

function stripNullHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === "string" && value.length > 0) out[name] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (key.toLowerCase() === expected && value.trim()) return value.trim();
	}
	return undefined;
}

function credentialScope(apiKey: string | undefined, headers: Record<string, string> | undefined): string | undefined {
	const accountId = headerValue(headers, "chatgpt-account-id")
		?? headerValue(headers, "chatgpt_account_id")
		?? (apiKey ? extractChatGptAccountId(apiKey) : undefined);
	if (accountId) return `account:${accountId}`;
	const authorization = headerValue(headers, "authorization");
	if (authorization) return `authorization:${authorization}`;
	if (apiKey) return `api-key:${apiKey}`;
	for (const [key, value] of Object.entries(headers ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
		if (/api[-_]?key|token|credential|auth/iu.test(key) && value.trim()) return `${key.toLowerCase()}:${value.trim()}`;
	}
	return undefined;
}

function withAuthIdentity(
	model: Model<Api>,
	baseUrl: string,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
): CompactionIdentity {
	const identity = compactionIdentity(model);
	const scope = credentialScope(apiKey, headers);
	return {
		...identity,
		baseUrl,
		...(scope ? { authFingerprint: createHash("sha256").update(scope).digest("hex") } : {}),
	};
}

/**
 * Resolve the exact auth Pi would use for this model. Custom Responses gateways
 * can supply their own baseUrl/headers/key, so nothing here may hardcode the
 * official OpenAI endpoint or credential shape.
 */
export async function resolveCompactionAuth(
	ctx: ExtensionContext,
	model: Model<Api>,
): Promise<CompactionAuthResult> {
	let resolution: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
	try {
		resolution = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch (error) {
		return {
			ok: false,
			reason: "auth-resolution-failed",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	if (!resolution.ok) {
		return { ok: false, reason: "auth-resolution-failed", detail: resolution.error };
	}
	const baseUrl = normalizeBaseUrl(resolution.baseUrl ?? model.baseUrl ?? "");
	if (!baseUrl) return { ok: false, reason: "missing-base-url", detail: `${model.provider}/${model.id} has no base URL` };
	const headers = stripNullHeaders(resolution.headers);
	if (!resolution.apiKey && !headerValue(headers, "authorization") && !headerValue(headers, "api-key") && !headerValue(headers, "x-api-key")) {
		return { ok: false, reason: "missing-api-key", detail: `${model.provider}/${model.id} has no usable authentication` };
	}
	return {
		ok: true,
		...(resolution.apiKey ? { apiKey: resolution.apiKey } : {}),
		baseUrl,
		headers,
		identity: withAuthIdentity(model, baseUrl, resolution.apiKey, headers),
	};
}

/**
 * Build the `/responses` URL for the API family. `openai-codex-responses` uses
 * the `/codex/responses` suffix; another other Responses-family API uses the
 * plain `/responses` path.
 */
export function buildResponsesUrl(baseUrl: string, api: string): string {
	const normalized = normalizeBaseUrl(baseUrl);
	try {
		const url = new URL(normalized);
		const path = url.pathname.replace(/\/+$/u, "");
		if (api === "openai-codex-responses") {
			if (!path.endsWith("/codex/responses")) url.pathname = path.endsWith("/codex") ? `${path}/responses` : `${path}/codex/responses`;
		} else if (!path.endsWith("/responses")) {
			url.pathname = `${path}/responses`;
		}
		return url.toString();
	} catch {
		if (api === "openai-codex-responses") {
			if (normalized.endsWith("/codex/responses")) return normalized;
			if (normalized.endsWith("/codex")) return `${normalized}/responses`;
			return `${normalized}/codex/responses`;
		}
		if (normalized.endsWith("/responses")) return normalized;
		return `${normalized}/responses`;
	}
}

export function buildCompactionHeaders(args: {
	auth: Extract<CompactionAuthResult, { ok: true }>;
	sessionId?: string;
}): Record<string, string> {
	const headers = new Headers();
	for (const [name, value] of Object.entries(args.auth.headers ?? {})) headers.set(name, value);
	if (!headers.has("authorization") && args.auth.apiKey) headers.set("authorization", `Bearer ${args.auth.apiKey}`);
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (args.auth.identity.api === "openai-codex-responses") {
		headers.set("originator", "pi");
		if (!headers.has("chatgpt-account-id") && !headers.has("chatgpt_account_id")) {
			const accountId = args.auth.apiKey ? extractChatGptAccountId(args.auth.apiKey) : undefined;
			if (accountId) headers.set("chatgpt-account-id", accountId);
		}
		headers.set("openai-beta", "responses=experimental");
		if (args.sessionId) {
			headers.set("session-id", args.sessionId);
			headers.set("x-client-request-id", args.sessionId);
		}
	} else if (args.sessionId) {
		headers.set("x-client-request-id", args.sessionId);
	}
	return Object.fromEntries(headers.entries());
}

function extractChatGptAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
		if (!payload || typeof payload !== "object") return undefined;
		const authClaims = (payload as Record<string, unknown>)["https://api.openai.com/auth"];
		if (!authClaims || typeof authClaims !== "object") return undefined;
		const accountId = (authClaims as Record<string, unknown>)["chatgpt_account_id"];
		return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function resolveSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}
