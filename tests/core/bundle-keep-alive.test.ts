import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";

const bundle = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/bundle-keep-alive-probe.ts", import.meta.url));

test("real Pi tool wait: warm a busy parent, keep the deadline across sibling results and steering, then resume", { timeout: 30_000 }, async (t) => {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "ka-tools-"));
	const output = join(dir, "result.json");
	const log = join(dir, "provider.jsonl");
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundle, "--mode", "rpc", "--no-session", "--model", "rail-ka-local/local", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "-e", fixture],
		cwd: process.cwd(),
		env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", KA_WAIT_TEST: "1", KA_PROBE_OUTPUT: output, KA_PROBE_LOG: log },
	});
	t.after(async () => { await transport.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
	await transport.start();
	const command = (message: string) => transport.request({ type: "prompt", message });
	const status = async () => {
		await command("/ka-wait-status");
		return JSON.parse(await readFile(output, "utf8"));
	};
	const waitForPending = async (count: number) => {
		for (let i = 0; i < 100; i++) {
			const s = await status();
			if (s.pending.length === count) return s;
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		throw new Error(`pending tool count did not reach ${count}`);
	};
	await command("/rail-keep-alive 1");
	await command("hold two tools");
	const before = await waitForPending(2);
	assert.equal(before.idle, false);
	assert.equal(before.label, "KA 1|1", "the response arms a countdown before agent_settled");
	await transport.request({ type: "steer", message: "queued until the tools finish" });
	await command("/ka-release a");
	const partial = await waitForPending(1);
	assert.equal(partial.idle, false);
	assert.equal(partial.nextWarmAt, before.nextWarmAt, "partial tool completion and steering do not reset the interval");
	// Unit tests advance actual timers. This probe dispatches the scheduled native refresh now,
	// with real AgentSession/tool lifecycle state, without waiting a minute in the default suite.
	await command("/ka-probe");
	const warmed = await status();
	assert.equal(warmed.idle, false);
	assert.equal(warmed.usage, 1);
	assert.equal(warmed.label, "KA 1|1");
	const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.equal(requests.length, 2);
	assert.equal(requests[1].maxTokens, 1);
	assert.deepEqual(requests[1].payload, requests[0].payload, "warm the exact parent prefix, without partial results or queued text");
	const settled = new Promise<void>(resolve => {
		const off = transport.onEvent(e => { if (e.type === "agent_settled") { off(); resolve(); } });
	});
	await command("/ka-release b");
	await settled;
	const after = await status();
	assert.equal(after.idle, true);
	assert.equal(after.usage, 1);
	assert.equal(after.label, "KA 1|1");
	assert.doesNotMatch(after.status, /waiting for tools/);
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 3, "only one parent continuation after both tools return");
});

test("bundled CLI: capture the actual warmer through public AgentSession without a provider call", { timeout: 30_000 }, async (t) => {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "ka-bundle-"));
	const output = join(dir, "result.json");
	const log = join(dir, "provider.jsonl");
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundle, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "-e", fixture],
		cwd: process.cwd(),
		env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", KA_PROBE_OUTPUT: output, KA_PROBE_LOG: log },
	});
	t.after(async () => { await transport.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
	await transport.start();
	await transport.request({ type: "prompt", message: "/rail-keep-alive 1" });
	await transport.request({ type: "prompt", message: "/ka-probe" });
	const result = JSON.parse(await readFile(output, "utf8"));
	assert.equal(result.captured, true);
	assert.equal(result.bound, true);
	assert.match(result.status, /KA 1m WAIT.*fresh real request/);
	assert.equal(result.nativeStatus.state, "inactive", "no real request snapshot exists yet");
	assert.equal(result.usage, 0);
});

test("bundled CLI local mock provider: refresh retains request hooks and writes usage, not chat", { timeout: 30_000 }, async (t) => {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "ka-mock-"));
	const output = join(dir, "result.json");
	const log = join(dir, "provider.jsonl");
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundle, "--mode", "rpc", "--no-session", "--model", "rail-ka-local/local", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "-e", fixture],
		cwd: process.cwd(),
		env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", KA_PROBE_OUTPUT: output, KA_PROBE_LOG: log },
	});
	t.after(async () => { await transport.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
	await transport.start();
	await transport.request({ type: "prompt", message: "/rail-keep-alive 1" });
	const settled = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => { off(); reject(new Error("local mock agent did not settle")); }, 10_000);
		const off = transport.onEvent((event) => { if (event.type === "agent_settled") { clearTimeout(timeout); off(); resolve(); } });
	});
	await transport.request({ type: "prompt", message: "real prompt (local mock only)" });
	await settled;
	await transport.request({ type: "prompt", message: "/ka-probe" });
	const result = JSON.parse(await readFile(output, "utf8"));
	const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.equal(result.bound, true);
	assert.equal(result.nativeStatus.state, "scheduled", "manual schedule must not appear inactive without economics");
	assert.equal(result.nativeStatus.decision.economicsAvailable, false);
	assert.equal(result.nativeStatus.manual, true);
	assert.match(result.nativeStatus.reason, /Rail manual 1m/);
	assert.equal(result.usage, 1, JSON.stringify({ result, requests: requests.map(({ payload, ...rest }) => rest) }));
	assert.equal(result.assistant, 1);
	assert.equal(requests.length, 2);
	assert.equal(requests[1].maxTokens, 1);
	assert.deepEqual(requests.map(request => [request.hasPayloadHook, request.hasResponseHook, request.hasHeadersHook]), [[true, true, true], [true, true, true]]);
});

