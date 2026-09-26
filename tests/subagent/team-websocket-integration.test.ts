import assert from "node:assert/strict";
import { createServer } from "node:https";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { FileAgentInstanceStore } from "../../tools/subagents/instance-store";
import { SessionBroker } from "../../tools/subagents/session-broker";
import { FileSessionLeaseManager } from "../../tools/subagents/session-lease";
import { SessionAgentRoster } from "../../tools/subagents/session-links";
import { createRpcWorkerFactory } from "../../tools/subagents/worker-factory";
import { TeamMemberDriver } from "../../tools/subagents/team-member-driver";
import { TeamRuntime } from "../../tools/subagents/team-runtime";
import { readRailResponsesWebSocketSettings } from "../../openai/responses-websocket/settings";

const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const providerFixture = fileURLToPath(new URL("../fixtures/team-websocket-provider.mjs", import.meta.url));
const certificate = fileURLToPath(new URL("../fixtures/team-websocket-cert.pem", import.meta.url));
const privateKey = fileURLToPath(new URL("../fixtures/team-websocket-key.pem", import.meta.url));
const nativeModel = {
	provider: "rail-team-ws",
	id: "probe",
	name: "Team WebSocket probe",
	api: "openai-responses",
	baseUrl: "https://team-websocket.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 1024,
};

type Scenario = "normal" | "cancel" | "v2" | "v2-cancel";
type Member = "A" | "B1" | "B2";
type Payload = Record<string, unknown> & { input?: unknown[]; type?: string };
type Decision =
	| { kind: "tool"; arguments: Record<string, unknown> }
	| { kind: "text"; text: string };

type CompletedTeamCall = {
	arguments: any;
	output: string;
};

