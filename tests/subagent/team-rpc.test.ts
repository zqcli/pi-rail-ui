import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { TeamRpcConnection } from "../../tools/subagents/team-rpc";
import { TeamHub } from "../../tools/subagents/team-hub";
import { TEAM_COMMAND_DESCRIPTION, TEAM_DELIVERY_TYPE } from "../../tools/subagents/team-extension";
import { TEAM_COMMAND, TEAM_ENTRY_TYPE, teamExtensionPath, type TeamBinding, type TeamReply, type TeamRequest } from "../../tools/subagents/team-protocol";
import type { RpcEvent, RpcTransport } from "../../tools/subagents/rpc-worker";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";

const binding: TeamBinding = { version: 1, teamId: "t", memberId: "b", role: "worker", epoch: "private-epoch" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class Transport implements RpcTransport {
	listeners = new Set<(event: RpcEvent) => void>();
	commands = [{ name: TEAM_COMMAND, source: "extension", description: TEAM_COMMAND_DESCRIPTION }];
	calls: Record<string, unknown>[] = [];
	ack = true;
	stopped = false;
	onEvent(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	emit(data: unknown) { for (const fn of this.listeners) fn({ type: "entry_appended", entry: { type: "custom", customType: TEAM_ENTRY_TYPE, data } }); }
	async request(command: Record<string, unknown>): Promise<unknown> {
		this.calls.push(command);
		if (command["type"] === "get_commands") return { commands: this.commands };
		if (command["type"] === "prompt" && this.ack) {
			const frame = JSON.parse(String(command["message"]).slice(TEAM_COMMAND.length + 2));
			this.emit({ version: 1, kind: "ack", binding, commandId: frame.commandId, ok: true });
		}
		return undefined;
	}
	async stop() { this.stopped = true; }
}

test("adapter subscribes before bind ACK and closes idempotently", async () => {
	const t = new Transport();
	const c = new TeamRpcConnection(t, { binding, onRequest: async () => ({ ok: true }) });
	await c.bind();
	assert.equal(t.listeners.size, 1);
	const close = c.close();
	assert.equal(c.close(), close);
	await close;
	assert.equal(t.listeners.size, 0);
	assert.equal(t.stopped, false);
});

test("missing, ambiguous and incompatible commands fail before any prompt fallback", async () => {
	for (const commands of [[], [{ name: `${TEAM_COMMAND}:1`, source: "extension", description: TEAM_COMMAND_DESCRIPTION }], [{ name: TEAM_COMMAND, source: "prompt", description: TEAM_COMMAND_DESCRIPTION }], [{ name: TEAM_COMMAND, source: "extension", description: "v2" }]]) {
		const t = new Transport(); t.commands = commands;
		const c = new TeamRpcConnection(t, { binding, onRequest: async () => ({ ok: true }) });
		await assert.rejects(c.bind(), /Missing/);
		assert.equal(t.calls.some((call) => call["type"] === "prompt"), false);
		assert.equal(t.listeners.size, 0);
		assert.equal(t.stopped, true);
	}
});

test("RPC success is not application ACK; abort releases pending bind", async () => {
	const t = new Transport(); t.ack = false;
	const controller = new AbortController();
	const c = new TeamRpcConnection(t, { binding, onRequest: async () => ({ ok: true }) }, controller.signal);
	let done = false;
	const bindingResult = c.bind().finally(() => { done = true; });
	const rejection = assert.rejects(bindingResult, /aborted/);
	await tick(); assert.equal(done, false);
	controller.abort(); await rejection;
	assert.equal(t.listeners.size, 0);
	assert.equal(t.stopped, true);
});

test("missing application ACK has a finite deadline even after RPC success", { timeout: 8000 }, async () => {
	const transport = new Transport(); transport.ack = false;
	const connection = new TeamRpcConnection(transport, { binding, onRequest: async () => ({ ok: true }) });
	await assert.rejects(connection.bind(), /ACK timed out/);
	assert.equal(transport.listeners.size, 0);
	assert.equal(transport.stopped, true);
});

test("commands are rediscovered before replies; disappearance never becomes a normal prompt", async () => {
	const transport = new Transport();
	const connection = new TeamRpcConnection(transport, { binding, onRequest: async () => ({ ok: true }) });
	await connection.bind();
	transport.commands = [];
	transport.emit({ version: 1, kind: "request", binding, request: { action: "checkpoint", sequence: 1, requestId: "r" } });
	await tick();
	assert.equal(transport.calls.filter((call) => call["type"] === "prompt").length, 1);
	assert.equal(transport.stopped, true);
	await assert.rejects(connection.close(), /Missing/);
});

test("requests do not serialize waits; callback exception and transport loss fail closed with aborted callback signal", async () => {
	for (const mode of ["exception", "transport"] as const) {
		const t = new Transport();
		let signal: AbortSignal | undefined;
		const c = new TeamRpcConnection(t, { binding, onRequest: async (_request, s) => {
			signal = s;
			if (mode === "exception") throw new Error("callback failed");
			return await new Promise<TeamReply>((resolve) => s?.addEventListener("abort", () => resolve({ ok: false }), { once: true }));
		} });
		await c.bind();
		t.emit({ version: 1, kind: "request", binding, request: { action: "checkpoint", sequence: 1, requestId: "r" } });
		await tick();
		if (mode === "transport") for (const fn of [...t.listeners]) fn({ type: "transport_error" });
		await tick();
		assert.equal(signal?.aborted, true);
		assert.equal(t.stopped, true);
		await assert.rejects(c.close());
	}
});

test("strict sender binding and monotonic sequence reject stale/forged wire requests", async () => {
	const t = new Transport(); let calls = 0;
	const c = new TeamRpcConnection(t, { binding, onRequest: async () => { calls++; return { ok: true }; } });
	await c.bind();
	t.emit({ version: 1, kind: "request", binding: { ...binding, epoch: "old" }, request: { action: "checkpoint", sequence: 1, requestId: "r" } });
	await tick();
	assert.equal(calls, 0); assert.equal(t.stopped, true);
});

test("RPC forwards internal receive flags only on checkpoints and rejects a public-action receive field", async () => {
	const transport = new Transport();
	const requests: TeamRequest[] = [];
	const connection = new TeamRpcConnection(transport, { binding, onRequest: async (request) => { requests.push(request); return { ok: true }; } });
	await connection.bind();
	for (const receive of [true, false]) {
		const sequence = requests.length + 1;
		transport.emit({ version: 1, kind: "request", binding, request: { action: "checkpoint", receive, sequence, requestId: `r${sequence}` } });
		await tick();
	}
	assert.deepEqual(requests.map((request) => request.receive), [true, false]);
	transport.emit({ version: 1, kind: "request", binding, request: { action: "wait", wait: { kind: "message" }, receive: true, sequence: 3, requestId: "r3" } });
	await tick();
	assert.equal(requests.length, 2);
	await assert.rejects(connection.close(), /Invalid team request/);
});

test("monotonic requests have no lifetime ID-cache ceiling and replay still fails closed", async () => {
	const transport = new Transport();
	let requests = 0;
	const connection = new TeamRpcConnection(transport, { binding, onRequest: async () => { requests++; return { ok: true }; } });
	await connection.bind();
	for (let sequence = 1; sequence <= 16385; sequence++) {
		transport.emit({ version: 1, kind: "request", binding, request: { action: "checkpoint", sequence, requestId: `r${sequence}` } });
		await tick();
	}
	assert.equal(requests, 16385);
	assert.equal(transport.stopped, false);
	transport.emit({ version: 1, kind: "request", binding, request: { action: "checkpoint", sequence: 16385, requestId: "r16385" } });
	await tick();
	assert.equal(requests, 16385);
	await assert.rejects(connection.close(), /sequence/);
});

test("bind failure and close await asynchronous transport stop before host lease cleanup can proceed", async () => {
	for (const bindFailure of [true, false]) {
		const transport = new Transport();
		let finishStop!: () => void;
		let stopCalls = 0;
		transport.stop = async () => {
			stopCalls++;
			for (const listener of transport.listeners) listener({ type: "transport_error" });
			await new Promise<void>((resolve) => { finishStop = resolve; });
			transport.stopped = true;
		};
		if (bindFailure) transport.commands = [];
		const connection = new TeamRpcConnection(transport, { binding, onRequest: async () => { throw new Error("callback failed"); } });
		const bound = connection.bind();
		if (!bindFailure) {
			await bound;
			transport.emit({ version: 1, kind: "request", binding, request: { action: "checkpoint", sequence: 1, requestId: "r" } });
			await tick();
		}
		let returned = false;
		const result = assert.rejects(bindFailure ? bound : connection.close(), bindFailure ? /Missing/ : /callback failed/).then(() => { returned = true; });
		await tick();
		assert.equal(stopCalls, 1);
		assert.equal(returned, false);
		assert.equal(transport.stopped, false);
		finishStop();
		await result;
		assert.equal(transport.stopped, true);
		assert.equal(transport.listeners.size, 0);
		await assert.rejects(connection.close());
		assert.equal(stopCalls, 1);
	}
});

test("closing aborts callbacks and late resolution/rejection cannot send commands or stop a reused child", async () => {
	for (const rejects of [false, true]) {
		const transport = new Transport();
		let finish!: () => void;
		let callbackSignal: AbortSignal | undefined;
		const connection = new TeamRpcConnection(transport, { binding, onRequest: async (_request, signal) => {
			callbackSignal = signal;
			return await new Promise<TeamReply>((resolve, reject) => { finish = () => rejects ? reject(new Error("late error")) : resolve({ ok: true }); });
		} });
		await connection.bind();
		transport.emit({ version: 1, kind: "request", binding, request: { action: "checkpoint", sequence: 1, requestId: "r" } });
		await tick();
		await connection.close();
		assert.equal(callbackSignal?.aborted, true);
		const calls = transport.calls.length;
		finish();
		await tick();
		assert.equal(transport.calls.length, calls);
		assert.equal(transport.stopped, false);
		assert.equal(transport.listeners.size, 0);
	}
});

test("close while reply command discovery is pending never dispatches a late private prompt", async () => {
	const transport = new Transport();
	const original = transport.request.bind(transport);
	let queries = 0;
	let release!: () => void;
	transport.request = async (command) => {
		if (command["type"] === "get_commands" && ++queries === 2) {
			return await new Promise((resolve) => { release = () => resolve({ commands: transport.commands }); });
		}
		return original(command);
	};
	const connection = new TeamRpcConnection(transport, { binding, onRequest: async () => ({ ok: true }) });
	await connection.bind();
	transport.emit({ version: 1, kind: "request", binding, request: { action: "checkpoint", sequence: 1, requestId: "r" } });
	await tick();
	assert.equal(queries, 2);
	await connection.close();
	release();
	await tick();
	assert.equal(transport.calls.filter((command) => command["type"] === "prompt").length, 2, "only bind and unbind");
	assert.equal(transport.stopped, false);
});

async function local(t: { after(fn: () => Promise<void>): void }, scenario: string, url = "", probe = false) {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-team-probe-"));
	if (scenario === "delivery") await writeFile(join(sandbox, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url)), "--mode", "rpc", "--offline", "--no-extensions", "--session-dir", sandbox, "-e", teamExtensionPath(), "-e", fileURLToPath(new URL("../fixtures/team-local-provider.mjs", import.meta.url)), "--model", "rail-team-local/probe", ...(probe ? ["-e", fileURLToPath(new URL("../fixtures/team-delivery-probe.mjs", import.meta.url))] : [])],
		cwd: sandbox,
		env: { PATH: process.env["PATH"] ?? "", HOME: sandbox, PI_CODING_AGENT_DIR: sandbox, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TEAM_PROBE_SCENARIO: scenario, TEAM_PROBE_URL: url },
	});
	t.after(async () => { await transport.stop(); await rm(sandbox, { recursive: true, force: true }); });
	await transport.start();
	return transport;
}
function eventOnce(transport: RpcTransport, predicate: (event: RpcEvent) => boolean): Promise<RpcEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { off(); reject(new Error("Local team probe event timeout")); }, 8000);
		const off = transport.onEvent((event) => { if (predicate(event)) { clearTimeout(timer); off(); resolve(event); } });
	});
}

