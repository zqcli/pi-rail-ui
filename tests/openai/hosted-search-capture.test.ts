import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type Provider, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	HostedSearchProviderCapture,
	createHostedSearchObservedFetch,
} from "../../openai/hosted-search-capture";
import { HostedSearchActivity } from "../../openai/hosted-search-activity";

const model: any = {
	provider: "custom",
	api: "openai-responses",
	id: "gpt-5.6-luna",
	name: "GPT 5.6 Luna",
};

function eventStream(...events: unknown[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function fakeRuntime(options: { previousConfig?: any; native?: Provider } = {}) {
	const configs = new Map<string, any>();
	if (options.previousConfig) configs.set("custom", options.previousConfig);
	let lastOptions: SimpleStreamOptions | undefined;
	let lastContext: TranscriptContext | undefined;
	const provider: Provider = {
		id: "custom",
		name: "Custom",
		auth: {} as any,
		getModels: () => [model],
		stream: () => ({}) as any,
		streamSimple: (_model, _context, streamOptions) => {
			lastOptions = streamOptions;
			lastContext = _context;
			return { original: true } as any;
		},
	};
	const registry = {
		getProvider: () => provider,
		getRegisteredProviderConfig: () => configs.get("custom"),
		getRegisteredNativeProvider: () => options.native,
	};
	const calls: string[] = [];
	const pi = {
		registerProvider: (providerId: string, config: any) => {
			calls.push(`register:${providerId}`);
			configs.set(providerId, { ...(configs.get(providerId) ?? {}), ...config });
		},
		unregisterProvider: (providerId: string) => {
			calls.push(`unregister:${providerId}`);
			configs.delete(providerId);
		},
	};
	const ctx: any = { model, modelRegistry: registry, ui: { setStatus() {} } };
	return { configs, provider, registry, pi, ctx, calls, getLastOptions: () => lastOptions, getLastContext: () => lastContext };
}

test("observed fetch returns the original response and captures hosted search SSE", async () => {
	const activityEvents: string[] = [];
	const runtime = fakeRuntime();
	const capture = new HostedSearchProviderCapture(runtime.pi as any, {
		isEnabled: () => true,
		onActivityChanged: (activity) => activityEvents.push(activity.phase),
	});
	capture.startTurn();
	assert.equal(capture.sync(runtime.ctx, true), true);
	const wrapper = runtime.configs.get("custom").streamSimple;
	const response = eventStream(
		{ type: "response.created", response: { id: "resp_capture" } },
		{
			type: "response.output_item.done",
			item: {
				id: "ws_capture",
				type: "web_search_call",
				status: "completed",
				action: { type: "open_page", url: "https://example.com/current" },
			},
		},
		{ type: "response.completed", response: { id: "resp_capture", completed_at: 2, output: [] } },
	);
	assert.deepEqual(wrapper(model, normalizeContext({ messages: [] }), { fetch: async () => response }), { original: true });
	const fetch = runtime.getLastOptions()!.fetch!;
	const observedFetch = createHostedSearchObservedFetch(
		async () => response,
		new HostedSearchActivity({ provider: "custom", model: "gpt" }),
	);
	assert.equal(await observedFetch("https://example.com/v1/responses"), response);

	const providerResponse = await fetch("https://example.com/v1/responses");
	assert.equal(providerResponse instanceof Response, true);
	const snapshot = await capture.finishTurn({
		provider: "custom",
		model: "gpt-5.6-luna",
		responseId: "resp_capture",
		stopReason: "stop",
	});
	assert.equal(snapshot?.phase, "completed");
	assert.equal(snapshot?.calls[0]?.type, "open_page");
	assert.equal(snapshot?.sources[0]?.url, "https://example.com/current");
	assert.equal(activityEvents.includes("running"), true);
});

test("provider wrapper forwards the normalized transcript and preserves callbacks and options", () => {
	const runtime = fakeRuntime();
	const capture = new HostedSearchProviderCapture(runtime.pi as any, {
		isEnabled: () => true,
		onActivityChanged() {},
	});
	assert.equal(capture.sync(runtime.ctx, true), true);
	const wrapper: NonNullable<ProviderConfig["streamSimple"]> = runtime.configs.get("custom").streamSimple;
	const context = normalizeContext({
		systemPrompt: "keep the prompt",
		messages: [
			{ role: "user", content: "question", timestamp: 1 },
			{ role: "system", content: "later system update", timestamp: 2 },
		],
	});
	const options: SimpleStreamOptions = {
		fetch: async () => new Response("local fixture"),
		apiKey: "fixture-key",
		sessionId: "fixture-session",
		cacheRetention: "long",
		reasoning: "high",
		signal: new AbortController().signal,
		headers: { "x-test": "preserved" },
		maxTokens: 123,
		onPayload: (payload) => payload,
		onResponse: () => {},
	};
	Object.freeze(options);
	wrapper(model, context);
	assert.equal(runtime.getLastOptions(), undefined);
	wrapper(model, context, options);
	assert.equal(runtime.getLastContext(), context);
	assert.equal(runtime.getLastOptions(), options);
	capture.startTurn();
	wrapper(model, context, options);
	const forwarded = runtime.getLastOptions()!;
	assert.equal(runtime.getLastContext(), context);
	assert.notEqual(forwarded.fetch, options.fetch);
	assert.deepEqual({ ...forwarded, fetch: options.fetch }, options);
	assert.equal(forwarded.onPayload, options.onPayload);
	assert.equal(forwarded.onResponse, options.onResponse);
	capture.shutdown();
});

test("active capture uses global fetch when options are absent and bypasses disabled models", async (t) => {
	const response = new Response("fixture");
	const baseFetch = t.mock.fn(async () => response);
	t.mock.method(globalThis, "fetch", baseFetch);
	const runtime = fakeRuntime();
	let enabled = true;
	const capture = new HostedSearchProviderCapture(runtime.pi as any, {
		isEnabled: () => enabled,
		onActivityChanged() {},
	});
	t.after(() => capture.shutdown());
	capture.sync(runtime.ctx, true);
	capture.startTurn();
	const wrapper: NonNullable<ProviderConfig["streamSimple"]> = runtime.configs.get("custom").streamSimple;
	const context = normalizeContext({ messages: [] });
	wrapper(model, context);
	const forwardedFetch = runtime.getLastOptions()!.fetch!;
	const init = { headers: { "x-test": "unchanged" } };
	assert.equal(await forwardedFetch("https://example.com/other", init), response);
	assert.deepEqual(baseFetch.mock.calls[0]?.arguments, ["https://example.com/other", init]);
	assert.equal(runtime.getLastContext(), context);
	enabled = false;
	const options: SimpleStreamOptions = { maxTokens: 10 };
	wrapper(model, context, options);
	assert.equal(runtime.getLastOptions(), options);
	wrapper(model, context);
	assert.equal(runtime.getLastOptions(), undefined);
});

test("settles observation on DONE even when the SSE connection stays open", async () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt" });
	const encoder = new TextEncoder();
	const response = new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(
				`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: { id: "ws_done", type: "web_search_call", status: "completed", action: { type: "search", query: "done" } },
				})}\n\ndata: [DONE]\n\n`,
			));
		},
	}), { headers: { "content-type": "text/event-stream" } });
	const fetch = createHostedSearchObservedFetch(async () => response, activity);
	await fetch("https://example.com/v1/responses");
	await Promise.race([
		activity.waitForObservers(),
		new Promise((_, reject) => setTimeout(() => reject(new Error("observer did not settle on DONE")), 100)),
	]);
	assert.equal(activity.snapshot().calls[0]?.query, "done");
});