interface LoopbackResponsesServer {
	endpoint: string;
	requests: Payload[];
	firstB2Request: Payload | undefined;
	firstV2WorkerRequest: Payload | undefined;
	handshakes: Array<{ url: string | undefined; authorization: string | string[] | undefined }>;
	errors: string[];
	openSockets: Set<WebSocket>;
	subscribe(listener: () => void): () => void;
	releaseFirstB2Response(): void;
	releaseFirstV2WorkerResponse(): void;
	close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function payloadText(body: Payload): string {
	return JSON.stringify(body.input ?? body);
}

function memberFromPayload(body: Payload): Member | undefined {
	const match = payloadText(body).match(/TEAM_MEMBER_(A|B[12])\b/u);
	return match?.[1] as Member | undefined;
}

function completedTeamCalls(body: Payload): CompletedTeamCall[] {
	const items = Array.isArray(body.input) ? body.input.filter(isRecord) : [];
	const outputs = new Map<string, string>();
	for (const item of items) {
		if (item["type"] !== "function_call_output" || typeof item["call_id"] !== "string") continue;
		const output = item["output"];
		outputs.set(item["call_id"], typeof output === "string" ? output : JSON.stringify(output));
	}
	const calls: CompletedTeamCall[] = [];
	for (const item of items) {
		if (item["type"] !== "function_call" || item["name"] !== "team" || typeof item["call_id"] !== "string") continue;
		const output = outputs.get(item["call_id"]);
		if (!output || !output.includes('"ok":true')) continue;
		try {
			const arguments_ = typeof item["arguments"] === "string" ? JSON.parse(item["arguments"]) : item["arguments"];
			if (isRecord(arguments_)) calls.push({ arguments: arguments_, output });
		} catch {
			// A malformed response is left for the native child to reject.
		}
	}
	return calls;
}

function hasCompletedCall(calls: CompletedTeamCall[], predicate: (arguments_: any) => boolean): boolean {
	return calls.some((call) => predicate(call.arguments));
}

function decideResponse(body: Payload, scenario: Scenario): Decision {
	const member = memberFromPayload(body);
	if (!member) return { kind: "text", text: "WS_PROTOCOL_ERROR: member identity missing" };
	if (scenario === "v2" || scenario === "v2-cancel") {
		if (member === "B1") return { kind: "tool", arguments: { action: "reply", result: { status: "succeeded", summary: "WS_V2_B1_NATIVE_RESULT" } } };
		return { kind: "text", text: "WS_V2_MANAGER_NATIVE_CONTEXT" };
	}
	if (scenario === "cancel") return member === "A"
		? { kind: "tool", arguments: { action: "wait", wait: { kind: "member", member: "B1" } } }
		: { kind: "tool", arguments: { action: "wait", wait: { kind: "message" } } };

	const text = payloadText(body);
	const calls = completedTeamCalls(body);
	if (member === "A") {
		const barrier = calls.find((call) => call.arguments.action === "wait" && call.arguments.wait?.kind === "workers");
		if (barrier || text.includes("All workers have settled.")) {
			const results = barrier ? JSON.parse(barrier.output).snapshot?.members : undefined;
			if (barrier && (!Array.isArray(results) || !["B1", "B2"].every((id) => results.some((result) => result.id === id && result.state === "completed" && result.output === `${id}_NATIVE_RESULT`)))) {
				return { kind: "text", text: "WS_PROTOCOL_ERROR: final barrier missing native results" };
			}
			return { kind: "text", text: "WS_FINAL: B1_NATIVE_RESULT and B2_NATIVE_RESULT" };
		}
		if (!hasCompletedCall(calls, (arguments_) => arguments_.action === "control" && arguments_.to === "B1" && arguments_.command === "pause")) {
			return { kind: "tool", arguments: { action: "control", to: "B1", command: "pause" } };
		}
		if (!hasCompletedCall(calls, (arguments_) => arguments_.action === "control" && arguments_.to === "B1" && arguments_.command === "redirect")) {
			return { kind: "tool", arguments: { action: "control", to: "B1", command: "redirect", message: "B1_RESUMED" } };
		}
		if (!hasCompletedCall(calls, (arguments_) => arguments_.action === "wait" && arguments_.wait?.kind === "member" && arguments_.wait?.member === "B2")) {
			return { kind: "tool", arguments: { action: "wait", wait: { kind: "member", member: "B2" } } };
		}
		if (!hasCompletedCall(calls, (arguments_) => arguments_.action === "control" && arguments_.to === "B1" && arguments_.command === "resume")) {
			return { kind: "tool", arguments: { action: "control", to: "B1", command: "resume" } };
		}
		if (!hasCompletedCall(calls, (arguments_) => arguments_.action === "wait" && arguments_.wait?.kind === "workers")) {
			return { kind: "tool", arguments: { action: "wait", wait: { kind: "workers" } } };
		}
		return { kind: "text", text: "WS_PROTOCOL_ERROR: coordinator advanced without the final barrier" };
	}
	if (member === "B1") {
		if (text.includes("B1_RESUMED")) return { kind: "text", text: "B1_NATIVE_RESULT" };
		return { kind: "tool", arguments: { action: "wait", wait: { kind: "message" } } };
	}
	return { kind: "text", text: "B2_NATIVE_RESULT" };
}

async function startLoopbackResponsesServer(scenario: Scenario): Promise<LoopbackResponsesServer> {
	const server = createServer({ key: await readFile(privateKey), cert: await readFile(certificate) });
	const websocket = new WebSocketServer({ server });
	const requests: Payload[] = [];
	let firstB2Request: Payload | undefined;
	let heldFirstB2Response: (() => void) | undefined;
	let firstB2ResponseReleased = false;
	let firstV2WorkerRequest: Payload | undefined;
	let heldFirstV2WorkerResponse: (() => void) | undefined;
	let firstV2WorkerResponseReleased = false;
	const handshakes: Array<{ url: string | undefined; authorization: string | string[] | undefined }> = [];
	const errors: string[] = [];
	const openSockets = new Set<WebSocket>();
	const listeners = new Set<() => void>();
	const timers = new Set<NodeJS.Timeout>();
	let closed = false;
	const notify = () => { for (const listener of listeners) listener(); };
	const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
	const recordError = (message: string) => { errors.push(message); notify(); };

	websocket.on("connection", (socket, request) => {
		openSockets.add(socket);
		handshakes.push({ url: request.url, authorization: request.headers.authorization });
		notify();
		socket.on("close", () => { openSockets.delete(socket); notify(); });
		socket.on("error", (error) => recordError(`socket: ${error.message}`));
		socket.on("message", (raw) => {
			let body: Payload;
			try {
				body = JSON.parse(raw.toString()) as Payload;
			} catch (error) {
				recordError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			requests.push(body);
			if (body.type !== "response.create") recordError(`unexpected request type: ${String(body.type)}`);
			if (!Array.isArray(body.input)) recordError("Responses request did not contain an input array");
			const member = memberFromPayload(body);
			const holdFirstB2Response = scenario === "normal" && member === "B2" && firstB2Request === undefined;
			const holdFirstV2WorkerResponse = scenario === "v2-cancel" && member === "B1" && firstV2WorkerRequest === undefined;
			const decision = decideResponse(body, scenario);
			const requestNumber = requests.length;
			const sendResponse = () => {
				if (socket.readyState !== WebSocket.OPEN) return;
				const responseId = `ws_response_${requestNumber}`;
				const item = decision.kind === "tool"
					? { type: "function_call", id: `fc_ws_${requestNumber}`, call_id: `call_ws_${requestNumber}`, name: "team", arguments: JSON.stringify(decision.arguments), status: "completed" }
					: { type: "message", id: `msg_ws_${requestNumber}`, role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: decision.text, annotations: [] }] };
				const usageInput = Math.max(1, Array.isArray(body.input) ? body.input.length : 1);
				for (const event of [
					{ type: "response.created", response: { id: responseId, status: "in_progress" } },
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response: { id: responseId, status: "completed", output: [item], usage: { input_tokens: usageInput, output_tokens: 1, total_tokens: usageInput + 1 } } },
				]) socket.send(JSON.stringify(event));
			};
			if (holdFirstB2Response) {
				firstB2Request = body;
				heldFirstB2Response = sendResponse;
				notify();
				return;
			}
			if (holdFirstV2WorkerResponse) {
				firstV2WorkerRequest = body;
				heldFirstV2WorkerResponse = sendResponse;
				notify();
				return;
			}
			let timer: NodeJS.Timeout;
			timer = setTimeout(() => {
				timers.delete(timer);
				sendResponse();
			}, 0);
			timers.add(timer);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Team WebSocket server did not expose a TCP port");
	return {
		endpoint: `wss://127.0.0.1:${(address as AddressInfo).port}/v1/responses`,
		requests,
		get firstB2Request() { return firstB2Request; },
		get firstV2WorkerRequest() { return firstV2WorkerRequest; },
		handshakes,
		errors,
		openSockets,
		subscribe,
		releaseFirstB2Response: () => {
			if (firstB2ResponseReleased) throw new Error("First B2 response latch was already released");
			if (!firstB2Request || !heldFirstB2Response) throw new Error("First B2 response is not waiting on the latch");
			firstB2ResponseReleased = true;
			const release = heldFirstB2Response;
			heldFirstB2Response = undefined;
			release();
		},
		releaseFirstV2WorkerResponse: () => {
			if (firstV2WorkerResponseReleased) throw new Error("First v2 worker response latch was already released");
			if (!firstV2WorkerRequest || !heldFirstV2WorkerResponse) throw new Error("First v2 worker response is not waiting on the latch");
			firstV2WorkerResponseReleased = true;
			const release = heldFirstV2WorkerResponse;
			heldFirstV2WorkerResponse = undefined;
			release();
		},
		close: async () => {
			if (closed) return;
			closed = true;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			for (const socket of openSockets) socket.terminate();
			await new Promise<void>((resolve) => {
				try { websocket.close(() => resolve()); } catch { resolve(); }
			});
			await new Promise<void>((resolve) => {
				if (!server.listening) { resolve(); return; }
				server.close(() => resolve());
			});
		},
	};
}

function waitForServer(server: LoopbackResponsesServer, predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
	if (predicate()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { off(); reject(new Error(message)); }, timeoutMs);
		const off = server.subscribe(() => {
			if (!predicate()) return;
			clearTimeout(timer);
			off();
			resolve();
		});
	});
}

function waitForDelay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setupV2(t: TestContext, server: LoopbackResponsesServer, scenario: "v2" | "v2-cancel") {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-team-v2-websocket-"));
	const agentDir = join(sandbox, "agent");
	await mkdir(join(agentDir, "rail-openai-responses-ws"), { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		transport: "websocket", websocketConnectTimeoutMs: 2000, httpIdleTimeoutMs: 5000,
		retry: { enabled: false },
	}));
	await writeFile(join(agentDir, "rail-openai-responses-ws", "settings.json"), JSON.stringify({
		version: 1, routes: [{ provider: nativeModel.provider, endpoint: server.endpoint, models: [nativeModel.id] }],
	}));

