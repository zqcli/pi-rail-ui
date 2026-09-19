import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildRemoteV2RequestBody,
	executeRemoteCompactionV2,
	parseSseEvents,
	reconcileCheckpoint,
} from "../../tools/gpt-compaction/remote-v2-client";

function sse(events: Array<{ event?: string; data: unknown | string }>): string {
	return events.map(({ event, data }) => {
		const payload = typeof data === "string" ? data : JSON.stringify(data);
		return `${event ? `event: ${event}\n` : ""}data: ${payload}\n\n`;
	}).join("");
}

const checkpointItem = {
	type: "compaction",
	id: "item_1",
	encrypted_content: "enc_opaque_1",
};

function completedResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			output: [{ ...checkpointItem }],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } },
			created_at: 1_735_689_600,
			...overrides,
		},
	};
}

test("v2 request body forces the trigger, store:false, and stream:true without mutating the source", () => {
	const source = { model: "gpt-5.6-sol", input: [{ role: "user", content: "hi" }], store: true, stream: false, tools: [{ type: "web_search" }] };
	const original = structuredClone(source);
	const body = buildRemoteV2RequestBody(source);
	assert.equal(body["store"], false);
	assert.equal(body["stream"], true);
	assert.deepEqual(body["input"], [{ role: "user", content: "hi" }, { type: "compaction_trigger" }]);
	assert.deepEqual(body["tools"], [{ type: "web_search" }]);
	assert.deepEqual(source, original, "the entire source body must remain unchanged");
});

test("v2 request body keeps exactly one terminal trigger", () => {
	const source = { input: [{ type: "compaction_trigger", extra: { old: true } }, { role: "user", content: "hi" }, { type: "compaction_trigger" }] };
	const original = structuredClone(source);
	const body = buildRemoteV2RequestBody(source);
	assert.deepEqual(body["input"], [{ role: "user", content: "hi" }, { type: "compaction_trigger" }]);
	assert.deepEqual(buildRemoteV2RequestBody(body), body, "rebuilding must not accumulate triggers");
	assert.deepEqual(source, original);
});

test("v2 request body isolates nested input, tools, and other fields in both directions", () => {
	const source = {
		input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
		tools: [{ type: "function", parameters: { properties: { query: { type: "string" } }, required: ["query"] } }],
		text: { format: { type: "json_schema", schema: { required: ["answer"] } } },
	};
	const original = structuredClone(source);
	const body = buildRemoteV2RequestBody(source);
	const input = body["input"] as typeof source.input;
	const tools = body["tools"] as typeof source.tools;
	const text = body["text"] as typeof source.text;
	input[0]!.content[0]!.text = "changed clone";
	tools[0]!.parameters.properties.query.type = "number";
	tools[0]!.parameters.required.push("extra");
	text.format.schema.required.push("extra");
	assert.deepEqual(source, original);

	const changedBody = structuredClone(body);
	source.input[0]!.content.push({ type: "input_text", text: "changed source" });
	source.tools[0]!.parameters.required.push("source-only");
	source.text.format.schema.required.push("source-only");
	assert.deepEqual(body, changedBody);
});

test("v2 request body preserves independent input and body clones for shared references", () => {
	const shared = { nested: { values: ["original"] } };
	const input: [typeof shared, typeof shared, { type: string }] = [shared, shared, { type: "compaction_trigger" }];
	const source = { input, tools: [shared], metadata: shared, inputAlias: input };
	const original = structuredClone(source);
	const body = buildRemoteV2RequestBody(source);
	const clonedInput = body["input"] as typeof input;
	const tools = body["tools"] as typeof source.tools;
	const inputAlias = body["inputAlias"] as typeof input;
	assert.equal(clonedInput[0], clonedInput[1], "aliases within input must survive");
	assert.equal(tools[0], body["metadata"], "aliases within the remaining body must survive");
	assert.equal(inputAlias[0], tools[0]);
	assert.notEqual(clonedInput[0], tools[0], "input must be cloned independently from the rest of the body");
	assert.notEqual(clonedInput, inputAlias);
	assert.deepEqual(inputAlias, input, "filtering must not remove triggers from aliases in other fields");
	clonedInput[0].nested.values.push("input-only");
	assert.deepEqual(tools[0]!.nested.values, ["original"]);
	tools[0]!.nested.values.push("tools-only");
	assert.deepEqual(clonedInput[0].nested.values, ["original", "input-only"]);
	assert.deepEqual(source, original);
});

test("v2 request body uses only a trigger for missing, empty, or cloneable non-array input", () => {
	const sources: Record<string, unknown>[] = [
		{},
		...[undefined, null, false, 0, "hi", { nested: ["ignored"] }, []].map((input) => ({ input })),
	];
	for (const source of sources) {
		const original = structuredClone(source);
		assert.deepEqual(buildRemoteV2RequestBody(source), {
			input: [{ type: "compaction_trigger" }], store: false, stream: true,
		});
		assert.deepEqual(source, original);
	}
});