test("settles observation when the provider request is aborted", async () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt" });
	const controller = new AbortController();
	const response = new Response(new ReadableStream({
		start(streamController) {
			streamController.enqueue(new TextEncoder().encode(
				`data: ${JSON.stringify({
					type: "response.output_item.added",
					item: { id: "ws_abort", type: "web_search_call", status: "in_progress" },
				})}\n\n`,
			));
		},
	}), { headers: { "content-type": "text/event-stream" } });
	const fetch = createHostedSearchObservedFetch(async () => response, activity);
	await fetch("https://example.com/v1/responses", { signal: controller.signal });
	controller.abort();
	await Promise.race([
		activity.waitForObservers(),
		new Promise((_, reject) => setTimeout(() => reject(new Error("observer did not settle on abort")), 100)),
	]);
	assert.equal(activity.phase, activity.observed ? "running" : "pending");
});

test("restores the previous legacy provider stream while Rail still owns that field", () => {
	const previousStream = () => ({ previous: true }) as any;
	const runtime = fakeRuntime({ previousConfig: { api: "openai-responses", streamSimple: previousStream, baseUrl: "old" } });
	const capture = new HostedSearchProviderCapture(runtime.pi as any, {
		isEnabled: () => true,
		onActivityChanged() {},
	});
	assert.equal(capture.sync(runtime.ctx, true), true);
	assert.notEqual(runtime.configs.get("custom").streamSimple, previousStream);
	capture.restore();
	assert.equal(runtime.configs.get("custom").streamSimple, previousStream);
	assert.equal(runtime.configs.get("custom").baseUrl, "old");
	assert.deepEqual(runtime.calls, ["register:custom", "unregister:custom", "register:custom"]);
});