	const environmentKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY", "PI_SKIP_VERSION_CHECK", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "NO_PROXY", "no_proxy"] as const;
	const previousEnvironment = new Map<string, string | undefined>(environmentKeys.map((key) => [key, process.env[key]]));
	process.env["HOME"] = sandbox;
	process.env["XDG_CONFIG_HOME"] = join(sandbox, "config");
	process.env["XDG_DATA_HOME"] = join(sandbox, "data");
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	process.env["PI_OFFLINE"] = "1";
	process.env["PI_TELEMETRY"] = "0";
	process.env["PI_SKIP_VERSION_CHECK"] = "1";
	process.env["NODE_EXTRA_CA_CERTS"] = certificate;
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "http_proxy", "https_proxy", "all_proxy", "ftp_proxy"]) delete process.env[key];
	process.env["NO_PROXY"] = "127.0.0.1,localhost,::1";
	process.env["no_proxy"] = "127.0.0.1,localhost,::1";

	const stateDir = join(agentDir, "stateful-subagents");
	const store = new FileAgentInstanceStore(stateDir);
	const leases = new FileSessionLeaseManager(stateDir);
	const broker = new SessionBroker({
		store, roster: new SessionAgentRoster(), defaultCwd: sandbox, aliasLeaseManager: leases,
		workerFactory: createRpcWorkerFactory({
			stateDir, startupTimeoutMs: 15_000,
			resolveInvocation: (args) => ({ command: process.execPath, args: [cli, "--no-extensions", "--offline", ...args, "-e", providerFixture] }),
		}),
	});
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "A", roleDescription: "TEAM_MEMBER_A manages this Team.", model: "rail-team-ws/probe", cwd: sandbox, fastMode: false },
		workers: [{ alias: "B1", roleDescription: "TEAM_MEMBER_B1 completes assigned work.", model: "rail-team-ws/probe", cwd: sandbox, fastMode: false }],
		brief: { goal: "Verify Stage B Team v2 over the configured Responses WebSocket." },
		initialRequests: [{ to: "B1", task: "TEAM_MEMBER_B1 complete the native WebSocket work", inputRefs: [] }], timeoutSeconds: 45,
	});
	const driver = new TeamMemberDriver(runtime, broker);
	const model = { provider: nativeModel.provider, modelId: nativeModel.id };
	const handles = new Map<string, Awaited<ReturnType<TeamMemberDriver["openMember"]>>>();
	for (const memberId of ["A", "B1"]) handles.set(memberId, await driver.openMember({ teamId: prepared.teamId, memberId, model, cwd: sandbox }));
	t.after(async () => {
		const failures: unknown[] = [];
		try { await driver.close(); } catch (error) { failures.push(error); }
		try { await broker.shutdown(); } catch (error) { failures.push(error); }
		for (const key of environmentKeys) {
			const value = previousEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		try { await rm(sandbox, { recursive: true, force: true }); } catch (error) { failures.push(error); }
		if (failures.length) throw new AggregateError(failures, "Team WebSocket harness cleanup failed");
	});
	return { runtime, teamId: prepared.teamId, driver, handles, store, leases, broker, agentDir, scenario };
}

