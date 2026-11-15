import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { normalizeContext, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { HostedSearchProviderCapture } from "../../openai/hosted-search-capture";
import { PROVIDER_STREAM_EVENTS } from "../../openai/provider-stream-events";

const model = {
	provider: "custom", api: "openai-responses" as const, id: "gpt-test", name: "GPT Test", baseUrl: "https://example.test/v1",
	reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1024,
};
const item = { id: "ws_legacy", type: "web_search_call", status: "completed", action: { type: "search", query: "legacy provider" } };
const raw = [
	{ type: "response.created", response: { id: "resp_legacy" } },
	{ type: "response.web_search_call.searching", item_id: item.id },
	{ type: "response.output_item.done", item },
	{ type: "response.completed", response: { id: "resp_legacy", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];
const wire = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

function runtime(options: { emitsRaw?: boolean; native?: boolean; publicContract?: boolean; passive?: boolean } = {}) {
	let lastOptions: SimpleStreamOptions | undefined;
	let lastContext: TranscriptContext | undefined;
	const original = (_model: any, context: TranscriptContext, streamOptions?: SimpleStreamOptions) => {
		lastOptions = streamOptions;
		lastContext = context;
		if (options.passive) return {} as any;
		const { onProviderStreamEvent: _onProviderStreamEvent, ...legacyOptions } = streamOptions ?? {};
		return streamOpenAIResponses(model, context, options.emitsRaw ? streamOptions : legacyOptions);
	};
	if (options.publicContract) Object.defineProperty(original, PROVIDER_STREAM_EVENTS, { value: true });
	const previous = { api: model.api, streamSimple: original, baseUrl: model.baseUrl };
	let config: any = previous;
	const mutations: string[] = [];
	const pi: any = {
		registerProvider: (_provider: string, update: any) => { config = { ...config, ...update }; mutations.push("register"); },
		unregisterProvider: () => { config = undefined; mutations.push("unregister"); },
	};
	const ctx: any = { model, modelRegistry: {
		getRegisteredProviderConfig: () => config,
		getRegisteredNativeProvider: () => options.native ? {} : undefined,
		getProvider: () => ({ streamSimple: original }),
	} };
	const phases: string[] = [];
	const capture = new HostedSearchProviderCapture(pi, { isEnabled: () => true, onActivityChanged: (activity) => phases.push(activity.phase) });
	return { capture, ctx, original, previous, phases, mutations, getConfig: () => config, setConfig: (next: any) => { config = next; }, getLastOptions: () => lastOptions, getLastContext: () => lastContext };
}

test("custom legacy SSE streams retain capture and callbacks without duplicating public search events", async () => {
	for (const emitsRaw of [false, true]) {
		const fixture = runtime({ emitsRaw });
		fixture.capture.startTurn(fixture.ctx);
		const context = normalizeContext({ messages: [{ role: "user", content: "question", timestamp: 1 }] });
		const response = new Response(wire(raw), { headers: { "content-type": "text/event-stream" } });
		const observed: unknown[] = [];
		let responses = 0;
		const options: SimpleStreamOptions = {
			apiKey: "fixture-key", sessionId: "legacy-session", cacheRetention: "long", maxTokens: 100,
			fetch: async () => response,
			onPayload: (payload) => payload,
			onResponse: () => { responses++; },
			onProviderStreamEvent: (data, requestModel) => {
				observed.push(data);
				fixture.capture.observe({ type: "provider_stream_event", provider: requestModel.provider, api: requestModel.api, model: requestModel.id, data });
			},
		};
		Object.freeze(options);
		const stream = fixture.getConfig().streamSimple(model, context, options);
		assert.equal(fixture.getLastContext(), context);
		assert.deepEqual({ ...fixture.getLastOptions(), fetch: options.fetch }, options);
		let snapshot;
		for await (const event of stream) {
			if (event.type === "start") fixture.capture.associateMessage(event.partial);
			if (event.type === "done") snapshot = await fixture.capture.finishTurn(event.message);
			if (event.type === "error") assert.fail(event.error.errorMessage);
		}
		assert.equal(snapshot?.callCount, 1);
		assert.equal(snapshot?.phase, "completed");
		assert.equal(snapshot?.calls[0]?.query, "legacy provider");
		assert.equal(snapshot?.calls[0]?.status, "completed");
		assert.equal(responses, 1);
		assert.deepEqual(observed, emitsRaw ? raw : []);
		const completed = fixture.phases.indexOf("completed");
		assert.equal(fixture.phases.slice(completed).includes("running"), false, "a duplicate public stream must not revive completed search");
		fixture.capture.shutdown();
		assert.deepEqual(fixture.getConfig(), fixture.previous);
	}
});

test("native and declared raw-event custom streams are not wrapped", async () => {
	for (const options of [{ native: true }, { publicContract: true }]) {
		const fixture = runtime(options);
		fixture.capture.startTurn(fixture.ctx);
		assert.deepEqual(fixture.mutations, []);
		assert.equal(fixture.getConfig().streamSimple, fixture.original);
		fixture.capture.observe({ type: "provider_stream_event", provider: model.provider, model: model.id, api: model.api, data: { type: "response.output_item.done", item } });
		assert.equal((await fixture.capture.finishTurn({ provider: model.provider, model: model.id, stopReason: "stop" }))?.callCount, 1);
		fixture.capture.shutdown();
		assert.deepEqual(fixture.mutations, []);
	}
});

test("legacy ownership preserves later overlays and does not remove a newer stream", () => {
	const fixture = runtime();
	fixture.capture.startTurn(fixture.ctx);
	const installed = fixture.getConfig().streamSimple;
	fixture.setConfig({ ...fixture.getConfig(), baseUrl: "https://new.example/v1" });
	fixture.capture.startTurn(fixture.ctx);
	assert.equal(fixture.getConfig().streamSimple, installed);
	assert.deepEqual(fixture.mutations, ["register"]);
	fixture.capture.shutdown();
	assert.equal(fixture.getConfig().streamSimple, fixture.original);
	assert.equal(fixture.getConfig().baseUrl, "https://new.example/v1");
	fixture.capture.startTurn(fixture.ctx);
	const newer = () => ({});
	fixture.setConfig({ ...fixture.getConfig(), streamSimple: newer });
	const before = fixture.mutations.length;
	fixture.capture.shutdown();
	assert.equal(fixture.mutations.length, before);
	assert.equal(fixture.getConfig().streamSimple, newer);
});

test("legacy observers drain on DONE and abort even when an SSE body stays open", { timeout: 2_000 }, async () => {
	for (const abort of [false, true]) {
		const fixture = runtime({ passive: true });
		fixture.capture.startTurn(fixture.ctx);
		const controller = new AbortController();
		const response = new Response(new ReadableStream({ start(stream) {
			stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n${abort ? "" : "data: [DONE]\n\n"}`));
		} }), { headers: { "content-type": "text/event-stream" } });
		fixture.getConfig().streamSimple(model, normalizeContext({ messages: [] }), { fetch: async () => response, signal: controller.signal });
		assert.equal(await fixture.getLastOptions()!.fetch!(model.baseUrl + "/responses", { signal: controller.signal }), response);
		while (!fixture.phases.includes("running")) await setImmediate();
		if (abort) controller.abort();
		const snapshot = await fixture.capture.finishTurn({ provider: model.provider, model: model.id, stopReason: abort ? "aborted" : "stop" });
		assert.equal(snapshot?.callCount, 1);
		assert.equal(snapshot?.phase, abort ? "cancelled" : "completed");
		fixture.capture.shutdown();
		void response.body?.cancel();
	}
});

test("legacy malformed and oversized SSE frames do not hide later valid search events", async () => {
	const fixture = runtime({ passive: true });
	fixture.capture.startTurn(fixture.ctx);
	const body = `data: not-json\n\ndata: ${"x".repeat(2_000_100)}\n\n${wire(raw)}`;
	fixture.getConfig().streamSimple(model, normalizeContext({ messages: [] }), {
		fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
	});
	await fixture.getLastOptions()!.fetch!(model.baseUrl + "/responses");
	const snapshot = await fixture.capture.finishTurn({ provider: model.provider, model: model.id, stopReason: "stop" });
	assert.equal(snapshot?.callCount, 1);
	assert.equal(snapshot?.calls[0]?.query, "legacy provider");
	fixture.capture.shutdown();
});
