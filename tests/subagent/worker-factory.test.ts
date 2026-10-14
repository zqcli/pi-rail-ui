import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { RailModelRef } from "../../tools/subagents/models";
import { FileSessionLeaseManager } from "../../tools/subagents/session-lease";
import { createRpcWorkerFactory, sessionLeaseKey } from "../../tools/subagents/worker-factory";
import { PiRpcProcessTransport, RpcProcessExitTimeoutError } from "../../tools/subagents/rpc-transport";
import { RpcSessionWorker } from "../../tools/subagents/rpc-worker";
import { PAUSE_GATE_FLAG } from "../../tools/subagents/pause";

const model: RailModelRef = { provider: "cus-resp", modelId: "gpt-5.6-luna", thinkingLevel: "xhigh" };

test("new workers migrate from a startup lease to the same session lease used by resumed workers", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-subagent-worker-factory-"));
	const fixture = resolve("tests/fixtures/fake-pi-rpc.mjs");
	const factory = createRpcWorkerFactory({
		stateDir,
		resolveInvocation: (args) => ({ command: process.execPath, args: [fixture, ...args] }),
	});
	try {
		const first = await factory({ agentId: "agt_first", mode: "new", model, alias: "first", cwd: process.cwd() });
		await first.control?.({ delivery: "steer", message: "Focus on tests" });
		await first.control?.({ delivery: "followUp", message: "Then summarize risks" });
		await assert.rejects(
			() => factory({
				agentId: "agt_second",
				mode: "open",
				model,
				alias: "second",
				cwd: process.cwd(),
				sessionPath: first.sessionFile,
			}),
			/already owned/,
		);
		await first.stop();
		const resumed = await factory({
			agentId: "agt_second",
			mode: "open",
			model,
			alias: "second",
			cwd: process.cwd(),
			sessionPath: first.sessionFile,
		});
		await resumed.stop();
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("only ordinary workers get a pause gate; its file ends with the worker", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-subagent-worker-factory-"));
	const fixture = resolve("tests/fixtures/fake-pi-rpc.mjs");
	const argv = new Map<string, string[]>();
	let current = "";
	const factory = createRpcWorkerFactory({
		stateDir,
		resolveInvocation: (args) => { argv.set(current, args); return { command: process.execPath, args: [fixture, ...args] }; },
	});
	try {
		current = "ordinary";
		const ordinary = await factory({ agentId: "agt_pausable", mode: "new", model, alias: "pausable", cwd: process.cwd() });
		const file = join(stateDir, "pause", "agt_pausable.gate");
		const args = argv.get("ordinary")!;
		assert.equal(args[args.indexOf(`--${PAUSE_GATE_FLAG}`) + 1], file);
		assert.equal(ordinary.pauseGate?.file, file);
		ordinary.pauseGate!.pause();
		assert.equal(existsSync(file), true);
		await ordinary.stop();
		assert.equal(existsSync(file), false);

		current = "team";
		const member = await factory({ agentId: "agt_member", mode: "new", model, alias: "member", cwd: process.cwd(), teamProtocolVersion: 2 });
		assert.equal(argv.get("team")!.includes(`--${PAUSE_GATE_FLAG}`), false);
		assert.equal(member.pauseGate, undefined);
		await member.stop();
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("startup preparation failures release the acquired session lease exactly once", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-subagent-worker-factory-"));
	const sessionPath = join(stateDir, "session.jsonl");
	const key = sessionLeaseKey(sessionPath);
	const releases: string[] = [];
	const originalAcquire = FileSessionLeaseManager.prototype.acquire;
	FileSessionLeaseManager.prototype.acquire = async function (acquireKey: string) {
		const lease = await originalAcquire.call(this, acquireKey);
		return {
			release: async () => {
				releases.push(acquireKey);
				await lease.release();
			},
		};
	};
	try {
		const factory = createRpcWorkerFactory({
			stateDir,
			resolveInvocation: () => {
				throw new Error("resolveInvocation failed");
			},
		});
		await assert.rejects(
			() => factory({ agentId: "agt_open", mode: "open", model, alias: "open", cwd: process.cwd(), sessionPath }),
			/resolveInvocation failed/,
		);
		assert.deepEqual(releases, [key]);

		const leases = new FileSessionLeaseManager(stateDir);
		assert.deepEqual(await leases.inspect(key), { state: "free" });
		const released = await leases.acquire(key);
		await released.release();
		assert.deepEqual(await leases.inspect(key), { state: "free" });
	} finally {
		FileSessionLeaseManager.prototype.acquire = originalAcquire;
		await rm(stateDir, { recursive: true, force: true });
	}
});
test("a worker whose child outlives SIGKILL keeps its session lease until the child is reaped", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-subagent-worker-factory-"));
	const fixture = resolve("tests/fixtures/fake-pi-rpc.mjs");
	const factory = createRpcWorkerFactory({ stateDir, resolveInvocation: (args) => ({ command: process.execPath, args: [fixture, ...args] }) });
	const originalStop = PiRpcProcessTransport.prototype.stop;
	let reap!: () => void;
	try {
		const worker = await factory({ agentId: "agt_stuck", mode: "new", model, alias: "stuck", cwd: process.cwd() });
		const leases = new FileSessionLeaseManager(stateDir);
		const key = sessionLeaseKey(worker.sessionFile);
		PiRpcProcessTransport.prototype.stop = async function (this: PiRpcProcessTransport) {
			const exited = new Promise<void>((resolveExit) => { reap = () => { void originalStop.call(this).then(resolveExit); }; });
			throw new RpcProcessExitTimeoutError("did not exit after SIGKILL", exited);
		};
		await assert.rejects(worker.stop(), /did not exit after SIGKILL/);
		assert.equal((await leases.inspect(key)).state, "owned", "a possibly live child keeps the session lease");
		reap();
		for (let attempt = 0; attempt < 50 && (await leases.inspect(key)).state !== "free"; attempt++) await new Promise((done) => setTimeout(done, 20));
		assert.equal((await leases.inspect(key)).state, "free");
	} finally {
		PiRpcProcessTransport.prototype.stop = originalStop;
		await rm(stateDir, { recursive: true, force: true });
	}
});

for (const mode of ["open", "new"] as const) {
	test(`a ${mode} worker whose startup fails keeps its lease while the started child outlives SIGKILL`, async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "pi-subagent-worker-factory-"));
		const fixture = resolve("tests/fixtures/fake-pi-rpc.mjs");
		const sessionPath = join(stateDir, "session.jsonl");
		const key = mode === "open" ? sessionLeaseKey(sessionPath) : "agent:agt_failed";
		const factory = createRpcWorkerFactory({ stateDir, resolveInvocation: (args) => ({ command: process.execPath, args: [fixture, ...args] }) });
		const originalConnect = RpcSessionWorker.connect;
		const originalStop = PiRpcProcessTransport.prototype.stop;
		let stuck: PiRpcProcessTransport | undefined;
		let reap!: () => void;
		RpcSessionWorker.connect = async () => { throw new Error("connect failed after spawn"); };
		PiRpcProcessTransport.prototype.stop = async function (this: PiRpcProcessTransport) {
			stuck = this;
			const exited = new Promise<void>((resolveExit) => { reap = () => { void originalStop.call(this).then(resolveExit); }; });
			throw new RpcProcessExitTimeoutError("did not exit after SIGKILL", exited);
		};
		try {
			await assert.rejects(
				factory({ agentId: "agt_failed", mode, model, alias: "failed", cwd: process.cwd(), ...(mode === "open" ? { sessionPath } : {}) }),
				/connect failed after spawn/u,
				"the startup error, not the stop error, is reported",
			);
			const leases = new FileSessionLeaseManager(stateDir);
			assert.equal((await leases.inspect(key)).state, "owned", "a possibly live child keeps the lease");
			reap();
			for (let attempt = 0; attempt < 50 && (await leases.inspect(key)).state !== "free"; attempt++) await new Promise((done) => setTimeout(done, 20));
			assert.equal((await leases.inspect(key)).state, "free");
		} finally {
			RpcSessionWorker.connect = originalConnect;
			PiRpcProcessTransport.prototype.stop = originalStop;
			if (stuck) await originalStop.call(stuck);
			await rm(stateDir, { recursive: true, force: true });
		}
	});
}