test("does not override native extension providers or clobber a newer stream owner", () => {
	const nativeRuntime = fakeRuntime({ native: fakeRuntime().provider });
	const nativeCapture = new HostedSearchProviderCapture(nativeRuntime.pi as any, {
		isEnabled: () => true,
		onActivityChanged() {},
	});
	assert.equal(nativeCapture.sync(nativeRuntime.ctx, true), false);
	assert.deepEqual(nativeRuntime.calls, []);

	const runtime = fakeRuntime();
	const capture = new HostedSearchProviderCapture(runtime.pi as any, {
		isEnabled: () => true,
		onActivityChanged() {},
	});
	assert.equal(capture.sync(runtime.ctx, true), true);
	const newerStream = () => ({ newer: true }) as any;
	const newer = { ...runtime.configs.get("custom"), streamSimple: newerStream, baseUrl: "new-owner" };
	runtime.configs.set("custom", newer);
	capture.restore();
	assert.equal(runtime.configs.get("custom"), newer);
	assert.deepEqual(runtime.calls, ["register:custom"]);
});

test("keeps a merged non-stream overlay without stacking another wrapper", () => {
	const runtime = fakeRuntime();
	const capture = new HostedSearchProviderCapture(runtime.pi as any, {
		isEnabled: () => true,
		onActivityChanged() {},
	});
	assert.equal(capture.sync(runtime.ctx, true), true);
	const wrapper = runtime.configs.get("custom").streamSimple;
	const mergedOverlay = { ...runtime.configs.get("custom"), baseUrl: "https://new-overlay.example/v1" };
	runtime.configs.set("custom", mergedOverlay);

	assert.equal(capture.sync(runtime.ctx, true), true);
	assert.equal(runtime.configs.get("custom"), mergedOverlay);
	assert.equal(runtime.configs.get("custom").streamSimple, wrapper);
	assert.deepEqual(runtime.calls, ["register:custom"]);
	capture.restore();
	assert.equal(runtime.configs.get("custom").baseUrl, "https://new-overlay.example/v1");
	assert.equal(runtime.configs.get("custom").streamSimple, undefined);
});

test("reacquires capture after a newer stream owner replaces the wrapper", () => {
	const runtime = fakeRuntime();
	const capture = new HostedSearchProviderCapture(runtime.pi as any, {
		isEnabled: () => true,
		onActivityChanged() {},
	});
	assert.equal(capture.sync(runtime.ctx, true), true);
	const newerStream = () => ({ newer: true }) as any;
	runtime.configs.set("custom", {
		...runtime.configs.get("custom"),
		baseUrl: "https://new-owner.example/v1",
		streamSimple: newerStream,
	});
	assert.equal(capture.sync(runtime.ctx, true), true);
	assert.notEqual(runtime.configs.get("custom").streamSimple, newerStream);
	capture.restore();
	assert.equal(runtime.configs.get("custom").baseUrl, "https://new-owner.example/v1");
	assert.equal(runtime.configs.get("custom").streamSimple, newerStream);
});

test("reinstalls for a different Responses API and declines Codex WebSocket capture", () => {
	const runtime = fakeRuntime();
	const capture = new HostedSearchProviderCapture(runtime.pi as any, {
		isEnabled: () => true,
		onActivityChanged() {},
	});
	assert.equal(capture.sync(runtime.ctx, true), true);
	const openAiWrapper = runtime.configs.get("custom").streamSimple;
	runtime.ctx.model = { ...model, api: "azure-openai-responses" };
	assert.equal(capture.sync(runtime.ctx, true), true);
	assert.notEqual(runtime.configs.get("custom").streamSimple, openAiWrapper);

	runtime.ctx.model = { ...model, api: "openai-codex-responses" };
	assert.equal(capture.sync(runtime.ctx, true), false);
	assert.equal(runtime.configs.has("custom"), false);
});
