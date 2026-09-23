import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
	closeRailResponsesWebSocketSessions,
	getRailResponsesWebSocketStats,
	isResponsesWebSocketContinuationError,
	isSafeResponsesWebSocketFallback,
	ResponsesWebSocketError,
	ResponsesWebSocketHandshakeError,
	resetRailResponsesWebSocketStats,
	runResponsesWebSocketRequest,
} from "../../openai/responses-websocket/transport";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

test("only pre-generation handshake and routing failures are safe SSE fallbacks", () => {
	assert.equal(isSafeResponsesWebSocketFallback(new ResponsesWebSocketHandshakeError("connect failed")), true);
	assert.equal(isSafeResponsesWebSocketFallback(new ResponsesWebSocketError("no available distributor", "model_not_found")), true);
	assert.equal(isSafeResponsesWebSocketFallback(new ResponsesWebSocketError("分组 home 下模型无可用渠道")), true);
	assert.equal(isSafeResponsesWebSocketFallback(new ResponsesWebSocketError("stream failed", "server_error")), false);
	assert.equal(isSafeResponsesWebSocketFallback(new Error("network failed after output")), false);
	assert.equal(isResponsesWebSocketContinuationError(new ResponsesWebSocketError("cached response expired", "previous_response_not_found")), true);
	assert.equal(isResponsesWebSocketContinuationError(new ResponsesWebSocketError("stream failed", "server_error")), false);
});

test("Responses WebSocket transport reuses a session connection and sends an input delta", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	const received: Array<Record<string, unknown>> = [];
	const observedEvents: string[] = [];
	server.on("connection", (socket, request) => {
		assert.equal(request.headers.authorization, "Bearer test-key");
		assert.equal(request.url, "/v1/responses");
		socket.on("message", (data) => {
			const body = JSON.parse(data.toString()) as Record<string, unknown>;
			received.push(body);
			const responseId = `resp_${received.length}`;
			socket.send(JSON.stringify({ type: "response.created", response: { id: responseId, status: "in_progress" } }));
			socket.send(JSON.stringify({
				type: "response.completed",
				response: { id: responseId, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
			}));
		});
	});
	const sessionId = "transport-test";
	t.after(() => {
		closeRailResponsesWebSocketSessions(sessionId);
		resetRailResponsesWebSocketStats(sessionId);
		server.close();
	});
	const firstBody = { model: "gpt-test", stream: true, store: false, input: [{ role: "user", content: "first" }] };
	const first = await runResponsesWebSocketRequest(firstBody, {
		endpoint,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		useCachedContext: true,
		onStart: () => undefined,
		onEvent: (event) => observedEvents.push(String(event.type)),
		responseItems: () => [{ type: "message", role: "assistant", content: "answer" }],
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	for await (const _event of first.events) {
		// Drain the terminal event.
	}
	first.finalize("resp_1");
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(runResponsesWebSocketRequest(firstBody, {
		endpoint,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		signal: aborted.signal,
		useCachedContext: true,
		onStart: () => undefined,
		responseItems: () => [],
	}), /aborted/u);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(received.length, 1, "a pre-aborted cached request must not reach the provider");
	const secondBody = {
		...firstBody,
		input: [
			...firstBody.input,
			{ type: "message", role: "assistant", content: "answer" },
			{ role: "user", content: "second" },
		],
	};
	const second = await runResponsesWebSocketRequest(secondBody, {
		endpoint,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		useCachedContext: true,
		onStart: () => undefined,
		responseItems: () => [],
	});
	for await (const _event of second.events) {
		// Drain the terminal event.
	}
	second.finalize("resp_2");
	assert.equal(received.length, 2);
	assert.equal(received[0]?.["type"], "response.create");
	assert.equal(observedEvents.includes("response.completed"), true);
	assert.equal(received[1]?.["previous_response_id"], "resp_1");
	assert.deepEqual(received[1]?.["input"], [{ role: "user", content: "second" }]);
	assert.deepEqual(getRailResponsesWebSocketStats(sessionId), {
		requests: 2,
		connectionsCreated: 1,
		connectionsReused: 1,
		fullContextRequests: 1,
		deltaRequests: 1,
		lastPreviousResponseId: "resp_1",
	});
});

test("Responses WebSocket connection identity includes provider headers", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	const handshakes: Array<string | undefined> = [];
	const requests: Array<Record<string, unknown>> = [];
	server.on("connection", (socket, request) => {
		handshakes.push(request.headers["x-tenant"] as string | undefined);
		socket.on("message", (data) => {
			const body = JSON.parse(data.toString()) as Record<string, unknown>;
			requests.push(body);
			const id = `resp_${requests.length}`;
			socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
		});
	});
	const sessionId = "header-scope-test";
	t.after(() => {
		closeRailResponsesWebSocketSessions(sessionId);
		server.close();
	});
	const body = { model: "gpt-test", stream: true, input: [{ role: "user", content: "first" }] };
	for (const tenant of ["one", "two"]) {
		const request = await runResponsesWebSocketRequest(body, {
			endpoint,
			provider: "test-provider",
			apiKey: "test-key",
			headers: { "x-tenant": tenant },
			sessionId,
			useCachedContext: true,
			onStart: () => undefined,
			responseItems: () => [],
		});
		for await (const _event of request.events) {
			// Drain the terminal event.
		}
		request.finalize(`resp_${requests.length}`);
	}
	assert.deepEqual(handshakes, ["one", "two"]);
	assert.equal(requests[1]?.["previous_response_id"], undefined);
});

test("Responses WebSocket preserves an explicit response chain and reserves the create command", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	const requests: Array<Record<string, unknown>> = [];
	server.on("connection", (socket) => {
		socket.on("message", (data) => {
			requests.push(JSON.parse(data.toString()) as Record<string, unknown>);
			const id = `resp_${requests.length}`;
			socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
		});
	});
	const sessionId = "explicit-chain-test";
	t.after(() => {
		closeRailResponsesWebSocketSessions(sessionId);
		server.close();
	});
	const first = await runResponsesWebSocketRequest({ model: "gpt-test", stream: true, input: [] }, {
		endpoint,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		useCachedContext: true,
		onStart: () => undefined,
		responseItems: () => [],
	});
	for await (const _event of first.events) {
		// Drain the terminal event.
	}
	first.finalize("resp_1");
	const second = await runResponsesWebSocketRequest({
		type: "response.cancel",
		model: "gpt-test",
		stream: true,
		input: [],
		previous_response_id: "resp_external",
	}, {
		endpoint,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		useCachedContext: true,
		onStart: () => undefined,
		responseItems: () => [],
	});
	for await (const _event of second.events) {
		// Drain the terminal event.
	}
	second.finalize("resp_2");
	assert.equal(requests[1]?.["type"], "response.create");
	assert.equal(requests[1]?.["previous_response_id"], "resp_external");
});

