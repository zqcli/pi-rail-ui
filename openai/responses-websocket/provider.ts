import { fileURLToPath } from "node:url";
import {
	AssistantMessageEventStream,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	registerSessionResourceCleanup,
	type Api,
	type AssistantMessage,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import type { OpenAIResponsesOptions } from "@earendil-works/pi-ai/api/openai-responses";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import {
	getDeclaredTools,
	normalizeContext,
	resolveTranscript,
	resolveTranscriptTools,
} from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { observeActiveHostedSearchEvent } from "../hosted-search-activity";
import {
	readRailResponsesWebSocketSettings,
	routeMatchesModel,
	type RailResponsesWebSocketRoute,
} from "./settings";
import {
	closeRailResponsesWebSocketSessions,
	isResponsesWebSocketContinuationError,
	isSafeResponsesWebSocketFallback,
	runResponsesWebSocketRequest,
} from "./transport";

const INSTALL_EVENT = "rail-openai-responses-ws:install";
const RESPONSES_API = "openai-responses";
const RESPONSE_MIN_OUTPUT_TOKENS = 16;
const BASE_TOOL_CALL_PROVIDERS = ["openai", "openai-codex", "opencode"];

type InstallClaim = { claimed: boolean };
type RequestBody = Record<string, unknown> & { input?: unknown[]; previous_response_id?: string };
type ProviderLease = {
	providerId: string;
	previousConfig: ProviderConfig | undefined;
	wrapper: NonNullable<ProviderConfig["streamSimple"]>;
};

export function resolveResponsesWebSocketCache(options: OpenAIResponsesOptions | undefined): {
	useCachedContext: boolean;
	sessionId?: string;
} {
	const useCachedContext = options?.cacheRetention !== "none"
		&& (options?.transport === "websocket-cached" || options?.transport === "auto" || options?.transport === undefined);
	return {
		useCachedContext,
		...(useCachedContext && options?.sessionId ? { sessionId: options.sessionId } : {}),
	};
}

function claimSharedInstall(pi: ExtensionAPI): boolean {
	const claim: InstallClaim = { claimed: false };
	pi.events.emit(INSTALL_EVENT, claim);
	if (claim.claimed) return false;
	pi.events.on(INSTALL_EVENT, (data) => {
		if (data && typeof data === "object" && "claimed" in data) (data as InstallClaim).claimed = true;
	});
	return true;
}

export function railResponsesWebSocketExtensionPath(): string {
	return fileURLToPath(new URL("./standalone-extension.ts", import.meta.url));
}

function getCompat(model: Model<Api>) {
	const compat = model.compat as Record<string, unknown> | undefined;
	return {
		supportsMidConvoSystemMessages: compat?.["supportsMidConvoSystemMessages"] === true,
		supportsLongCacheRetention: compat?.["supportsLongCacheRetention"] !== false,
		supportsStrictMode: compat?.["supportsStrictMode"] === true,
		supportsOpenAIGrammarTools: compat?.["supportsOpenAIGrammarTools"] === true,
		supportsAdditionalTools: compat?.["supportsAdditionalTools"] === true,
		supportsToolSearch: compat?.["supportsToolSearch"] === true,
		supportsExplicitPromptCacheMode: compat?.["supportsExplicitPromptCacheMode"] === true,
		supportsMaxOutputTokens: compat?.["supportsMaxOutputTokens"] !== false,
	};
}

function toolCallProviders(model: Model<Api>): ReadonlySet<string> {
	return new Set([...BASE_TOOL_CALL_PROVIDERS, model.provider]);
}

function getPromptCacheRetention(compat: ReturnType<typeof getCompat>, cacheRetention: SimpleStreamOptions["cacheRetention"]): string | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

function getPromptCacheOptions(compat: ReturnType<typeof getCompat>, cacheRetention: SimpleStreamOptions["cacheRetention"]): Record<string, string> | undefined {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	return undefined;
}

function resolveCacheRetention(options: OpenAIResponsesOptions | undefined): NonNullable<OpenAIResponsesOptions["cacheRetention"]> {
	if (options?.cacheRetention) return options.cacheRetention;
	return getProviderEnvValue("PI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short";
}

function buildRequestBody(
	model: Model<Api>,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	grammarToolInputProperties: ReadonlyMap<string, string>,
): RequestBody {
	const compat = getCompat(model);
	const transcriptTools = resolveTranscriptTools(context.messages, compat.supportsAdditionalTools || compat.supportsToolSearch);
	const messages = convertResponsesMessages(model, context, toolCallProviders(model), {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});
	const cacheRetention = resolveCacheRetention(options);
	const body: RequestBody = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: getPromptCacheOptions(compat, cacheRetention),
		store: false,
	};
	if (options?.maxTokens && compat.supportsMaxOutputTokens) {
		body["max_output_tokens"] = Math.max(options.maxTokens, RESPONSE_MIN_OUTPUT_TOKENS);
	}
	if (options?.temperature !== undefined) body["temperature"] = options.temperature;
	if (options?.serviceTier !== undefined) body["service_tier"] = options.serviceTier;
	if (transcriptTools.requestTools.length > 0) {
		body["tools"] = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}
	if (options?.toolChoice !== undefined) body["tool_choice"] = options.toolChoice;
	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			body["reasoning"] = { effort, summary: options.reasoningSummary ?? "auto" };
			body["include"] = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			body["reasoning"] = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	}
	if (options?.samplingParams) Object.assign(body, options.samplingParams);
	return body;
}