test("Stage B Team v2 actors use the configured Responses WebSocket for native input and tool settlement", { timeout: 90000 }, async (t) => {
	const server = await startLoopbackResponsesServer("v2");
	t.after(async () => { await server.close(); });
	const harness = await setupV2(t, server, "v2");
	harness.runtime.launch(harness.teamId);
	const manager = await harness.driver.runNext(harness.teamId);
	assert.equal(manager?.completion.status, "success");
	const worker = await harness.driver.runNext(harness.teamId);
	assert.equal(worker?.completion.appliedToolCallId !== undefined, true, "v2 reply is applied only after native tool-result evidence");
	assert.equal(harness.runtime.getTeam(harness.teamId).works.resolved, 1);
	assert.equal(server.errors.length, 0, server.errors.join("; "));
	assert.ok(server.handshakes.length >= 2);
	assert.ok(server.handshakes.every((handshake) => handshake.url === "/v1/responses" && handshake.authorization === "Bearer team-websocket-test-key"));
	assert.equal(server.requests.length, 2, "one management activation and one worker activation reach the native WebSocket provider");
	assert.ok(server.requests.every((request) => request["type"] === "response.create" && request["previous_response_id"] === undefined));
	const workerRequest = server.requests.find((request) => memberFromPayload(request) === "B1");
	assert.ok(workerRequest);
	assert.ok(payloadText(workerRequest).includes("TEAM_MEMBER_B1"), "provider receives the real activation task from native Session context");
	assert.ok(Array.isArray(workerRequest["tools"]) && workerRequest["tools"].some((tool: any) => tool.name === "team"));
	assert.deepEqual(readRailResponsesWebSocketSettings(harness.agentDir).routes,
		[{ provider: nativeModel.provider, endpoint: server.endpoint, models: [nativeModel.id] }]);
	await harness.driver.close();
	await waitForServer(server, () => server.openSockets.size === 0, "Team v2 close left a WebSocket open", 10000);
});

