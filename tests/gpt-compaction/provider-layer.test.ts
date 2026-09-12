import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { test } from "node:test";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
	WebSocketServer: new (options: { server: ReturnType<typeof createServer> }) => any;
};

const baseModel = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-local",
	name: "GPT local",
	baseUrl: "http://127.0.0.1",
	input: ["text"],
	reasoning: false,
	contextWindow: 32_000,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;

const context = (messages: unknown[]) => ({ messages, tools: [] }) as any;

function responseEvents(text: string, responseId = "http-response"): string {
	const item = {
		type: "message",
		id: `${responseId}-message`,
		role: "assistant",
		status: "completed",
		phase: "final_answer",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const response = {
		id: responseId,
		status: "completed",
		output: [item],
		usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 4 } },
	};
	return [
		`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: responseId } })}\n\n`,
		`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
		`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
	].join("");
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind");
	return `http://127.0.0.1:${address.port}/v1`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function collect(stream: AsyncIterable<unknown>): Promise<any[]> {
	const events: any[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function user(text: string): unknown {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

test("Pi's built-in OpenAI Responses provider completes against a local HTTP SSE server", { timeout: 10_000 }, async (t) => {
	const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			requests.push({ authorization: request.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(responseEvents("http answer"));
		});
	});
	const gateway = await listen(server);
	t.after(() => close(server));
	const model = { ...baseModel, baseUrl: gateway };
	const stream = openaiProvider().streamSimple(model, context([user("hello")]), { apiKey: "local-key" });
	const events = await collect(stream);
	const done = events.find((event) => event.type === "done");
	assert.equal(done?.message?.content?.[0]?.text, "http answer");
	assert.equal(done?.message?.usage?.input, 6, "cached input is mapped out of input tokens by the real provider");
	assert.equal(done?.message?.usage?.cacheRead, 4);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.authorization, "Bearer local-key");
	assert.equal(requests[0]?.body["stream"], true);
});

test("Pi's built-in OpenAI Responses provider surfaces a local HTTP failure", { timeout: 10_000 }, async (t) => {
	const server = createServer((_request, response) => {
		response.writeHead(503, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: "local upstream unavailable" } }));
	});
	const gateway = await listen(server);
	t.after(() => close(server));
	const stream = openaiProvider().streamSimple({ ...baseModel, baseUrl: gateway }, context([user("hello")]), { apiKey: "local-key" });
	const events = await collect(stream);
	const error = events.find((event) => event.type === "error");
	assert.equal(error?.reason, "error");
	assert.match(error?.error?.errorMessage ?? "", /local upstream unavailable/);
});

test("Pi's built-in OpenAI Responses provider aborts a pending local HTTP request", { timeout: 10_000 }, async (t) => {
	let requestSeen!: () => void;
	const requestPromise = new Promise<void>((resolve) => { requestSeen = resolve; });
	const server = createServer((_request, _response) => {
		requestSeen();
		// Keep the socket open until the provider aborts its request.
	});
	const gateway = await listen(server);
	t.after(() => close(server));
	const controller = new AbortController();
	const stream = openaiProvider().streamSimple({ ...baseModel, baseUrl: gateway }, context([user("abort me")]), {
		apiKey: "local-key",
		signal: controller.signal,
	});
	await requestPromise;
	controller.abort();
	const events = await collect(stream);
	const error = events.find((event) => event.type === "error");
	assert.equal(error?.reason, "aborted");
});

test("Pi's Codex provider uses a real local WebSocket continuation after the first response", { timeout: 10_000 }, async (t) => {
	const server = createServer();
	const websocket = new WebSocketServer({ server });
	const requests: Array<Record<string, unknown>> = [];
	let responseNumber = 0;
	websocket.on("connection", (socket: any) => {
		socket.on("message", (raw: Buffer) => {
			const message = JSON.parse(raw.toString()) as Record<string, unknown>;
			if (message["type"] !== "response.create") return;
			requests.push(message);
			responseNumber += 1;
			const responseId = `ws-response-${responseNumber}`;
			const item = {
				type: "message",
				id: `ws-message-${responseNumber}`,
				role: "assistant",
				status: "completed",
				phase: "final_answer",
				content: [{ type: "output_text", text: `ws answer ${responseNumber}`, annotations: [] }],
			};
			socket.send(JSON.stringify({ type: "response.created", response: { id: responseId } }));
			socket.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
			socket.send(JSON.stringify({
				type: "response.completed",
				response: { id: responseId, status: "completed", output: [item], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10, input_tokens_details: { cached_tokens: responseNumber === 2 ? 4 : 0 } } },
			}));
		});
	});
	const gateway = await listen(server);
	t.after(async () => {
		closeOpenAICodexWebSocketSessions("provider-layer-ws");
		await new Promise<void>((resolve) => websocket.close(() => resolve()));
		await close(server);
	});
	const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-local" } })).toString("base64url")}.signature`;
	const model = {
		...baseModel,
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: gateway,
	};
	const provider = openaiCodexProvider();
	const options = { apiKey: token, sessionId: "provider-layer-ws", transport: "auto" as const, websocketConnectTimeoutMs: 2_000, timeoutMs: 2_000 };
	const first = await collect(provider.streamSimple(model, context([user("first")]), options));
	const firstMessage = first.find((event) => event.type === "done")?.message;
	assert.equal(firstMessage?.content?.[0]?.text, "ws answer 1");
	const second = await collect(provider.streamSimple(model, context([user("first"), firstMessage, user("second")]), options));
	assert.equal(second.find((event) => event.type === "done")?.message?.content?.[0]?.text, "ws answer 2");
	assert.equal(requests.length, 2);
	assert.equal(requests[1]?.["previous_response_id"], "ws-response-1");
	assert.deepEqual(requests[1]?.["input"], [{ role: "user", content: [{ type: "input_text", text: "second" }] }]);
});