test("native sendMessage context probe persists only after tool results, without extra turns, including abort", { timeout: 20000 }, async (t) => {
	for (const abort of [false, true]) {
		const transport = await local(t, abort ? "probe-abort" : "work", "", true);
		const providers: any[] = [];
		transport.onEvent((event) => {
			if (event.type === "entry_appended" && (event["entry"] as any)?.customType === "team-probe-provider") providers.push((event["entry"] as any).data);
		});
		const waiting = eventOnce(transport, (event) => event.type === "entry_appended" && (event["entry"] as any)?.customType === "team-probe-work");
		const settled = eventOnce(transport, (event) => event.type === "agent_settled");
		await transport.request({ type: "prompt", message: "native persistence probe" });
		if (abort) {
			await waiting;
			assert.match(JSON.stringify(providers[0].messages), /native-delivery-probe-fact/);
			assert.doesNotMatch(JSON.stringify(await transport.request({ type: "get_messages" })), /native-delivery-probe-fact/, "not yet flushed during parked tool");
			await transport.request({ type: "abort" });
		}
		await settled;
		assert.equal(providers.length, abort ? 1 : 2, "context-only delivery never schedules a provider turn");
		assert.equal(JSON.stringify(providers[0].messages).split("native-delivery-probe-fact").length - 1, 1);
		if (!abort) assert.doesNotMatch(JSON.stringify(providers[1].messages), /native-delivery-probe-fact/, "Pi 0.85.1 continuation has a separate context array: native branch repair is required");
		const state = await transport.request({ type: "get_state" }) as { sessionFile: string };
		const entries = (await readFile(state.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const delivered = entries.findIndex((entry) => entry.type === "custom_message" && entry.customType === "team-delivery-api-probe");
		const result = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult");
		assert.ok(result >= 0 && delivered > result, "native writer puts delivery after the tool result, also on abort");
		assert.equal(entries.filter((entry) => entry.customType === "team-delivery-api-probe").length, 1);
		assert.match(JSON.stringify(await transport.request({ type: "get_messages" })), /native-delivery-probe-fact/);
	}
});

test("real Team delivery is visible before a parked tool and native abort flushes it after the result", { timeout: 15000 }, async (t) => {
	const transport = await local(t, "probe-abort");
	const providers: any[] = [];
	transport.onEvent((event) => {
		if (event.type === "entry_appended" && (event["entry"] as any)?.customType === "team-probe-provider") providers.push((event["entry"] as any).data);
	});
	let received = false;
	const connection = new TeamRpcConnection(transport, { binding, onRequest: async (request) => {
		if (!received && request.receive) {
			received = true;
			return { ok: true, events: [{ seq: 1, kind: "message", message: "READY-before-abort" }] };
		}
		return { ok: true };
	} });
	t.after(async () => { await connection.close().catch(() => undefined); });
	await connection.bind();
	const parked = eventOnce(transport, (event) => event.type === "entry_appended" && (event["entry"] as any)?.customType === "team-probe-work");
	const settled = eventOnce(transport, (event) => event.type === "agent_settled" || event.type === "transport_error");
	await transport.request({ type: "prompt", message: "park after receiving checkpoint" });
	await parked;
	assert.match(JSON.stringify(providers[0].messages), /READY-before-abort/);
	assert.doesNotMatch(JSON.stringify(await transport.request({ type: "get_messages" })), /READY-before-abort/);
	const state = await transport.request({ type: "get_state" }) as { sessionFile: string };
	// Team's abort gate may retire the child before the abort RPC response; inspect
	// only this probe's synthetic session to verify native flush before retirement.
	await transport.request({ type: "abort" }).catch((error) => assert.match(String(error), /process stopped/));
	await settled;
	assert.equal(providers.length, 1);
	const entries = (await readFile(state.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const result = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult");
	const delivery = entries.findIndex((entry) => entry.type === "custom_message" && entry.customType === TEAM_DELIVERY_TYPE);
	assert.ok(result >= 0 && delivery > result);
	assert.equal(entries.filter((entry) => entry.type === "custom_message" && entry.customType === TEAM_DELIVERY_TYPE).length, 1);
	assert.match(entries[delivery].content, /READY-before-abort/);
	await connection.close().catch((error) => assert.match(String(error), /Team extension failed/));
});

test("real Pi keeps checkpoint deliveries across unrelated tools and native compaction without polling or double writes", { timeout: 20000 }, async (t) => {
	const transport = await local(t, "delivery");
	const providers: any[] = [];
	transport.onEvent((event) => {
		if (event.type === "entry_appended" && (event["entry"] as any)?.customType === "team-probe-provider") providers.push((event["entry"] as any).data);
	});
	const hub = new TeamHub();
	t.after(() => hub.dispose());
	const team = hub.prepare({ coordinator: "a", workers: ["b"] });
	const coordinator = hub.join(team.id, ["a"])[0]!;
	const worker = hub.join(team.id, ["b"])[0]!;
	await hub.request(coordinator, { action: "send", to: "b", message: "READY-fact", sequence: 1, requestId: "fact" });
	const connection = new TeamRpcConnection(transport, { binding: worker, onRequest: (request, signal) => hub.request(worker, request, signal) });
	t.after(async () => { await connection.close().catch(() => undefined); });
	await connection.bind();
	const prompt = async (message: string) => {
		const settled = eventOnce(transport, (event) => event.type === "agent_settled");
		await transport.request({ type: "prompt", message });
		await settled;
	};
	await prompt("perform unrelated work twice");
	assert.equal(providers.length, 3, "only two tool continuations, no delivery-triggered extra turns");
	for (const provider of providers) {
		assert.match(JSON.stringify(provider.messages), /READY-fact/);
		assert.match(JSON.stringify(provider.messages), /coordinator/);
		assert.doesNotMatch(JSON.stringify(provider.messages), new RegExp(worker.epoch));
	}
	const state = await transport.request({ type: "get_state" }) as { sessionFile: string };
	const entries = (await readFile(state.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const deliveries = entries.filter((entry) => entry.type === "custom_message" && entry.customType === TEAM_DELIVERY_TYPE);
	assert.equal(deliveries.length, 1, "continuation recovery does not write again");
	assert.deepEqual(Object.keys(deliveries[0].details).sort(), ["deliveryId", "memberId", "teamId"]);
	const deliveryIndex = entries.indexOf(deliveries[0]);
	const resultIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult");
	assert.ok(deliveryIndex > resultIndex, "delivery cannot split a toolCall/result pair");
	await transport.request({ type: "compact" });
	assert.doesNotMatch(JSON.stringify(await transport.request({ type: "get_messages" })), /READY-fact/, "real compaction removes the original delivery from native context");
	await prompt("continue unrelated work after compaction");
	assert.equal(providers.length, 4);
	assert.match(JSON.stringify(providers[3].messages), /READY-fact/);
	assert.match(JSON.stringify(providers[3].messages), /coordinator/);
	const after = (await readFile(state.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(after.filter((entry) => entry.type === "custom_message" && entry.customType === TEAM_DELIVERY_TYPE).length, 1);
	await connection.close();
	await transport.request({ type: "compact" });
	await prompt("ordinary non-team dispatch");
	assert.equal(providers.length, 5);
	assert.doesNotMatch(JSON.stringify(providers[4].messages), /READY-fact/, "unbound contexts never recover team deliveries");
	const rebound = new TeamRpcConnection(transport, { binding: worker, onRequest: async () => ({ ok: true }) });
	t.after(async () => { await rebound.close().catch(() => undefined); });
	await rebound.bind();
	await prompt("same binding, another send after native compaction");
	assert.equal(providers.length, 6);
	assert.match(JSON.stringify(providers[5].messages), /READY-fact/, "same runtime binding keeps its original history boundary across sends");
	assert.match(JSON.stringify(providers[5].messages), /coordinator/);
	assert.doesNotMatch(JSON.stringify(providers[5].messages), new RegExp(worker.epoch));
	await rebound.close();
	const renewed = new TeamRpcConnection(transport, { binding: { ...worker, epoch: "new-probe-epoch" }, onRequest: async () => ({ ok: true }) });
	t.after(async () => { await renewed.close().catch(() => undefined); });
	await renewed.bind();
	await prompt("same public identity, new epoch");
	assert.equal(providers.length, 7);
	assert.doesNotMatch(JSON.stringify(providers[6].messages), /READY-fact/, "new epoch never recovers the old lifetime");
	await renewed.close();
	const other = new TeamRpcConnection(transport, { binding: { ...binding, teamId: "other-team" }, onRequest: async () => ({ ok: true }) });
	t.after(async () => { await other.close().catch(() => undefined); });
	await other.bind();
	await prompt("different team dispatch");
	assert.equal(providers.length, 8);
	assert.doesNotMatch(JSON.stringify(providers[7].messages), /READY-fact/, "a new binding cannot recover the previous team's deliveries");
	await other.close();
});

test("real Pi new epoch filters old visible native deliveries without compaction or deleting history", { timeout: 15000 }, async (t) => {
	const transport = await local(t, "work");
	const providers: any[] = [];
	transport.onEvent((event) => {
		if (event.type === "entry_appended" && (event["entry"] as any)?.customType === "team-probe-provider") providers.push((event["entry"] as any).data);
	});
	let received = false;
	const first = new TeamRpcConnection(transport, { binding, onRequest: async (request) => {
		if (request.receive && !received) {
			received = true;
			return { ok: true, events: [{ seq: 1, kind: "message", message: "OLD-EPOCH-FACT" }] };
		}
		return { ok: true };
	} });
	t.after(async () => { await first.close().catch(() => undefined); });
	const prompt = async () => {
		const settled = eventOnce(transport, (event) => event.type === "agent_settled");
		await transport.request({ type: "prompt", message: "unrelated work" });
		await settled;
	};
	await first.bind();
	await prompt();
	assert.equal(providers.length, 2);
	assert.match(JSON.stringify(providers[1].messages), /OLD-EPOCH-FACT/);
	await first.close();
	assert.match(JSON.stringify(await transport.request({ type: "get_messages" })), /OLD-EPOCH-FACT/, "old delivery remains visible in native history without compaction");
	const next = new TeamRpcConnection(transport, { binding: { ...binding, epoch: "renewed-private-epoch" }, onRequest: async () => ({ ok: true }) });
	t.after(async () => { await next.close().catch(() => undefined); });
	await next.bind();
	await prompt();
	assert.equal(providers.length, 3);
	assert.doesNotMatch(JSON.stringify(providers[2].messages), /OLD-EPOCH-FACT|private-epoch/);
	assert.match(JSON.stringify(await transport.request({ type: "get_messages" })), /OLD-EPOCH-FACT/, "context projection must not delete native history");
	await next.close();
});

test("real Pi private command replies while a team tool waits, with no idle wait or extra provider polls", { timeout: 15000 }, async (t) => {
	const transport = await local(t, "wait");
	let release!: (reply: TeamReply) => void;
	let notified!: () => void;
	const waiting = new Promise<void>((resolve) => { notified = resolve; });
	const requests: TeamRequest[] = [];
	const c = new TeamRpcConnection(transport, { binding, onRequest: async (request) => {
		requests.push(request);
		if (request.action === "wait") { notified(); return await new Promise((resolve) => { release = resolve; }); }
		return { ok: true };
	} });
	await c.bind();
	const settled = eventOnce(transport, (event) => event.type === "agent_settled");
	await transport.request({ type: "prompt", message: "local team test" });
	await waiting;
	const before = requests.length;
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(requests.length, before);
	release({ ok: true, events: [{ seq: 1, kind: "message", from: "a", message: "resume-now" }] });
	await settled;
	const messages = await transport.request({ type: "get_messages" });
	assert.match(JSON.stringify(messages), /resume-now/);
	assert.match(JSON.stringify(messages), /local-provider-done/);
	assert.doesNotMatch(JSON.stringify(messages), /private-epoch/);
	const state = await transport.request({ type: "get_state" }) as { sessionFile: string };
	const entries = (await readFile(state.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === TEAM_ENTRY_TYPE && entry.data.kind === "request"));
	assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === TEAM_ENTRY_TYPE && entry.data.kind === "ack"));
	await c.close();
});

test("real Pi + Hub preserve a message queued before tool preflight for the already-generated wait/report-wait", { timeout: 20000 }, async (t) => {
	for (const scenario of ["queued-wait", "queued-report-wait"]) {
		const hub = new TeamHub();
		t.after(() => hub.dispose());
		const team = hub.prepare({ coordinator: "a", workers: ["b"] });
		const coordinator = hub.join(team.id, ["a"])[0]!;
		const worker = hub.join(team.id, ["b"])[0]!;
		const transport = await local(t, scenario);
		const traces: Array<{ request: TeamRequest; reply: TeamReply }> = [];
		const providers: any[] = [];
		transport.onEvent((event) => {
			if (event.type === "entry_appended" && (event["entry"] as any)?.customType === "team-probe-provider") providers.push((event["entry"] as any).data);
		});
		let queued = false;
		const connection = new TeamRpcConnection(transport, { binding: worker, onRequest: async (request, signal) => {
			if (request.action === "checkpoint" && traces.length === 1) {
				// Pi has already generated the waiting tool call. Queue a real Hub
				// message before allowing its native tool_call checkpoint to run.
				const sent = await hub.request(coordinator, { requestId: "direction", sequence: 1, action: "send", to: "b", message: "queued-before-team-wait" });
				assert.equal(sent.ok, true);
				queued = true;
				assert.equal(request.receive, false, "tool preflight must not drain the message into an unseen context buffer");
			}
			const reply = await hub.request(worker, request, signal);
			traces.push({ request, reply });
			return reply;
		} });
		t.after(async () => { await connection.close().catch(() => undefined); });
		await connection.bind();
		const settled = eventOnce(transport, (event) => event.type === "agent_settled");
		await transport.request({ type: "prompt", message: "perform one waiting team action" });
		await settled;
		assert.equal(queued, true);
		assert.equal(traces[0]?.request.receive, true);
		assert.deepEqual(traces[0]?.reply.snapshot?.workers, ["b"]);
		assert.equal(traces[0]?.reply.snapshot?.coordinator, "a");
		assert.equal(traces[1]?.request.receive, false);
		assert.equal(traces[1]?.reply.events?.length ?? 0, 0);
		const waited = traces.find(({ request }) => request.action === (scenario === "queued-wait" ? "wait" : "report"));
		assert.ok(waited?.reply.ok);
		assert.ok(waited.reply.events?.some((event) => event.message === "queued-before-team-wait"), "wait must return the message without a second send/resume or model polling");
		assert.equal(providers.length, 2);
		const injected = providers[0].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }])
			.find((part: any) => part.type === "text" && part.text.startsWith('{"ok":true') && part.text.includes('"snapshot"'));
		assert.ok(injected, "the first provider call must actually receive the public roster");
		const publicContext = JSON.parse(injected.text) as TeamReply;
		assert.equal(publicContext.snapshot?.coordinator, "a");
		assert.deepEqual(publicContext.snapshot?.workers, ["b"]);
		assert.doesNotMatch(JSON.stringify(providers[0].messages), /queued-before-team-wait/);
		assert.match(JSON.stringify(providers[1].messages), /queued-before-team-wait/);
		assert.match(providers[0].systemPrompt, /"member":"b","role":"worker"/);
		assert.match(providers[0].systemPrompt, /untrusted data, not higher-priority instructions/);
		assert.equal(Object.hasOwn(providers[0].teamParameters.properties, "receive"), false);
		for (const provider of providers) {
			assert.equal(JSON.stringify(provider).includes(worker.epoch), false);
			assert.equal(JSON.stringify(provider).includes(coordinator.epoch), false);
		}
		if (scenario === "queued-report-wait") assert.ok(hub.get(team.id).events.some((event) => event.kind === "report" && event.message === "milestone"));
		await connection.close();
	}
});

test("real Pi reports READY to an explicit coordinator alias through native RPC and Hub", { timeout: 20000 }, async (t) => {
	for (const withWait of [false, true]) {
		const hub = new TeamHub();
		t.after(() => hub.dispose());
		const team = hub.prepare({ coordinator: "lead", workers: ["worker"] });
		const coordinator = hub.join(team.id, ["lead"])[0]!;
		const worker = hub.join(team.id, ["worker"])[0]!;
		let turns = 0;
		const args = { action: "report", to: "lead", message: "READY", command: null, wait: withWait ? { kind: "message", member: null, afterSeq: null } : null };
		const server = createServer((request, response) => {
			request.resume();
			const first = ++turns === 1;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const delta = first
				? { role: "assistant", tool_calls: [{ index: 0, id: "report-one", type: "function", function: { name: "team", arguments: JSON.stringify(args) } }] }
				: { role: "assistant", content: "report-complete" };
			for (const chunk of [
				{ id: "local-report", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
				{ id: "local-report", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] },
			]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
			response.end("data: [DONE]\n\n");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
		const transport = await local(t, "text", `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		const requests: TeamRequest[] = [];
		let coordinatorSequence = 0;
		const connection = new TeamRpcConnection(transport, { binding: worker, onRequest: async (request, signal) => {
			requests.push(request);
			if (request.action === "report" && withWait) {
				const sent = await hub.request(coordinator, { requestId: "wake-worker", sequence: ++coordinatorSequence, action: "send", to: "worker", message: "CONTINUE" });
				assert.equal(sent.ok, true);
			}
			return hub.request(worker, request, signal);
		} });
		t.after(async () => { await connection.close().catch(() => undefined); });
		await connection.bind();
		const settled = eventOnce(transport, (event) => event.type === "agent_settled");
		await transport.request({ type: "prompt", message: "Report READY to the coordinator" });
		await settled;
		const reports = requests.filter((request) => request.action !== "checkpoint");
		assert.equal(reports.length, 1, "READY must succeed on the first call, without report retries or an empty wait fallback");
		assert.equal(reports[0]!.action, "report");
		assert.equal(reports[0]!.to, "lead");
		assert.equal(reports[0]!.message, "READY");
		assert.deepEqual(reports[0]!.wait, withWait ? { kind: "message" } : undefined);
		const inbox = await hub.request(coordinator, { requestId: "receive-ready", sequence: ++coordinatorSequence, action: "wait", wait: { kind: "message" } });
		assert.ok(inbox.events?.some((event) => event.kind === "report" && event.from === "worker" && event.to === "lead" && event.message === "READY"));
		const result = await transport.request({ type: "get_messages" }) as { messages: Array<{ role: string; toolName?: string; isError?: boolean }> };
		assert.equal(result.messages.find((message) => message.role === "toolResult" && message.toolName === "team")?.isError, false);
		assert.match(JSON.stringify(result), /report-complete/);
		if (withWait) assert.match(JSON.stringify(result), /CONTINUE/);
		assert.equal(turns, 2);
		assert.equal(hub.signal(team.id).aborted, false);
		await connection.close();
	}
});

test("real Pi validates nullable/empty optional fields and marks business denials as non-aborting tool errors", { timeout: 20000 }, async (t) => {
	for (const scenario of ["wait-null", "wait-empty", "send-null", "send-empty", "send-denied"]) {
		const transport = await local(t, scenario);
		const requests: TeamRequest[] = [];
		const connection = new TeamRpcConnection(transport, { binding, onRequest: async (request) => {
			requests.push(request);
			return scenario === "send-denied" && request.action === "send" ? { ok: false, error: "recipient unavailable" } : { ok: true };
		} });
		await connection.bind();
		const settled = eventOnce(transport, (event) => event.type === "agent_settled");
		await transport.request({ type: "prompt", message: scenario });
		await settled;
		const toolRequests = requests.filter((request) => request.action !== "checkpoint");
		assert.equal(toolRequests.length, 1, `${scenario}: native schema must admit provider placeholders`);
		const { requestId: _id, sequence: _sequence, ...input } = toolRequests[0]!;
		assert.deepEqual(input, scenario.startsWith("wait") ? { action: "wait", wait: { kind: "message" } } : { action: "send", to: "a", message: "  hello  " });
		const result = await transport.request({ type: "get_messages" }) as { messages: Array<{ role: string; toolName?: string; isError?: boolean }> };
		const toolResult = result.messages.find((message) => message.role === "toolResult" && message.toolName === "team");
		assert.equal(toolResult?.isError, scenario === "send-denied");
		assert.match(JSON.stringify(result), /local-provider-done/, "business rejection does not abort the native continuation");
		await connection.close();
	}
});

test("real Pi runtime command conflicts invalidate bind-time discovery before any ordinary prompt fallback", { timeout: 15000 }, async (t) => {
	const transport = await local(t, "conflict");
	const connection = new TeamRpcConnection(transport, { binding, onRequest: async () => ({ ok: true }) });
	await connection.bind();
	const state = await transport.request({ type: "get_state" }) as { sessionFile: string };
	const stopped = eventOnce(transport, (event) => event.type === "transport_error");
	await transport.request({ type: "prompt", message: "create runtime conflict" });
	await stopped;
	await assert.rejects(connection.close(), /conflicting/);
	const entries = (await readFile(state.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
	assert.doesNotMatch(JSON.stringify(messages), /rail-subagent-team-protocol|private-epoch|local-provider-done/);
});

test("real Pi close/abort releases parked native context and tool gates; late callbacks cannot resurrect them", { timeout: 20000 }, async (t) => {
	for (const mode of ["close-context", "close-wait", "abort-wait"]) {
		const transport = await local(t, mode === "close-context" ? "text" : "wait");
		const controller = new AbortController();
		let entered!: () => void;
		let lateReply!: (reply: TeamReply) => void;
		let callbackSignal: AbortSignal | undefined;
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		const connection = new TeamRpcConnection(transport, { binding, onRequest: async (request, signal) => {
			if ((mode === "close-context" && request.action === "checkpoint") || request.action === "wait") {
				callbackSignal = signal;
				entered();
				return await new Promise((resolve) => { lateReply = resolve; });
			}
			return { ok: true };
		} }, controller.signal);
		await connection.bind();
		const entries = await transport.request({ type: "get_entries" }) as { entries: Array<{ customType?: string; data?: { pid?: number } }> };
		const pid = entries.entries.find((entry) => entry.customType === "team-probe-start")?.data?.pid;
		assert.ok(pid);
		await transport.request({ type: "prompt", message: mode });
		await waiting;
		if (mode === "abort-wait") controller.abort();
		await connection.close().catch(() => undefined);
		assert.equal(callbackSignal?.aborted, true);
		lateReply({ ok: true, events: [{ seq: 1, kind: "message", message: "too late" }] });
		await tick();
		// Fatal native hook errors retire the child; alternatively an orderly unbind
		// leaves it idle with no active gate. Neither path may continue the old task.
		try {
			const state = await transport.request({ type: "get_state" }) as { isStreaming: boolean };
			assert.equal(state.isStreaming, false);
			const messages = await transport.request({ type: "get_messages" });
			assert.doesNotMatch(JSON.stringify(messages), /too late|local-provider-done/);
		} catch (error) {
			if (!(error instanceof Error) || !/not running/.test(error.message)) throw error;
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "close must await transport stop, not just transport_error");
		}
	}
});

test("real Pi mixed wait/work batch rejects wait without releasing a permit or deadlocking siblings", { timeout: 15000 }, async (t) => {
	const transport = await local(t, "mixed");
	const requests: TeamRequest[] = [];
	const connection = new TeamRpcConnection(transport, { binding, onRequest: async (request) => { requests.push(request); return { ok: true }; } });
	await connection.bind();
	const settled = eventOnce(transport, (event) => event.type === "agent_settled");
	await transport.request({ type: "prompt", message: "mixed local batch" });
	await settled;
	assert.ok(requests.every((request) => request.action === "checkpoint"));
	const messages = JSON.stringify(await transport.request({ type: "get_messages" }));
	assert.match(messages, /sole tool/);
	assert.match(messages, /local-work-done/);
	assert.match(messages, /local-provider-done/);
	await connection.close();
});

test("real Pi tool_call checkpoint suspends work, not block:true, and accepts an immediate resume reply", { timeout: 15000 }, async (t) => {
	const transport = await local(t, "work");
	let release!: (reply: TeamReply) => void;
	let entered!: () => void;
	let checkpoints = 0;
	let executed = false;
	const waiting = new Promise<void>((resolve) => { entered = resolve; });
	transport.onEvent((event) => { if (event.type === "entry_appended" && (event["entry"] as any)?.customType === "team-probe-work") executed = true; });
	const connection = new TeamRpcConnection(transport, { binding, onRequest: async () => {
		if (++checkpoints === 2) { entered(); return await new Promise((resolve) => { release = resolve; }); }
		return { ok: true };
	} });
	await connection.bind();
	const settled = eventOnce(transport, (event) => event.type === "agent_settled");
	await transport.request({ type: "prompt", message: "local tool gate" });
	await waiting;
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(executed, false);
	release({ ok: true });
	await settled;
	assert.equal(executed, true);
	await connection.close();
});

test("real Pi context gate abort releases native ctx.signal and prevents provider work", { timeout: 15000 }, async (t) => {
	const transport = await local(t, "text");
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => { entered = resolve; });
	const c = new TeamRpcConnection(transport, { binding, onRequest: async () => { entered(); return await new Promise(() => {}); } });
	await c.bind();
	const events: RpcEvent[] = [];
	transport.onEvent((event) => events.push(event));
	const lost = eventOnce(transport, (event) => event.type === "transport_error");
	await transport.request({ type: "prompt", message: "local abort test" });
	await waiting;
	// Native abort wakes ctx.signal; the swallowed hook error retires this dispatch.
	// The adapter intentionally stops the process rather than allowing reuse.
	await transport.request({ type: "abort" }).catch(() => undefined);
	await lost;
	assert.ok(events.some((event) => event.type === "extension_error" && event["event"] === "context"));
	const providerEntries = events.filter((event) => event.type === "entry_appended" && (event["entry"] as any)?.customType === "team-probe-provider");
	assert.ok(providerEntries.every((event) => (event["entry"] as any).data.aborted === true));
	await assert.rejects(c.close(), /extension failed/);
});

test("real native HTTP provider gate pauses before network and fails closed when Pi swallows its handler exception", { timeout: 20000 }, async (t) => {
	let hits = 0;
	const bodies: string[] = [];
	const server = createServer(async (request, response) => {
		hits++;
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		bodies.push(Buffer.concat(chunks).toString("utf8"));
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const chunk of [
			{ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "loopback-done" }, finish_reason: null }] },
			{ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	for (const denied of [false, true]) {
		const transport = await local(t, "text", url);
		let checkpoints = 0;
		let release!: (reply: TeamReply) => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		const connection = new TeamRpcConnection(transport, { binding, onRequest: async (request) => {
			if (++checkpoints === 2) {
				assert.equal(request.receive, false, "native provider gate only acquires a permit");
				entered(); return await new Promise((resolve) => { release = resolve; });
			}
			if (checkpoints === 1) {
				assert.equal(request.receive, true, "native context gate is allowed to receive");
				return { ok: true, events: [{ seq: 1, kind: "control" as const, from: "a", to: "b", message: "hub-direction-continue", epoch: binding.epoch, binding }] };
			}
			return { ok: true };
		} });
		await connection.bind();
		const done = eventOnce(transport, (event) => event.type === (denied ? "transport_error" : "agent_settled"));
		await transport.request({ type: "prompt", message: "loopback native gate" });
		await waiting;
		const before = hits;
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(hits, before, "no HTTP call while provider checkpoint is paused");
		release(denied ? { ok: false, error: "permit denied" } : { ok: true });
		await done;
		if (denied) {
			assert.equal(hits, before, "aborted swallowed provider hook must not leak an HTTP request");
			await assert.rejects(connection.close());
		} else {
			assert.equal(hits, before + 1);
			assert.match(bodies.at(-1)!, /hub-direction-continue/, "context gate events reach the actual HTTP provider payload");
			assert.doesNotMatch(bodies.at(-1)!, /private-epoch|requestId|rail-subagent-team-protocol/);
			const again = eventOnce(transport, (event) => event.type === "agent_settled");
			await transport.request({ type: "prompt", message: "second turn without a direction" });
			await again;
			assert.equal(hits, before + 2);
			assert.equal(bodies.at(-1)!.split("hub-direction-continue").length - 1, 1, "native history retains the consumed fact exactly once");
			assert.doesNotMatch(bodies.at(-1)!, /private-epoch|requestId|rail-subagent-team-protocol/);
			await connection.close();
		}
	}
});