test("v2 request body still rejects uncloneable values even when their fields are replaced or filtered", () => {
	const uncloneable = () => undefined;
	const sources: Record<string, unknown>[] = [
		{ input: uncloneable },
		{ input: Symbol("input") },
		{ input: { nested: uncloneable } },
		{ input: [{ nested: uncloneable }] },
		{ input: [{ type: "compaction_trigger", nested: uncloneable }] },
		{ input: [], tools: [{ nested: uncloneable }] },
		{ input: [], store: uncloneable },
		{ input: [], stream: uncloneable },
		{ tools: [{ nested: uncloneable }] },
	];
	for (const source of sources) {
		assert.throws(() => buildRemoteV2RequestBody(source), { name: "DataCloneError" });
	}
});

test("SSE parsing rejects malformed JSON and tolerates multi-line data", () => {
	assert.equal(parseSseEvents("data: {not json}\n\n"), undefined);
	const events = parseSseEvents("event: x\ndata: {\"a\":\n\ndata: 1}\n\n");
	// A blank line inside the block splits events; the second block is invalid JSON.
	assert.equal(events, undefined);
	const valid = parseSseEvents("data: {\"type\":\"response.completed\"}\n\n");
	assert.equal(valid?.length, 1);
});

test("a single completed checkpoint reconciles from the terminal output", () => {
	const events = parseSseEvents(sse([
		{ event: "response.created", data: { type: "response.created", response: { id: "resp_1" } } },
		{ event: "response.completed", data: completedResponse() },
	]))!;
	const result = reconcileCheckpoint(events);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.checkpoint.encrypted_content, "enc_opaque_1");
	assert.equal(result.responseId, "resp_1");
	assert.equal(result.createdAt, "2025-01-01T00:00:00.000Z");
});

test("checkpoint announced by output_item.done and terminal output must agree", () => {
	const agreeing = parseSseEvents(sse([
		{ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { ...checkpointItem } } },
		{ event: "response.completed", data: completedResponse() },
	]))!;
	assert.equal(reconcileCheckpoint(agreeing).ok, true);

	const conflicting = parseSseEvents(sse([
		{ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { ...checkpointItem, encrypted_content: "other" } } },
		{ event: "response.completed", data: completedResponse() },
	]))!;
	const result = reconcileCheckpoint(conflicting);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "conflicting-compaction-item");
});

test("reconciliation fails closed on every incomplete or ambiguous stream", () => {
	const cases: Array<{ name: string; events: string; reason: string }> = [
		{ name: "missing completed", events: sse([{ event: "response.created", data: { type: "response.created", response: { id: "r" } } }]), reason: "missing-completed-event" },
		{ name: "duplicate completed", events: sse([{ event: "response.completed", data: completedResponse() }, { event: "response.completed", data: completedResponse() }]), reason: "duplicate-completed-event" },
		{ name: "no compaction item", events: sse([{ event: "response.completed", data: completedResponse({ output: [{ type: "message", role: "assistant" }] }) }]), reason: "invalid-compaction-count" },
		{ name: "two compaction items", events: sse([{ event: "response.completed", data: completedResponse({ output: [{ ...checkpointItem }, { ...checkpointItem, id: "item_2" }] }) }]), reason: "invalid-compaction-count" },
		{ name: "malformed checkpoint", events: sse([{ event: "response.completed", data: completedResponse({ output: [{ type: "compaction", id: "x" }] }) }]), reason: "malformed-compaction-item" },
		{ name: "checkpoint with unrelated fields", events: sse([{ event: "response.completed", data: completedResponse({ output: [{ ...checkpointItem, trigger: true }] }) }]), reason: "malformed-compaction-item" },
		{ name: "failed response", events: sse([{ event: "response.failed", data: { type: "response.failed", response: { id: "r", status: "failed" } } }]), reason: "error-event" },
		{ name: "incomplete status", events: sse([{ event: "response.completed", data: completedResponse({ status: "incomplete" }) }]), reason: "incomplete-response" },
		{ name: "event after completed", events: sse([{ event: "response.completed", data: completedResponse() }, { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "x" } }]), reason: "invalid-event-order" },
	];
	for (const item of cases) {
		const events = parseSseEvents(item.events)!;
		const result = reconcileCheckpoint(events);
		assert.equal(result.ok, false, item.name);
		if (!result.ok) assert.equal(result.reason, item.reason, item.name);
	}
});

test("comments are harmless but tools alongside the checkpoint are rejected", () => {
	const comments = parseSseEvents(`: keepalive\n\ndata: ${JSON.stringify(completedResponse())}\n\n`);
	assert.equal(comments?.length, 1);
	const withTool = parseSseEvents(sse([
		{ event: "response.completed", data: completedResponse({ output: [{ type: "function_call", call_id: "call_1" }, { ...checkpointItem }] }) },
	]))!;
	const result = reconcileCheckpoint(withTool);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "invalid-compaction-count");
});

