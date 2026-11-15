import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	installRailResponsesWebSocket,
	resolveResponsesWebSocketCache,
	streamResponsesWebSocketRoute,
} from "../../openai/responses-websocket/provider";
import { WebSocketServer } from "ws";
import { setImmediate } from "node:timers/promises";
import { InMemoryCredentialStore, normalizeContext, type Model, type OpenAIResponsesOptions, type Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { HostedSearchProviderCapture } from "../../openai/hosted-search-capture";
import { PROVIDER_STREAM_EVENTS } from "../../openai/provider-stream-events";
import { closeRailResponsesWebSocketSessions } from "../../openai/responses-websocket/transport";

test("Responses WebSocket cache policy honors transport and cache retention", () => {
	assert.deepEqual(resolveResponsesWebSocketCache({ transport: "auto", sessionId: "session" } as any), {
		useCachedContext: true,
		sessionId: "session",
	});
	assert.deepEqual(resolveResponsesWebSocketCache({ transport: "websocket-cached", cacheRetention: "none", sessionId: "session" } as any), {
		useCachedContext: false,
	});
	assert.deepEqual(resolveResponsesWebSocketCache({ transport: "websocket", sessionId: "session" } as any), {
		useCachedContext: false,
	});
	assert.deepEqual(resolveResponsesWebSocketCache({ transport: "auto", sessionId: "session", disableContinuation: true }), {
		useCachedContext: false,
	});
});

test("Responses WebSocket overlay installs at session start and preserves the original provider path", async () => {
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const agentDir = await mkdtemp(join(tmpdir(), "rail-responses-ws-provider-"));
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	await mkdir(join(agentDir, "rail-openai-responses-ws"), { recursive: true });
	await writeFile(join(agentDir, "rail-openai-responses-ws", "settings.json"), JSON.stringify({
		version: 1,
		routes: [{ provider: "cus-resp", endpoint: "wss://ai.example.test/v1/responses", models: ["gpt-route"] }],
	}));
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const sentinel = {};
	const original = {
		stream: () => sentinel,
		streamSimple: () => sentinel,
	};
	const models = [
		{ id: "chat", type: "chat", api: "openai-responses", samplingParams: undefined },
		{ id: "image", type: "image" },
		{ id: "classifier", type: "classifier" },
	];
	const refreshModels = async () => models;
	const previousConfig = { api: "legacy-responses", headers: { "x-original": "1" }, models, refreshModels };
	let registeredConfig: any = previousConfig;
	let registrations = 0;
	let unregisters = 0;
	const pi = {
		events: {
			emit: (name: string, data: unknown) => { for (const handler of handlers.get(name) ?? []) handler(data, undefined); },
			on: (name: string, handler: (data: unknown) => void) => {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
		},
		on: (name: string, handler: (event: unknown, ctx: any) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerProvider: (_providerId: string, config: unknown) => {
			registrations += 1;
			registeredConfig = { ...registeredConfig, ...(config as object) };
		},
		unregisterProvider: () => {
			unregisters += 1;
			registeredConfig = undefined;
		},
	};
	const ctx = {
		sessionManager: { getSessionId: () => "provider-test-session" },
		modelRegistry: {
			getProvider: () => original,
			getRegisteredProviderConfig: () => registeredConfig,
			getRegisteredNativeProvider: () => undefined,
		},
	};
	try {
		installRailResponsesWebSocket(pi as any);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		assert.equal(registrations, 1);
		assert.equal(Reflect.get(registeredConfig.streamSimple, PROVIDER_STREAM_EVENTS), true);
		const unrouted = registeredConfig.streamSimple(
			{ provider: "cus-resp", id: "other", api: "openai-responses" },
			{ messages: [] },
			{},
		);
		assert.equal(unrouted, sentinel);
		const forcedSse = registeredConfig.streamSimple(
			{ provider: "cus-resp", id: "gpt-route", api: "openai-responses" },
			{ messages: [] },
			{ transport: "sse" },
		);
		assert.equal(forcedSse, sentinel);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		assert.equal(registrations, 1, "a second session_start must not stack another provider wrapper");
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		assert.equal(unregisters, 1);
		assert.deepEqual(registeredConfig, previousConfig);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		registeredConfig = { ...registeredConfig, api: "newer-responses" };
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		assert.deepEqual(registeredConfig, { ...previousConfig, api: "newer-responses" });
	} finally {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Responses WebSocket overlay leaves native extension providers untouched", async () => {
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const agentDir = await mkdtemp(join(tmpdir(), "rail-responses-ws-native-provider-"));
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	await mkdir(join(agentDir, "rail-openai-responses-ws"), { recursive: true });
	await writeFile(join(agentDir, "rail-openai-responses-ws", "settings.json"), JSON.stringify({
		version: 1,
		routes: [{ provider: "native", endpoint: "wss://ai.example.test/v1/responses", models: ["gpt-route"] }],
	}));
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	let registrations = 0;
	let unregisters = 0;
	const nativeProvider = { stream: () => ({}), streamSimple: () => ({}) };
	const pi = {
		events: {
			emit: (name: string, data: unknown) => { for (const handler of handlers.get(name) ?? []) handler(data, undefined); },
			on: (name: string, handler: (data: unknown) => void) => {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
		},
		on: (name: string, handler: (event: unknown, ctx: any) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerProvider: () => { registrations += 1; },
		unregisterProvider: () => { unregisters += 1; },
	};
	const ctx = {
		sessionManager: { getSessionId: () => "native-provider-session" },
		modelRegistry: {
			getProvider: () => nativeProvider,
			getRegisteredProviderConfig: () => undefined,
			getRegisteredNativeProvider: () => nativeProvider,
		},
	};
	try {
		installRailResponsesWebSocket(pi as any);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		assert.equal(registrations, 0);
		assert.equal(unregisters, 0);
	} finally {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Responses WebSocket overlay does not shadow another extension stream API", async () => {
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const agentDir = await mkdtemp(join(tmpdir(), "rail-responses-ws-other-stream-"));
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	await mkdir(join(agentDir, "rail-openai-responses-ws"), { recursive: true });
	await writeFile(join(agentDir, "rail-openai-responses-ws", "settings.json"), JSON.stringify({
		version: 1,
		routes: [{ provider: "mixed", endpoint: "wss://ai.example.test/v1/responses", models: ["gpt-route"] }],
	}));
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const original = { stream: () => ({}), streamSimple: () => ({}) };
	let registrations = 0;
	const pi = {
		events: {
			emit: (name: string, data: unknown) => { for (const handler of handlers.get(name) ?? []) handler(data, undefined); },
			on: (name: string, handler: (data: unknown) => void) => {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
		},
		on: (name: string, handler: (event: unknown, ctx: any) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerProvider: () => { registrations += 1; },
		unregisterProvider: () => undefined,
	};
	const ctx = {
		sessionManager: { getSessionId: () => "other-stream-session" },
		modelRegistry: {
			getProvider: () => original,
			getRegisteredProviderConfig: () => ({ api: "other-api", streamSimple: original.streamSimple }),
			getRegisteredNativeProvider: () => undefined,
		},
	};
	try {
		installRailResponsesWebSocket(pi as any);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		assert.equal(registrations, 0);
	} finally {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Responses WebSocket route retries a missing cached continuation once with full context", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const requests: Array<Record<string, unknown>> = [];
	server.on("connection", (socket) => {
		socket.on("message", (data) => {
			const body = JSON.parse(data.toString()) as Record<string, unknown>;
			requests.push(body);
			if (requests.length === 2) {
				socket.send(JSON.stringify({
					type: "error",
					error: { code: "previous_response_not_found", message: "cached response expired" },
				}));
				return;
			}
			const id = `resp_${requests.length}`;
			socket.send(JSON.stringify({
				type: "response.completed",
				response: { id, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
			}));
		});
	});
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	const sessionId = "provider-continuation-retry";
	t.after(async () => {
		const { closeRailResponsesWebSocketSessions } = await import("../../openai/responses-websocket/transport");
		closeRailResponsesWebSocketSessions(sessionId);
		server.close();
	});
	const model = {
		id: "gpt-test",
		name: "GPT Test",
		provider: "test-provider",
		api: "openai-responses",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	};
	const route = { provider: "test-provider", endpoint, models: ["gpt-test"] };
	const fallback = () => { throw new Error("unexpected SSE fallback"); };
	const firstUser = { role: "user", content: "first", timestamp: Date.now() };
	const first = streamResponsesWebSocketRoute(route as any, fallback as any, model as any, { messages: [firstUser] } as any, {
		apiKey: "test-key",
		transport: "websocket-cached",
		sessionId,
	});
	let firstAssistant: any;
	for await (const event of first) if (event.type === "done") firstAssistant = event.message;
	assert.ok(firstAssistant);
	const secondUser = { role: "user", content: "second", timestamp: Date.now() + 1 };
	const second = streamResponsesWebSocketRoute(route as any, fallback as any, model as any, {
		messages: [firstUser, firstAssistant, secondUser],
	} as any, {
		apiKey: "test-key",
		transport: "websocket-cached",
		sessionId,
	});
	let completed = false;
	for await (const event of second) if (event.type === "done") completed = true;
	assert.equal(completed, true);
	assert.equal(requests.length, 3);
	assert.equal(requests[1]?.["previous_response_id"], "resp_1");
	assert.equal(requests[2]?.["previous_response_id"], undefined);
	assert.ok(Array.isArray(requests[2]?.["input"]));
});

test("Responses WebSocket route honors PI_CACHE_RETENTION=long", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	let body: Record<string, unknown> | undefined;
	server.on("connection", (socket) => socket.on("message", (data) => {
		body = JSON.parse(data.toString()) as Record<string, unknown>;
		socket.send(JSON.stringify({
			type: "response.completed",
			response: { id: "resp_long", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
		}));
	}));
	const route = { provider: "test-provider", endpoint: `ws://127.0.0.1:${address.port}/v1/responses`, models: ["gpt-test"] };
	const model = {
		id: "gpt-test",
		name: "GPT Test",
		provider: "test-provider",
		api: "openai-responses",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	};
	t.after(() => server.close());
	const result = streamResponsesWebSocketRoute(route as any, (() => { throw new Error("unexpected SSE fallback"); }) as any, model as any, {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	} as any, {
		apiKey: "test-key",
		transport: "websocket",
		env: { PI_CACHE_RETENTION: "long" },
		sessionId: "long-retention",
	});
	for await (const _event of result) {
		// Drain the response.
	}
	assert.equal(body?.["prompt_cache_retention"], "24h");
});
const fixtureModel: Model<"openai-responses"> = {
	id: "gpt-test", name: "GPT Test", provider: "test-provider", api: "openai-responses",
	baseUrl: "https://example.test/v1", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1024,
};

const noFallback = () => { throw new Error("unexpected SSE fallback"); };

function completedResponse(id: string, output: unknown[] = []) {
	return { id, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
}

test("Responses WebSocket forwards ordered raw events and final hosted search output before normalization", { timeout: 5_000 }, async (t) => {
	const search = {
		type: "web_search_call", id: "ws_raw", status: "completed",
		action: { type: "search", query: "raw websocket", sources: [{ title: "Source", url: "https://example.com/raw" }] },
	};
	const raw = [
		{ type: "response.created", response: { id: "resp_raw" } },
		{ type: "response.web_search_call.searching", item_id: search.id },
		{ type: "response.done", response: completedResponse("resp_raw", [search]) },
	];
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket fixture did not bind");
	t.after(() => server.close());
	server.on("connection", (socket) => socket.on("message", () => {
		for (const event of raw) socket.send(JSON.stringify(event));
	}));
	const route = { provider: fixtureModel.provider, endpoint: `ws://127.0.0.1:${address.port}/v1/responses`, models: [fixtureModel.id] };
	const phases: string[] = [];
	const capture = new HostedSearchProviderCapture({} as any, { isEnabled: () => true, onActivityChanged: (activity) => phases.push(activity.phase) });
	capture.startTurn({ model: fixtureModel, modelRegistry: { getRegisteredProviderConfig: () => undefined } } as any);
	const observed: unknown[] = [];
	const stream = streamResponsesWebSocketRoute(route, noFallback, fixtureModel, normalizeContext({ messages: [] }), {
		apiKey: "fixture-key", transport: "websocket",
		onProviderStreamEvent: async (data, model) => {
			await setImmediate();
			observed.push(data);
			capture.observe({ type: "provider_stream_event", provider: model.provider, api: model.api, model: model.id, data });
		},
	});
	for await (const event of stream) {
		if (event.type === "start") capture.associateMessage(event.partial);
		if (event.type === "done") {
			assert.deepEqual(observed, raw, "raw response.done must remain visible before normalization");
			const snapshot = await capture.finishTurn(event.message);
			assert.equal(snapshot?.callCount, 1);
			assert.equal(snapshot?.phase, "completed");
			assert.equal(snapshot?.calls[0]?.query, "raw websocket");
			assert.deepEqual(snapshot?.sources, [{ title: "Source", url: "https://example.com/raw" }]);
		}
		if (event.type === "error") assert.fail(event.error.errorMessage);
	}
	assert.equal(phases.includes("running"), true);
	assert.equal(observed.length, 3);
});

test("Responses WebSocket reports raw provider errors before stream failure", { timeout: 5_000 }, async (t) => {
	const raw = { type: "error", error: { code: "server_error", message: "fixture failed" } };
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket fixture did not bind");
	t.after(() => server.close());
	server.on("connection", (socket) => socket.on("message", () => socket.send(JSON.stringify(raw))));
	const observed: unknown[] = [];
	const result = await streamResponsesWebSocketRoute(
		{ provider: fixtureModel.provider, endpoint: `ws://127.0.0.1:${address.port}/v1/responses`, models: [fixtureModel.id] },
		noFallback, fixtureModel, normalizeContext({ messages: [] }),
		{ apiKey: "fixture-key", transport: "websocket", onProviderStreamEvent: async (data) => { await setImmediate(); observed.push(data); } },
	).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /fixture failed/);
	assert.deepEqual(observed, [raw]);
});

test("cache warming sends full context on a separate socket without replacing normal continuation", { timeout: 5_000 }, async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket fixture did not bind");
	const sessionId = "warm-without-continuation";
	t.after(() => { closeRailResponsesWebSocketSessions(sessionId); server.close(); });
	const requests: Array<Record<string, unknown>> = [];
	const connectionIds: number[] = [];
	let connections = 0;
	server.on("connection", (socket) => {
		const connection = ++connections;
		socket.on("message", (data) => {
			requests.push(JSON.parse(data.toString()) as Record<string, unknown>);
			connectionIds.push(connection);
			socket.send(JSON.stringify({ type: "response.completed", response: completedResponse(`resp_${requests.length}`) }));
		});
	});
	const route = { provider: fixtureModel.provider, endpoint: `ws://127.0.0.1:${address.port}/v1/responses`, models: [fixtureModel.id] };
	const options: OpenAIResponsesOptions = { apiKey: "fixture-key", transport: "websocket-cached", sessionId };
	const user = { role: "user" as const, content: "first", timestamp: 1 };
	const initial = normalizeContext({ messages: [user] });
	const assistant = await streamResponsesWebSocketRoute(route, noFallback, fixtureModel, initial, options).result();
	assert.equal(assistant.stopReason, "stop");
	const warmed = await streamResponsesWebSocketRoute(route, noFallback, fixtureModel, initial, { ...options, disableContinuation: true }).result();
	assert.equal(warmed.stopReason, "stop");
	const final = await streamResponsesWebSocketRoute(route, noFallback, fixtureModel, normalizeContext({
		messages: [user, assistant, { role: "user", content: "next", timestamp: 2 }],
	}), options).result();
	assert.equal(final.stopReason, "stop");
	assert.deepEqual(connectionIds, [1, 2, 1]);
	assert.deepEqual(requests[1]?.["input"], requests[0]?.["input"]);
	assert.equal(requests[1]?.["previous_response_id"], undefined);
	assert.equal(requests[1]?.["prompt_cache_key"], sessionId);
	assert.equal(requests[2]?.["previous_response_id"], "resp_1", "paid warming must not replace the real response chain");
	assert.equal((requests[2]?.["input"] as unknown[]).length, 1);
});

test("Responses WebSocket matches upstream tool declarations for unsupported, additive, and changing tools", async () => {
	const tool = (name: string, description = name) => ({ name, description, parameters: { type: "object", properties: {} } });
	const context = normalizeContext({ messages: [
		{ role: "system", content: "initial", toolsAdded: [tool("read"), tool("removed")], timestamp: 1 },
		{ role: "user", content: "first", timestamp: 2 },
		{ role: "system", content: "changed", toolsRemoved: [{ name: "removed" }], toolsAdded: [tool("read", "updated")], timestamp: 3 },
		{ role: "user", content: "second", timestamp: 4 },
		{ role: "system", content: "loaded", toolsAdded: [tool("later")], timestamp: 5 },
		{ role: "user", content: "third", timestamp: 6 },
	] });
	const combinations = [
		{},
		{ supportsAdditionalTools: true },
		{ supportsToolSearch: true, supportsMidConvoSystemMessages: true },
		{ supportsAdditionalTools: true, supportsMidConvoSystemMessages: true },
		{ supportsToolSearch: true, supportsAdditionalTools: true, supportsMidConvoSystemMessages: true },
	];
	for (const compat of combinations) {
		const model = { ...fixtureModel, compat };
		let upstreamBody: any;
		let railBody: any;
		const upstream = await streamOpenAIResponses(model, context, {
			apiKey: "fixture-key", onPayload: (body) => { upstreamBody = body; throw new Error("inspect before send"); },
		}).result();
		const rail = await streamResponsesWebSocketRoute(
			{ provider: model.provider, endpoint: "wss://example.test/v1/responses", models: [model.id] },
			noFallback, model, context,
			{ apiKey: "fixture-key", onPayload: (body) => { railBody = body; throw new Error("inspect before send"); } },
		).result();
		assert.match(upstream.errorMessage ?? "", /inspect before send/);
		assert.match(rail.errorMessage ?? "", /inspect before send/);
		assert.deepEqual(railBody.input, upstreamBody.input, JSON.stringify(compat));
		assert.deepEqual(railBody.tools, upstreamBody.tools, JSON.stringify(compat));
		if (compat.supportsAdditionalTools && compat.supportsMidConvoSystemMessages) {
			assert.equal(railBody.tools, undefined, "changing tools must all be declared in place");
			assert.equal(railBody.input.filter((item: any) => item.type === "additional_tools").length, 3);
		} else {
			assert.deepEqual(railBody.tools.map((entry: any) => entry.name), compat.supportsToolSearch ? ["read"] : ["read", "later"]);
		}
	}
});

test("ModelRegistry applies current auth and header transforms once before WSS and safe SSE fallback", { timeout: 5_000 }, async (t) => {
	const upgrades: Array<import("node:http").IncomingHttpHeaders> = [];
	const httpRequests: Array<import("node:http").IncomingHttpHeaders> = [];
	let rejectUpgrade = false;
	const server = createServer((request, response) => {
		httpRequests.push(request.headers);
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`data: ${JSON.stringify({ type: "response.completed", response: completedResponse("resp_fallback") })}\n\ndata: [DONE]\n\n`);
	});
	const websocket = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		upgrades.push(request.headers);
		if (rejectUpgrade) {
			socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		websocket.handleUpgrade(request, socket, head, (connected) => connected.on("message", () => {
			connected.send(JSON.stringify({ type: "response.completed", response: completedResponse("resp_headers") }));
		}));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("header fixture did not bind");
	t.after(async () => {
		for (const socket of websocket.clients) socket.terminate();
		websocket.close();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const registry = new ModelRegistry(runtime);
	const route = { provider: fixtureModel.provider, endpoint: `ws://127.0.0.1:${address.port}/v1/responses`, models: [fixtureModel.id] };
	const model = { ...fixtureModel, baseUrl: `http://127.0.0.1:${address.port}/v1`, headers: { "x-model": "retained", "x-remove": "model-value" } };
	const fallback: Provider["stream"] = (requestModel, context, options) => streamOpenAIResponses(requestModel as Model<"openai-responses">, context, options as OpenAIResponsesOptions | undefined);
	registry.registerProvider(model.provider, {
		api: "openai-responses", apiKey: "initial-key", baseUrl: model.baseUrl,
		headers: { "x-provider": "retained" }, models: [model],
		streamSimple: (requestModel, context, options) => streamResponsesWebSocketRoute(route, fallback, requestModel, context, options),
	});
	let headerCalls = 0;
	for (const key of ["first-key", "second-key"]) {
		await runtime.setRuntimeApiKey(model.provider, key);
		const result = await registry.streamSimple(model, { messages: [{ role: "user", content: "headers", timestamp: 1 }] }, {
			transport: "auto",
			transformHeaders: async (headers) => {
				headerCalls++;
				assert.equal(headers["x-provider"], "retained");
				return { ...headers, "x-extension": String(headerCalls), "x-remove": null };
			},
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		rejectUpgrade = true;
	}
	assert.equal(headerCalls, 2, "fallback reuses already transformed headers without invoking the hook again");
	assert.equal(upgrades.length, 2);
	assert.equal(httpRequests.length, 1);
	for (const [headers, key, hook] of [
		[upgrades[0]!, "first-key", "1"],
		[upgrades[1]!, "second-key", "2"],
		[httpRequests[0]!, "second-key", "2"],
	] as const) {
		assert.equal(headers.authorization, `Bearer ${key}`);
		assert.equal(headers["x-model"], "retained");
		assert.equal(headers["x-provider"], "retained");
		assert.equal(headers["x-extension"], hook);
		assert.equal(headers["x-remove"], undefined);
	}
});
