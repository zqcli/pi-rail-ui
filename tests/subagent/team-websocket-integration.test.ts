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
import { TeamHub } from "../../tools/subagents/team-hub";
import { TeamRunManager } from "../../tools/subagents/team-runner";
import { installTeamTool } from "../../tools/subagents/team-tool";
import { installStatefulSubagentTool } from "../../tools/subagents/tool";
import { createRpcWorkerFactory } from "../../tools/subagents/worker-factory";
import { readRailResponsesWebSocketSettings } from "../../openai/responses-websocket/settings";
import type { TeamSnapshot } from "../../tools/subagents/team-protocol";

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

type Scenario = "normal" | "cancel";
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
	handshakes: Array<{ url: string | undefined; authorization: string | string[] | undefined }>;
	errors: string[];
	openSockets: Set<WebSocket>;
	subscribe(listener: () => void): () => void;
	releaseFirstB2Response(): void;
	close(): Promise<void>;
}

interface Harness {
	hub: TeamHub;
	teamId: string;
	history: TeamSnapshot[];
	tools: Map<string, any>;
	ctx: any;
	dispatch(): [Promise<any>, Promise<any>];
	journal(alias: string): Promise<any[]>;
	store: FileAgentInstanceStore;
	leases: FileSessionLeaseManager;
	broker: SessionBroker;
	agentDir: string;
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

function waitForSnapshot(hub: TeamHub, teamId: string, predicate: (snapshot: TeamSnapshot) => boolean, message: string, timeoutMs = 15_000): Promise<void> {
	if (predicate(hub.get(teamId))) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { off(); reject(new Error(message)); }, timeoutMs);
		const off = hub.subscribe((snapshot) => {
			if (snapshot.id !== teamId || !predicate(snapshot)) return;
			clearTimeout(timer);
			off();
			resolve();
		});
	});
}

