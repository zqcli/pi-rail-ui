import assert from "node:assert/strict";
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
	let registeredConfig: any = { api: "legacy-responses", headers: { "x-original": "1" } };
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
		assert.deepEqual(registeredConfig, { api: "legacy-responses", headers: { "x-original": "1" } });
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		registeredConfig = { ...registeredConfig, api: "newer-responses" };
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		assert.deepEqual(registeredConfig, { api: "newer-responses", headers: { "x-original": "1" } });
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