test("Responses WebSocket continuation requires array input", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	const requests: Array<Record<string, unknown>> = [];
	server.on("connection", (socket) => {
		socket.on("message", (data) => {
			requests.push(JSON.parse(data.toString()) as Record<string, unknown>);
			const id = `resp_${requests.length}`;
			socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
		});
	});
	const sessionId = "string-input-test";
	t.after(() => {
		closeRailResponsesWebSocketSessions(sessionId);
		server.close();
	});
	for (const input of ["first", "second"]) {
		const request = await runResponsesWebSocketRequest({ model: "gpt-test", stream: true, input }, {
			endpoint,
			provider: "test-provider",
			apiKey: "test-key",
			sessionId,
			useCachedContext: true,
			onStart: () => undefined,
			responseItems: () => [],
		});
		for await (const _event of request.events) {
			// Drain the terminal event.
		}
		request.finalize(`resp_${requests.length}`);
	}
	assert.equal(requests[1]?.["input"], "second");
	assert.equal(requests[1]?.["previous_response_id"], undefined);
});

test("a terminal response without a successful id clears the cached continuation", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	const requests: Array<Record<string, unknown>> = [];
	server.on("connection", (socket) => {
		socket.on("message", (data) => {
			requests.push(JSON.parse(data.toString()) as Record<string, unknown>);
			const id = `resp_${requests.length}`;
			const type = requests.length === 2 ? "response.incomplete" : "response.completed";
			socket.send(JSON.stringify({ type, response: { id, status: type === "response.incomplete" ? "incomplete" : "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
		});
	});
	const sessionId = "terminal-clear-test";
	t.after(() => {
		closeRailResponsesWebSocketSessions(sessionId);
		server.close();
	});
	const inputs = [
		[{ role: "user", content: "one" }],
		[{ role: "user", content: "one" }, { role: "user", content: "two" }],
		[{ role: "user", content: "one" }, { role: "user", content: "two" }, { role: "user", content: "three" }],
	];
	for (let index = 0; index < inputs.length; index += 1) {
		const request = await runResponsesWebSocketRequest({ model: "gpt-test", stream: true, input: inputs[index] }, {
			endpoint,
			provider: "test-provider",
			apiKey: "test-key",
			sessionId,
			useCachedContext: true,
			onStart: () => undefined,
			responseItems: () => [],
		});
		for await (const _event of request.events) {
			// Drain the terminal event.
		}
		request.finalize(index === 1 ? undefined : `resp_${index + 1}`);
	}
	assert.equal(requests[1]?.["previous_response_id"], "resp_1");
	assert.equal(requests[2]?.["previous_response_id"], undefined);
	assert.deepEqual(requests[2]?.["input"], inputs[2]);
});

test("Responses WebSocket respects explicit and header-only authentication", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	const handshakes: Array<Record<string, string | string[] | undefined>> = [];
	server.on("headers", (headers) => headers.push("X-Rail-Upgrade: observed"));
	server.on("connection", (socket, request) => {
		handshakes.push(request.headers);
		socket.on("message", () => {
			const id = `resp_${handshakes.length}`;
			socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
		});
	});
	t.after(() => server.close());
	const body = { model: "gpt-test", stream: true, input: [] };
	const explicit = await runResponsesWebSocketRequest(body, {
		endpoint,
		provider: "test-provider",
		apiKey: "fallback-key",
		headers: {
			authorization: "Bearer explicit-key",
			"user-agent": "custom-agent",
			"x-client-request-id": "custom-request",
			"session-id": "custom-session",
		},
		useCachedContext: false,
		onStart: () => undefined,
		responseItems: () => [],
	});
	for await (const _event of explicit.events) {
		// Drain the terminal event.
	}
	explicit.finalize("resp_1");
	assert.equal(explicit.response.status, 101);
	assert.equal(explicit.response.headers["x-rail-upgrade"], "observed");
	const headerOnly = await runResponsesWebSocketRequest(body, {
		endpoint,
		provider: "test-provider",
		headers: { Authorization: null, "cf-aig-authorization": "Bearer gateway-key" },
		useCachedContext: false,
		onStart: () => undefined,
		responseItems: () => [],
	});
	for await (const _event of headerOnly.events) {
		// Drain the terminal event.
	}
	headerOnly.finalize("resp_2");
	const dualAuth = await runResponsesWebSocketRequest(body, {
		endpoint,
		provider: "test-provider",
		apiKey: "upstream-key",
		headers: { "cf-aig-authorization": "Bearer gateway-key" },
		useCachedContext: false,
		onStart: () => undefined,
		responseItems: () => [],
	});
	for await (const _event of dualAuth.events) {
		// Drain the terminal event.
	}
	dualAuth.finalize("resp_3");
	assert.equal(handshakes[0]?.["authorization"], "Bearer explicit-key");
	assert.equal(handshakes[0]?.["user-agent"], "custom-agent");
	assert.equal(handshakes[0]?.["x-client-request-id"], "custom-request");
	assert.equal(handshakes[0]?.["session-id"], "custom-session");
	assert.equal(handshakes[1]?.["authorization"], undefined);
	assert.equal(handshakes[1]?.["cf-aig-authorization"], "Bearer gateway-key");
	assert.equal(handshakes[2]?.["authorization"], "Bearer upstream-key");
	assert.equal(handshakes[2]?.["cf-aig-authorization"], "Bearer gateway-key");
	await assert.rejects(runResponsesWebSocketRequest(body, {
		endpoint,
		provider: "test-provider",
		headers: { Authorization: null },
		useCachedContext: false,
		onStart: () => undefined,
		responseItems: () => [],
	}), /No API key or authorization header/u);
});

test("concurrent cold-cache requests do not orphan a session WebSocket", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	const openSockets = new Set<any>();
	const pending: any[] = [];
	let nextResponse = 0;
	server.on("connection", (socket) => {
		openSockets.add(socket);
		socket.on("close", () => openSockets.delete(socket));
		socket.on("message", () => {
			pending.push(socket);
			if (pending.length !== 2) return;
			for (const target of pending.splice(0)) {
				nextResponse += 1;
				target.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${nextResponse}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
			}
		});
	});
	const sessionId = "concurrent-cold-cache";
	t.after(() => {
		closeRailResponsesWebSocketSessions(sessionId);
		server.close();
	});
	const body = { model: "gpt-test", stream: true, input: [] };
	const options = {
		endpoint,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		useCachedContext: true,
		onStart: () => undefined,
		responseItems: () => [],
	};
	const requests = await Promise.all([
		runResponsesWebSocketRequest(body, options),
		runResponsesWebSocketRequest(body, options),
	]);
	await Promise.all(requests.map(async (request, index) => {
		for await (const _event of request.events) {
			// Drain the terminal event.
		}
		request.finalize(`resp_${index + 1}`);
	}));
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(openSockets.size, 1, "only the cache winner should remain open");
	closeRailResponsesWebSocketSessions(sessionId);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(openSockets.size, 0, "session cleanup must close the cache winner");
});

test("session cleanup during a pending WebSocket upgrade prevents the request", { timeout: 5_000 }, async (t) => {
	let releaseUpgrade!: () => void;
	const upgradeGate = new Promise<void>((resolve) => { releaseUpgrade = resolve; });
	let notifyUpgradeStarted!: () => void;
	const upgradeStarted = new Promise<void>((resolve) => { notifyUpgradeStarted = resolve; });
	let requestsReceived = 0;
	const server = new WebSocketServer({
		port: 0,
		verifyClient: (_info, callback) => {
			notifyUpgradeStarted();
			void upgradeGate.then(() => callback(true));
		},
	});
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const sessionId = "cleanup-during-upgrade";
	server.on("connection", (socket) => socket.on("message", () => { requestsReceived += 1; }));
	t.after(() => {
		releaseUpgrade();
		closeRailResponsesWebSocketSessions(sessionId);
		server.close();
	});
	const request = runResponsesWebSocketRequest({ model: "gpt-test", stream: true, input: [] }, {
		endpoint: `ws://127.0.0.1:${address.port}/v1/responses`,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		connectTimeoutMs: 2_000,
		useCachedContext: true,
		onStart: () => undefined,
		responseItems: () => [],
	});
	await withTimeout(upgradeStarted, 1_000, "the delayed WebSocket upgrade");
	closeRailResponsesWebSocketSessions(sessionId);
	releaseUpgrade();
	await assert.rejects(request, /session was cleaned up while connecting/u);
	assert.equal(requestsReceived, 0, "a connection completing after cleanup must not receive response.create");
});

test("session cleanup closes both concurrent active sockets, including the overflow socket", { timeout: 5_000 }, async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	const openSockets = new Set<any>();
	let connectionCount = 0;
	let requestCount = 0;
	let notifyBothRequests!: () => void;
	const bothRequestsReceived = new Promise<void>((resolve) => { notifyBothRequests = resolve; });
	let notifyAllClosed!: () => void;
	const allSocketsClosed = new Promise<void>((resolve) => { notifyAllClosed = resolve; });
	server.on("connection", (socket) => {
		connectionCount += 1;
		openSockets.add(socket);
		socket.on("close", () => {
			openSockets.delete(socket);
			if (connectionCount === 2 && openSockets.size === 0) notifyAllClosed();
		});
		socket.on("message", () => {
			requestCount += 1;
			if (requestCount === 2) notifyBothRequests();
		});
	});
	const sessionId = "cleanup-concurrent-overflow";
	t.after(() => {
		closeRailResponsesWebSocketSessions(sessionId);
		server.close();
	});
	const options = {
		endpoint,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		connectTimeoutMs: 2_000,
		useCachedContext: true,
		onStart: () => undefined,
		responseItems: () => [],
	};
	const requests = await withTimeout(Promise.all([
		runResponsesWebSocketRequest({ model: "gpt-test", stream: true, input: [] }, options),
		runResponsesWebSocketRequest({ model: "gpt-test", stream: true, input: [] }, options),
	]), 2_000, "both concurrent WebSocket connections");
	await withTimeout(bothRequestsReceived, 1_000, "both active requests");
	const drains = requests.map(async (request) => {
		try {
			for await (const _event of request.events) {
				// Cleanup should terminate both active streams.
			}
			return undefined;
		} catch (error) {
			return error;
		}
	});
	closeRailResponsesWebSocketSessions(sessionId);
	const outcomes = await withTimeout(Promise.all(drains), 1_000, "both active streams to close");
	await withTimeout(allSocketsClosed, 1_000, "both server-side WebSocket closes");
	assert.equal(connectionCount, 2);
	assert.equal(requestCount, 2);
	assert.ok(outcomes.every((outcome) => outcome instanceof Error), "cleanup must fail both active requests");
	assert.equal(openSockets.size, 0, "cleanup must close both the cached socket and its concurrent overflow");
});