test("real /reload hands the scheduled refresh to the reloaded extension without a new request", { timeout: 30_000 }, async (t) => {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "ka-reload-"));
	const output = join(dir, "result.json");
	const reloadOutput = join(dir, "reload.json");
	const log = join(dir, "provider.jsonl");
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundle, "--mode", "rpc", "--no-session", "--model", "rail-ka-local/local", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "-e", fixture],
		cwd: process.cwd(),
		env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", KA_PROBE_OUTPUT: output, KA_PROBE_LOG: log, KA_RELOAD_OUTPUT: reloadOutput },
	});
	t.after(async () => { await transport.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
	await transport.start();
	await transport.request({ type: "prompt", message: "/rail-keep-alive 3" });
	const settled = new Promise<void>((resolve) => { const off = transport.onEvent((e) => { if (e.type === "agent_settled") { off(); resolve(); } }); });
	await transport.request({ type: "prompt", message: "real local turn" });
	await settled;
	await transport.request({ type: "prompt", message: "/ka-reload" });
	const afterReload = JSON.parse(await readFile(reloadOutput, "utf8"));
	assert.equal(afterReload.label, "KA 3|3", JSON.stringify(afterReload));
	assert.match(afterReload.status, /KA 3m WAIT \(next/);
	await transport.request({ type: "prompt", message: "/ka-probe" });
	const result = JSON.parse(await readFile(output, "utf8"));
	assert.equal(result.usage, 1, "the carried snapshot refreshes after reload");
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
});

test("real compacted session: the scheduled refresh fires after a turn re-projects the messages", { timeout: 30_000 }, async (t) => {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "ka-compacted-"));
	const output = join(dir, "result.json");
	const log = join(dir, "provider.jsonl");
	await mkdir(join(dir, "agent"), { recursive: true });
	await writeFile(join(dir, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundle, "--mode", "rpc", "--no-session", "--model", "rail-ka-local/local", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "-e", fixture],
		cwd: process.cwd(),
		env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", KA_PROBE_OUTPUT: output, KA_PROBE_LOG: log },
	});
	t.after(async () => { await transport.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
	await transport.start();
	const turn = async (message: string) => {
		const settled = new Promise<void>((resolve) => { const off = transport.onEvent((e) => { if (e.type === "agent_settled") { off(); resolve(); } }); });
		await transport.request({ type: "prompt", message });
		await settled;
	};
	await transport.request({ type: "prompt", message: "/rail-keep-alive 3" });
	await turn("first"); await turn("second");
	await transport.request({ type: "compact" });
	await turn("after compaction");
	await transport.request({ type: "prompt", message: "/ka-probe" });
	const result = JSON.parse(await readFile(output, "utf8"));
	assert.equal(result.nativeStatus.state, "scheduled", JSON.stringify(result.nativeStatus));
	assert.equal(result.usage, 1, "the compaction summary is re-created after each turn; the refresh must still be sent");
});

test("real SessionManager + AgentSession.setSessionName preserves an idle warm snapshot", { timeout: 30_000 }, async (t) => {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "ka-name-"));
	const output = join(dir, "result.json");
	const log = join(dir, "provider.jsonl");
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundle, "--mode", "rpc", "--no-session", "--model", "rail-ka-local/local", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "-e", fixture],
		cwd: process.cwd(), env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", KA_PROBE_OUTPUT: output, KA_PROBE_LOG: log },
	});
	t.after(async () => { await transport.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
	await transport.start();
	await transport.request({ type: "prompt", message: "/rail-keep-alive 1" });
	const settled = new Promise<void>((resolve) => { const off = transport.onEvent((e) => { if (e.type === "agent_settled") { off(); resolve(); } }); });
	await transport.request({ type: "prompt", message: "real prompt (local mock)" });
	await settled;
	await transport.request({ type: "prompt", message: "/ka-name" });
	const result = JSON.parse(await readFile(output, "utf8"));
	assert.equal(result.count, 1, JSON.stringify(result));
	assert.match(result.status, /KA 1m WAIT \(next/);
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
});

test("real AgentSession.compact: a refresh while the compaction hook is blocked is not sent", { timeout: 30_000 }, async (t) => {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "ka-compact-"));
	const output = join(dir, "result.json");
	const log = join(dir, "provider.jsonl");
	const agentDir = join(dir, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 100 } }));
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundle, "--mode", "rpc", "--no-session", "--model", "rail-ka-local/local", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "-e", fixture],
		cwd: process.cwd(), env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", KA_PROBE_OUTPUT: output, KA_PROBE_LOG: log },
	});
	t.after(async () => { await transport.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
	await transport.start();
	await transport.request({ type: "prompt", message: "/rail-keep-alive 1" });
	for (let i = 0; i < 2; i++) {
		const settled = new Promise<void>((resolve) => { const off = transport.onEvent((e) => { if (e.type === "agent_settled") { off(); resolve(); } }); });
		await transport.request({ type: "prompt", message: `real local turn ${i}` });
		await settled;
	}
	await transport.request({ type: "prompt", message: "/ka-compact" });
	const result = JSON.parse(await readFile(output, "utf8"));
	assert.equal(result.compacting, true);
	assert.equal(result.cancelledOldRun, true, JSON.stringify(result));
	assert.equal(result.requests, 2, "no warm request during compaction");
	assert.match(result.status, /PAUSED.*busy/, "the compacting session is busy, so the refresh pauses before any request");
});