test("Stage B Team v2 cancellation aborts a held native WebSocket run without another provider request", { timeout: 60000 }, async (t) => {
	const server = await startLoopbackResponsesServer("v2-cancel");
	t.after(async () => { await server.close(); });
	const harness = await setupV2(t, server, "v2-cancel");
	harness.runtime.launch(harness.teamId);
	const manager = await harness.driver.runNext(harness.teamId);
	assert.equal(manager?.completion.status, "success");
	const controller = new AbortController();
	const running = harness.driver.runNext(harness.teamId, { signal: controller.signal });
	await waitForServer(server, () => server.firstV2WorkerRequest !== undefined, "worker never reached the held WebSocket response");
	const requestCount = server.requests.length;
	await waitForDelay(50);
	controller.abort();
	const worker = await running;
	assert.equal(worker?.completion.status, "aborted", "driver waits for actual Pi settlement after the explicit abort");
	await waitForDelay(100);
	assert.equal(server.requests.length, requestCount, "abort does not trigger a provider polling request");
	assert.equal(harness.runtime.getTeam(harness.teamId).works.failed, 1);
	assert.equal(server.errors.length, 0, server.errors.join("; "));
	await harness.driver.close();
	await waitForServer(server, () => server.openSockets.size === 0, "aborted Team v2 session left a WebSocket open", 10000);
});
