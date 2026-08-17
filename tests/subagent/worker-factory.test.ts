import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { RailModelRef } from "../../subagent/models";
import { createRpcWorkerFactory } from "../../subagent/worker-factory";

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