function getServiceTierCostMultiplier(model: Model<Api>, serviceTier: unknown): number {
	if (serviceTier === "flex") return 0.5;
	if (serviceTier === "priority") return model.id === "gpt-5.5" ? 2.5 : 2;
	return 1;
}

function applyServiceTierPricing(usage: Usage, serviceTier: unknown, model: Model<Api>): void {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function forwardFallback(
	stream: AssistantMessageEventStream,
	fallback: Provider["stream"],
	model: Model<Api>,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	body: RequestBody,
): Promise<void> {
	const fallbackStream = fallback(model, context, {
		...options,
		onPayload: () => body,
	} as StreamOptions);
	for await (const event of fallbackStream) stream.push(event);
	stream.end();
}

export function streamResponsesWebSocketRoute(
	route: RailResponsesWebSocketRoute,
	fallback: Provider["stream"],
	model: Model<Api>,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);
	void (async () => {
		const output = createOutput(model);
		let started = false;
		let request: Awaited<ReturnType<typeof runResponsesWebSocketRequest>> | undefined;
		let body: RequestBody | undefined;
		try {
			const cache = resolveResponsesWebSocketCache(options);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				getCompat(model).supportsOpenAIGrammarTools,
			);
			body = buildRequestBody(model, normalizedContext, options, grammarToolInputProperties);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) body = nextBody as RequestBody;
			let retryFullContext = false;
			for (;;) {
				const attempt = await runResponsesWebSocketRequest(body as never, {
					endpoint: route.endpoint,
					provider: model.provider,
					...(options?.apiKey ? { apiKey: options.apiKey } : {}),
					headers: { ...model.headers, ...options?.headers },
					...(retryFullContext ? { useCachedContext: false } : cache),
					...(options?.signal ? { signal: options.signal } : {}),
					...(options?.timeoutMs !== undefined ? { idleTimeoutMs: options.timeoutMs } : {}),
					...(options?.websocketConnectTimeoutMs !== undefined ? { connectTimeoutMs: options.websocketConnectTimeoutMs } : {}),
					onStart: () => {
						started = true;
						stream.push({ type: "start", partial: output });
					},
					responseItems: () => convertResponsesMessages(model, normalizeContext({ messages: [output] }), toolCallProviders(model), {
						includeSystemPrompt: false,
						grammarToolInputProperties,
					}).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output"),
					onEvent: (event) => observeActiveHostedSearchEvent(model.provider, model.id, event),
				});
				request = attempt;
				try {
					await options?.onResponse?.(attempt.response, model);
					await processResponsesStream(attempt.events, output, stream, model, {
						serviceTier: options?.serviceTier,
						grammarToolInputProperties,
						applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
					});
					if (options?.signal?.aborted) throw new Error("Request was aborted");
					if (output.stopReason === "pending") throw new Error("Responses WebSocket stream ended without a stop reason");
					if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error(output.errorMessage || "An unknown error occurred");
					attempt.finalize(output.responseId);
					request = undefined;
					stream.push({ type: "done", reason: output.stopReason, message: output });
					stream.end();
					return;
				} catch (error) {
					const usedRailContinuation = body.previous_response_id === undefined
						&& attempt.requestBody.previous_response_id !== undefined;
					attempt.finalize(undefined);
					request = undefined;
					if (
						!retryFullContext
						&& !started
						&& !options?.signal?.aborted
						&& usedRailContinuation
						&& isResponsesWebSocketContinuationError(error)
					) {
						retryFullContext = true;
						continue;
					}
					throw error;
				}
			}
		} catch (error) {
			request?.finalize(undefined);
			if (
				body
				&& !started
				&& !options?.signal?.aborted
				&& (options?.transport === "auto" || options?.transport === undefined)
				&& isSafeResponsesWebSocketFallback(error)
			) {
				await forwardFallback(stream, fallback, model, normalizedContext, options, body);
				return;
			}
			for (const block of output.content) {
				const scratch = block as unknown as Record<string, unknown>;
				delete scratch["index"];
				delete scratch["partialJson"];
				delete scratch["customInput"];
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error), `${model.provider} WebSocket error`);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

function streamSimpleRoute(
	route: RailResponsesWebSocketRoute,
	fallbackStream: Provider["stream"],
	fallbackStreamSimple: Provider["streamSimple"],
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (!routeMatchesModel(route, model.provider, model.id) || options?.transport === "sse") {
		return fallbackStreamSimple(model, context, options);
	}
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	};
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	return streamResponsesWebSocketRoute(route, fallbackStream, model, context, {
		...base,
		...(reasoningEffort ? { reasoningEffort } : {}),
	});
}