test("closing one Responses WebSocket session preserves another session cache", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	let connections = 0;
	let responses = 0;
	server.on("connection", (socket) => {
		connections += 1;
		socket.on("message", () => {
			responses += 1;
			socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${responses}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
		});
	});
	t.after(() => {
		closeRailResponsesWebSocketSessions();
		server.close();
	});
	const invoke = async (sessionId: string) => {
		const request = await runResponsesWebSocketRequest({ model: "gpt-test", stream: true, input: [] }, {
			endpoint,
			provider: "test-provider",
			apiKey: "test-key",
			sessionId,
			useCachedContext: true,
			onStart: () => undefined,
			responseItems: () => [],
		});
		for await (const _event of request.events) {
			// Drain the terminal event.
		}
		request.finalize(`resp_${responses}`);
	};
	await invoke("session-one");
	await invoke("session-two");
	assert.equal(connections, 2);
	closeRailResponsesWebSocketSessions("session-one");
	await invoke("session-two");
	assert.equal(connections, 2, "the unaffected session should reuse its connection");
	await invoke("session-one");
	assert.equal(connections, 3, "the closed session should establish a new connection");
});

test("an idle cached socket protocol error is handled and evicted", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP port");
	const endpoint = `ws://127.0.0.1:${address.port}/v1/responses`;
	let connections = 0;
	let firstSocket: any;
	server.on("connection", (socket) => {
		connections += 1;
		if (!firstSocket) firstSocket = socket;
		socket.on("message", () => {
			socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${connections}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
		});
	});
	const sessionId = "idle-error-session";
	t.after(() => {
		closeRailResponsesWebSocketSessions(sessionId);
		server.close();
	});
	const body = { model: "gpt-test", stream: true, input: [] };
	const first = await runResponsesWebSocketRequest(body, {
		endpoint,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		useCachedContext: true,
		onStart: () => undefined,
		responseItems: () => [],
	});
	for await (const _event of first.events) {
		// Drain the terminal event.
	}
	first.finalize("resp_1");
	firstSocket._socket.write(Buffer.from([0x83, 0x00]));
	await new Promise((resolve) => setTimeout(resolve, 30));
	const second = await runResponsesWebSocketRequest(body, {
		endpoint,
		provider: "test-provider",
		apiKey: "test-key",
		sessionId,
		useCachedContext: true,
		onStart: () => undefined,
		responseItems: () => [],
	});
	for await (const _event of second.events) {
		// Drain the terminal event.
	}
	second.finalize("resp_2");
	assert.equal(connections, 2);
});

test("Responses WebSocket handshake timeout rejects without an uncaught socket error", async (t) => {
	const server = createServer(() => {
		// Keep the TCP connection open without completing the WebSocket upgrade.
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("TCP test server did not expose a port");
	t.after(() => server.close());
	await assert.rejects(runResponsesWebSocketRequest(
		{ model: "gpt-test", stream: true, input: [] },
		{
			endpoint: `ws://127.0.0.1:${address.port}/v1/responses`,
			provider: "test-provider",
			apiKey: "test-key",
			connectTimeoutMs: 20,
			useCachedContext: false,
			onStart: () => undefined,
			responseItems: () => [],
		},
	), ResponsesWebSocketHandshakeError);
});