function waitForDelay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setup(t: TestContext, server: LoopbackResponsesServer, scenario: Scenario): Promise<Harness> {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-team-websocket-"));
	const agentDir = join(sandbox, "agent");
	await mkdir(join(agentDir, "rail-openai-responses-ws"), { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		transport: "websocket",
		websocketConnectTimeoutMs: 2000,
		httpIdleTimeoutMs: 5000,
		retry: { enabled: false },
	}));
	await writeFile(join(agentDir, "rail-openai-responses-ws", "settings.json"), JSON.stringify({
		version: 1,
		routes: [{ provider: nativeModel.provider, endpoint: server.endpoint, models: [nativeModel.id] }],
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

	const history: TeamSnapshot[] = [];
	const hub = new TeamHub({ startupTimeoutMs: 10_000 });
	// Observe every live state change; the durable journal records milestones only.
	hub.subscribe((snapshot) => { history.push(snapshot); });
	const stateDir = join(agentDir, "stateful-subagents");
	const store = new FileAgentInstanceStore(stateDir);
	const leases = new FileSessionLeaseManager(stateDir);
	const broker = new SessionBroker({
		store,
		roster: new SessionAgentRoster(),
		defaultCwd: sandbox,
		aliasLeaseManager: leases,
		workerFactory: createRpcWorkerFactory({
			stateDir,
			startupTimeoutMs: 15_000,
			resolveInvocation: (args) => ({ command: process.execPath, args: [cli, "--no-extensions", "--offline", ...args, "-e", providerFixture] }),
		}),
	});
	t.after(async () => {
		hub.dispose();
		await broker.shutdown();
		for (const key of environmentKeys) {
			const value = previousEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(sandbox, { recursive: true, force: true });
	});

	const tools = new Map<string, any>();
	const pi: any = { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => undefined };
	const ctx: any = {
		cwd: sandbox,
		hasUI: false,
		model: nativeModel,
		scopedModels: [],
		modelRegistry: {
			find: (provider: string, id: string) => provider === nativeModel.provider && id === nativeModel.id ? nativeModel : undefined,
			getAvailable: () => [nativeModel],
		},
	};
	const manager = new TeamRunManager(hub);
	installTeamTool(pi, () => hub);
	installStatefulSubagentTool(pi, { broker, team: () => manager, renderContext: () => ctx });
	const prepared = await tools.get("subagent_team").execute("prepare", {
		action: "prepare",
		coordinator: "A",
		workers: ["B1", "B2"],
		timeoutSeconds: 45,
	}, undefined, undefined, ctx);
	const teamId = prepared.details.snapshots[0].id;
	const updates: any[] = [];
	const subagent = tools.get("subagent");
	const dispatch = () => [
		subagent.execute("ws-call-A", { teamId, alias: "A", model: "rail-team-ws/probe", task: `WS_${scenario.toUpperCase()} TEAM_MEMBER_A coordinate the workers` }, undefined, (value: any) => updates.push(value), ctx),
		subagent.execute("ws-call-workers", { teamId, tasks: [
			{ alias: "B1", model: "rail-team-ws/probe", task: `WS_${scenario.toUpperCase()} TEAM_MEMBER_B1 complete the assigned work` },
			{ alias: "B2", model: "rail-team-ws/probe", task: `WS_${scenario.toUpperCase()} TEAM_MEMBER_B2 complete the assigned work` },
		] }, undefined, (value: any) => updates.push(value), ctx),
	] as [Promise<any>, Promise<any>];
	const journal = async (alias: string) => {
		const instance = (await store.list()).find((item) => item.alias === alias);
		assert.ok(instance, `missing native session for ${alias}`);
		const content = await readFile(instance.sessionFile, "utf8");
		return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	};
	return { hub, teamId, history, tools, ctx, dispatch, journal, store, leases, broker, agentDir };
}

test("real Team RPC children use the configured loopback Responses WebSocket for native context, event-driven pause/wait/resume, and finalization", { timeout: 90_000 }, async (t) => {
	const server = await startLoopbackResponsesServer("normal");
	t.after(async () => { await server.close(); });
	const harness = await setup(t, server, "normal");
	const settled = Promise.all(harness.dispatch());

	try {
		await waitForServer(server, () => server.firstB2Request !== undefined, "B2 never reached the loopback WebSocket");
	} catch (error) {
		const dispatchStatus = await Promise.race([
			settled.then(() => "settled", (dispatchError) => `rejected: ${dispatchError instanceof Error ? dispatchError.message : String(dispatchError)}`),
			waitForDelay(100).then(() => "still pending"),
		]);
		throw new Error(`${error instanceof Error ? error.message : String(error)}; dispatch=${dispatchStatus}; handshakes=${server.handshakes.length}; errors=${server.errors.join(" | ")}; requests=${server.requests.length}; members=${server.requests.map((request) => memberFromPayload(request)).join(",")}; markers=${server.requests.map((request) => payloadText(request).match(/WS_[A-Z]+|TEAM_MEMBER_[A-Za-z0-9]+/gu)?.join(",") ?? "none").join(" || ")}; payloads=${server.requests.map((request) => payloadText(request).slice(0, 240)).join(" || ")}`);
	}
	await waitForSnapshot(harness.hub, harness.teamId, (snapshot) => {
		const coordinator = snapshot.members.find((member) => member.id === "A");
		const paused = snapshot.members.find((member) => member.id === "B1");
		return coordinator?.state === "waiting" && coordinator.waitingFor === "B2" && paused?.state === "paused";
	}, "Team did not reach the coordinator-waiting / worker-paused safe point");
	assert.equal(memberFromPayload(server.firstB2Request!), "B2", "the held response must belong to B2's first recorded request");
	assert.ok(server.requests.some((request) => memberFromPayload(request) === "A"
		&& hasCompletedCall(completedTeamCalls(request), (arguments_) => arguments_.action === "control" && arguments_.to === "B1" && arguments_.command === "redirect")),
	"B1's redirect must be in the coordinator's native context before B2 is released");
	const parkedRequestCount = server.requests.length;
	await waitForDelay(100);
	assert.equal(server.requests.length, parkedRequestCount, "waiting/paused members must not poll the WebSocket provider");
	server.releaseFirstB2Response();

	const [coordinator, workers] = await settled;
	assert.equal(harness.hub.get(harness.teamId).phase, "completed");
	assert.equal(coordinator.details.results[0].status, "completed");
	assert.match(coordinator.details.results[0].output, /WS_FINAL: B1_NATIVE_RESULT and B2_NATIVE_RESULT/u);
	assert.equal(workers.details.results.length, 2);
	assert.deepEqual(workers.details.results.map((result: any) => result.output).sort(), ["B1_NATIVE_RESULT", "B2_NATIVE_RESULT"]);
	assert.ok(harness.history.some((snapshot) => snapshot.members.some((member) => member.id === "B1" && member.state === "paused")));
	const events = [...new Map(harness.history.flatMap((snapshot) => snapshot.events.map((event) => [event.seq, event] as const))).values()];
	assert.deepEqual(events.filter((event) => event.kind === "control" && event.to === "B1").map((event) => event.message), ["pause", "redirect", "resume"]);

	const routeSettings = readRailResponsesWebSocketSettings(harness.agentDir);
	assert.deepEqual(routeSettings.routes, [{ provider: nativeModel.provider, endpoint: server.endpoint, models: [nativeModel.id] }]);
	assert.equal(server.errors.length, 0, server.errors.join("; "));
	assert.ok(server.handshakes.length >= 1);
	assert.ok(server.handshakes.every((handshake) => handshake.url === "/v1/responses" && handshake.authorization === "Bearer team-websocket-test-key"));
	assert.ok(server.requests.length >= 8);
	assert.ok(server.requests.every((request) => request["type"] === "response.create"));
	assert.ok(server.requests.every((request) => request["previous_response_id"] === undefined), "transport=websocket must send full native context, not a hidden server continuation");
	assert.ok(server.requests.some((request) => Array.isArray(request.input) && request.input.some((item) => isRecord(item) && item["type"] === "function_call_output")));
	const b1Requests = server.requests.filter((request) => memberFromPayload(request) === "B1");
	assert.ok(b1Requests.length >= 1 && b1Requests.length <= 2, `B1 must have only its initial/resumed native turns, got ${b1Requests.length}`);
	assert.equal(b1Requests.filter((request) => payloadText(request).includes("B1_RESUMED")).length, 1, "resume must wake B1 once from the native Team delivery, not by polling");
	assert.ok(server.requests.some((request) => payloadText(request).includes("B1_RESUMED")), "the resumed worker must receive the native Team direction in its request payload");
	const summaryRequests = server.requests.filter((request) => memberFromPayload(request) === "A"
		&& hasCompletedCall(completedTeamCalls(request), (args) => args.action === "wait" && args.wait?.kind === "workers"));
	assert.equal(summaryRequests.length, 1, "the complete worker barrier must cause exactly one native summary request");
	assert.ok(payloadText(summaryRequests[0]!).includes("B1_NATIVE_RESULT") && payloadText(summaryRequests[0]!).includes("B2_NATIVE_RESULT"), "the summary payload must contain both native worker results");
	assert.ok(server.requests.every((request) => !payloadText(request).includes("All workers have settled.")), "an explicitly observed barrier must not trigger a redundant host continuation");

	const coordinatorJournal = await harness.journal("A");
	const finalEntries = coordinatorJournal.filter((entry) => entry.message?.role === "assistant" && entry.message.stopReason === "stop");
	assert.equal(finalEntries.length, 1, "the coordinator must generate its final answer only once");
	assert.ok((await harness.journal("B1")).some((entry) => JSON.stringify(entry).includes("B1_RESUMED")));
	await waitForServer(server, () => server.openSockets.size === 0, "normal Team shutdown left a WebSocket open", 10_000);
});

test("real Team RPC cancellation wakes parked WebSocket children without another provider request and frees sessions", { timeout: 60_000 }, async (t) => {
	const server = await startLoopbackResponsesServer("cancel");
	t.after(async () => { await server.close(); });
	const harness = await setup(t, server, "cancel");
	const settled = Promise.allSettled(harness.dispatch());
	await waitForSnapshot(harness.hub, harness.teamId, (snapshot) => snapshot.phase === "running" && snapshot.members.every((member) => member.state === "waiting"), "cancel scenario did not park all Team members");
	const parkedRequestCount = server.requests.length;
	await waitForDelay(100);
	assert.equal(server.requests.length, parkedRequestCount, "parked cancellation members must not poll the WebSocket provider");
	await harness.tools.get("subagent_team").execute("cancel", { action: "cancel", teamId: harness.teamId, reason: "WebSocket Team cancellation" }, undefined, undefined, harness.ctx);
	const results = await settled;
	assert.equal(harness.hub.get(harness.teamId).phase, "cancelled");
	assert.ok(results.some((result) => result.status === "rejected") || results.some((result) => result.status === "fulfilled" && result.value.details.results.some((run: any) => run.status !== "completed")));
	assert.equal(server.requests.length, parkedRequestCount, "cancellation must not create a provider polling turn");
	assert.equal(server.errors.length, 0, server.errors.join("; "));
	await waitForServer(server, () => server.openSockets.size === 0, "cancelled Team left a WebSocket open", 10_000);
	for (const instance of await harness.store.list()) assert.deepEqual(await harness.leases.inspect(instance.sessionFile), { state: "free" });
	assert.doesNotMatch(JSON.stringify(results), /WS_FINAL/u);
});