export function installRailResponsesWebSocket(pi: ExtensionAPI): void {
	if (!claimSharedInstall(pi)) return;
	const settings = readRailResponsesWebSocketSettings();
	if (settings.warning) process.stderr.write(`${settings.warning}\n`);
	const routesByProvider = new Map<string, RailResponsesWebSocketRoute[]>();
	for (const route of settings.routes) {
		const routes = routesByProvider.get(route.provider) ?? [];
		routes.push(route);
		routesByProvider.set(route.provider, routes);
	}
	const leases = new Map<string, ProviderLease>();
	const restore = (ctx: ExtensionContext) => {
		for (const lease of leases.values()) {
			const current = ctx.modelRegistry.getRegisteredProviderConfig(lease.providerId);
			if (!current || current.streamSimple !== lease.wrapper) continue;
			const { streamSimple: _streamSimple, api: currentApi, ...rest } = current;
			const restored: ProviderConfig = { ...lease.previousConfig, ...rest };
			if (currentApi !== RESPONSES_API && currentApi !== undefined) restored.api = currentApi;
			else if (lease.previousConfig?.api !== undefined) restored.api = lease.previousConfig.api;
			if (lease.previousConfig?.streamSimple) restored.streamSimple = lease.previousConfig.streamSimple;
			pi.unregisterProvider(lease.providerId);
			if (Object.keys(restored).length > 0) pi.registerProvider(lease.providerId, restored);
		}
		leases.clear();
	};
	pi.on("session_start", async (_event, ctx) => {
		for (const [providerId, routes] of routesByProvider) {
			const installed = leases.get(providerId);
			if (installed && ctx.modelRegistry.getRegisteredProviderConfig(providerId)?.streamSimple === installed.wrapper) continue;
			const original = ctx.modelRegistry.getProvider(providerId);
			if (!original) continue;
			if (ctx.modelRegistry.getRegisteredNativeProvider(providerId)) continue;
			const previousConfig = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
			const changesExistingModelApis = previousConfig?.api !== RESPONSES_API
				&& previousConfig?.models?.some((model) => model.api === undefined) === true;
			const shadowsAnotherStream = previousConfig?.streamSimple !== undefined
				&& previousConfig.api !== RESPONSES_API;
			if (changesExistingModelApis || shadowsAnotherStream) continue;
			const wrapper: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) => {
				const route = routes.find((candidate) => routeMatchesModel(candidate, model.provider, model.id));
				return route
					? streamSimpleRoute(route, original.stream, original.streamSimple, model, context, options)
					: original.streamSimple(model, context, options);
			};
			pi.registerProvider(providerId, {
				api: RESPONSES_API,
				streamSimple: wrapper,
			});
			leases.set(providerId, { providerId, previousConfig, wrapper });
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		restore(ctx);
		closeRailResponsesWebSocketSessions(ctx.sessionManager.getSessionId());
	});
}

registerSessionResourceCleanup(closeRailResponsesWebSocketSessions);