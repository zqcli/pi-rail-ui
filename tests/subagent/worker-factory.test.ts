import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { RailModelRef } from "../../tools/subagents/models";
import { FileSessionLeaseManager } from "../../tools/subagents/session-lease";
import { createRpcWorkerFactory, sessionLeaseKey } from "../../tools/subagents/worker-factory";

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