test("a streamed event after response.completed is not hidden by early terminal parsing", async () => {
	const body = sse([
		{ event: "response.completed", data: completedResponse() },
		{ event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "unexpected" } },
	]);
	const result = await executeRemoteCompactionV2({
		url: "https://gateway.example/v1/responses",
		headers: {},
		body: { model: "gpt", input: [] },
		fetch: (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof globalThis.fetch,
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "invalid-event-order");
});

test("meta-mismatched response ids are rejected", () => {
	const events = parseSseEvents(sse([
		{ event: "response.created", data: { type: "response.created", response: { id: "resp_other" } } },
		{ event: "response.completed", data: completedResponse() },
	]))!;
	const result = reconcileCheckpoint(events);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "invalid-compaction-metadata");
});

test("the client sends the trigger body and collects a checkpoint from a real HTTP response", async () => {
	let captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | undefined;
	const body = sse([
		{ event: "response.created", data: { type: "response.created", response: { id: "resp_1" } } },
		{ event: "response.completed", data: completedResponse() },
	]);
	const result = await executeRemoteCompactionV2({
		url: "https://gateway.example/v1/responses",
		headers: { authorization: "Bearer secret" },
		body: { model: "gpt-5.6-sol", input: [{ role: "user", content: "hi" }] },
		fetch: (async (url, init) => {
			captured = {
				url: String(url),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				headers: init?.headers as Record<string, string>,
			};
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as typeof globalThis.fetch,
	});
	assert.equal(result.ok, true);
	assert.equal(captured?.body["store"], false);
	assert.equal(captured?.body["stream"], true);
	assert.deepEqual(captured?.body["input"], [{ role: "user", content: "hi" }, { type: "compaction_trigger" }]);
	assert.deepEqual(captured?.headers, { authorization: "Bearer secret" });
});

test("a non-2xx response never installs a checkpoint and does not leak ciphertext", async () => {
	const result = await executeRemoteCompactionV2({
		url: "https://gateway.example/v1/responses",
		headers: {},
		body: { model: "m", input: [] },
		fetch: (async () => new Response(JSON.stringify({ error: { message: "unsupported model" } }), { status: 400 })) as typeof globalThis.fetch,
	});
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, "non-2xx");
	assert.equal(result.errorMessage, "unsupported model");
});

test("network diagnostics redact bearer credentials and opaque field names", async () => {
	const result = await executeRemoteCompactionV2({
		url: "https://gateway.example/v1/responses",
		headers: {},
		body: { model: "m", input: [] },
		fetch: (async () => {
			throw new Error('request failed Authorization: Bearer secret-token encrypted_content="opaque-secret"');
		}) as typeof globalThis.fetch,
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, "network-error");
		assert.doesNotMatch(result.errorMessage ?? "", /secret-token|opaque-secret/);
	}
});

test("retryable statuses retry a bounded number of times before failing", async () => {
	let attempts = 0;
	const result = await executeRemoteCompactionV2({
		url: "https://gateway.example/v1/responses",
		headers: {},
		body: { model: "m", input: [] },
		sleep: async () => undefined,
		fetch: (async () => {
			attempts += 1;
			return new Response("busy", { status: 503 });
		}) as typeof globalThis.fetch,
	});
	assert.equal(result.ok, false);
	assert.equal(attempts, 3, "bounded retries must stop");
});

test("abort is not retried and stops promptly", async () => {
	const controller = new AbortController();
	let attempts = 0;
	const result = await executeRemoteCompactionV2({
		url: "https://gateway.example/v1/responses",
		headers: {},
		body: { model: "m", input: [] },
		signal: controller.signal,
		fetch: (async () => {
			attempts += 1;
			controller.abort();
			return new Response("nope", { status: 503 });
		}) as typeof globalThis.fetch,
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "aborted");
	assert.equal(attempts, 1);
});

test("a hung request times out and the timeout is retryable", async () => {
	let attempts = 0;
	const result = await executeRemoteCompactionV2({
		url: "https://gateway.example/v1/responses",
		headers: {},
		body: { model: "m", input: [] },
		timeoutMs: 5,
		sleep: async () => undefined,
		fetch: (async (_url, init) => {
			attempts += 1;
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		}) as typeof globalThis.fetch,
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "timeout");
	assert.equal(attempts, 3);
});

test("provider AbortError caused by the local timeout is classified as timeout", async () => {
	const result = await executeRemoteCompactionV2({
		url: "https://gateway.example/v1/responses",
		headers: {},
		body: { model: "m", input: [] },
		timeoutMs: 5,
		sleep: async () => undefined,
		fetch: (async (_url, init) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
		})) as typeof globalThis.fetch,
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "timeout");
});
