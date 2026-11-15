import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { ExtensionContext, ProviderStreamEvent } from "@earendil-works/pi-coding-agent";
import { HostedSearchProviderCapture } from "../../openai/hosted-search-capture";
import { hostedSearchActivityForMessage } from "../../openai/hosted-search-activity";

const model: Model<"openai-responses"> = {
	provider: "custom", api: "openai-responses", id: "gpt-test", name: "GPT Test",
	baseUrl: "https://example.test/v1", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1024,
};
const searchItem = {
	id: "ws_search", type: "web_search_call", status: "completed",
	action: { type: "search", query: "网络搜索", sources: [{ title: "Result", url: "https://example.com/result" }] },
};

function rawEvent(data: unknown, requestModel: Model<Api> = model): ProviderStreamEvent {
	return { type: "provider_stream_event", provider: requestModel.provider, api: requestModel.api, model: requestModel.id, data };
}

function setupCapture(requestModel: Model<Api> = model, enabled = true) {
	const phases: string[] = [];
	const capture = new HostedSearchProviderCapture({ registerProvider() { throw new Error("unexpected provider registration"); } } as any, {
		isEnabled: () => enabled,
		onActivityChanged: (activity) => phases.push(activity.phase),
	});
	const ctx = { model: requestModel, modelRegistry: { getRegisteredProviderConfig: () => undefined } } as unknown as ExtensionContext;
	capture.startTurn(ctx);
	return { capture, phases, ctx };
}

test("public capture scopes events to the active model and associates the assistant before any raw event", async () => {
	const { capture, phases } = setupCapture();
	const assistant = { provider: model.provider, model: model.id, timestamp: 123, stopReason: "stop" };
	capture.associateMessage(assistant);
	capture.observe(rawEvent({ type: "response.output_item.done", item: searchItem }, { ...model, provider: "other" }));
	capture.observe(rawEvent({ type: "response.output_item.done", item: searchItem }, { ...model, id: "other" }));
	capture.observe(rawEvent({ type: "response.output_item.done", item: searchItem }, { ...model, api: "openai-completions" }));
	assert.equal(phases.includes("running"), false);
	capture.observe(rawEvent({ type: "response.web_search_call.searching", item_id: searchItem.id }));
	capture.observe(rawEvent({ type: "response.output_item.done", item: searchItem }));
	const snapshot = await capture.finishTurn(assistant);
	assert.equal(snapshot?.phase, "completed");
	assert.equal(snapshot?.callCount, 1);
	assert.equal(snapshot?.assistantTimestamp, 123);
	assert.equal(snapshot?.calls[0]?.query, "网络搜索");
	assert.equal(hostedSearchActivityForMessage(assistant)?.observed, true);
	assert.equal(phases.includes("running"), true);
	capture.observe(rawEvent({ type: "response.output_item.done", item: { ...searchItem, id: "idle" } }));
	assert.equal(await capture.finishTurn(assistant), undefined);
});

test("public capture supports Azure, Codex, and custom Responses providers without overriding them", async () => {
	for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses", "custom-responses"] as Api[]) {
		const requestModel = { ...model, api };
		const { capture } = setupCapture(requestModel);
		capture.observe(rawEvent({ type: "response.output_item.done", item: searchItem }, requestModel));
		assert.equal((await capture.finishTurn({ provider: model.provider, model: model.id, stopReason: "stop" }))?.callCount, 1);
	}
	const { capture } = setupCapture(model, false);
	capture.observe(rawEvent({ type: "response.output_item.done", item: searchItem }));
	assert.equal(await capture.finishTurn({ provider: model.provider, model: model.id, stopReason: "stop" }), undefined);
});

test("message finalization preserves failures and cancellation when the stream has no terminal event", async () => {
	for (const [stopReason, phase] of [["error", "failed"], ["aborted", "cancelled"], ["length", "completed"]] as const) {
		const { capture } = setupCapture();
		capture.observe(rawEvent({ type: "response.web_search_call.searching", item_id: searchItem.id }));
		const snapshot = await capture.finishTurn({ provider: model.provider, model: model.id, stopReason, errorMessage: "provider failed" });
		assert.equal(snapshot?.phase, phase);
		assert.equal(snapshot?.callCount, 1);
		if (phase === "failed") assert.equal(snapshot?.error, "provider failed");
	}
});

test("new turns discard abandoned activity and do not persist search-free responses", async () => {
	const { capture, ctx } = setupCapture();
	capture.observe(rawEvent({ type: "response.output_item.done", item: searchItem }));
	capture.startTurn(ctx);
	capture.observe(rawEvent({ type: "response.created", response: { id: "resp_no_search" } }));
	assert.equal(await capture.finishTurn({ provider: model.provider, model: model.id, stopReason: "stop" }), undefined);
});

test("Pi parses chunked HTTP SSE once and awaits hosted search observation before message completion", { timeout: 5_000 }, async (t) => {
	const textItem = {
		id: "msg_test", type: "message", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: "Search answer", annotations: [] }],
	};
	const events = [
		{ type: "response.created", response: { id: "resp_sse" } },
		{ type: "response.web_search_call.in_progress", item_id: searchItem.id },
		{ type: "response.web_search_call.searching", item_id: searchItem.id },
		{ type: "response.output_item.done", item: searchItem },
		{ type: "response.output_item.done", output_index: 1, item: textItem },
		{ type: "response.completed", response: {
			id: "resp_sse", status: "completed", completed_at: 2, output: [searchItem, textItem],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		} },
	];
	const wire = Buffer.from(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
	const server = createServer(async (_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (let index = 0; index < wire.length; index += 7) {
			response.write(wire.subarray(index, index + 7));
			await setImmediate();
		}
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("SSE fixture did not bind");
	const requestModel = { ...model, baseUrl: `http://127.0.0.1:${address.port}/v1` };
	const { capture, phases } = setupCapture(requestModel);
	const observed: unknown[] = [];
	const stream = streamOpenAIResponses(requestModel, normalizeContext({ messages: [{ role: "user", content: "search", timestamp: 1 }] }), {
		apiKey: "fixture-key",
		onProviderStreamEvent: async (data, providerModel) => {
			await setImmediate();
			observed.push(data);
			capture.observe(rawEvent(data, providerModel));
		},
	});
	let finished = false;
	for await (const event of stream) {
		if (event.type === "start") capture.associateMessage(event.partial);
		if (event.type === "done") {
			finished = true;
			assert.deepEqual(observed, events);
			assert.deepEqual(event.message.content.map((block) => block.type === "text" ? block.text : block.type), ["Search answer"]);
			const snapshot = await capture.finishTurn(event.message);
			assert.equal(snapshot?.phase, "completed");
			assert.equal(snapshot?.callCount, 1);
			assert.equal(snapshot?.calls[0]?.query, "网络搜索");
			assert.deepEqual(snapshot?.sources, [{ title: "Result", url: "https://example.com/result" }]);
		}
		if (event.type === "error") assert.fail(event.error.errorMessage);
	}
	assert.equal(finished, true);
	assert.equal(phases.includes("running"), true);
});
