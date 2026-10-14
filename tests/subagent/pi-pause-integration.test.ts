import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { contextExtensionPath } from "../../tools/subagents/context-window";
import { PauseGate, pauseGateArgs, SubagentPauseRegistry } from "../../tools/subagents/pause";
import { RpcSessionWorker } from "../../tools/subagents/rpc-worker";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { createStatelessAgentRunner } from "../../tools/subagents/stateless-runner";
import type { RailModelRef } from "../../tools/subagents/models";
import type { WorkerRunResult } from "../../tools/subagents/session-broker";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/pi-subagent-retry.mjs", import.meta.url));
const model: RailModelRef = { provider: "rail-retry-local", modelId: "offline-retry", thinkingLevel: "off" };
const isolatedArgs = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline", "--no-builtin-tools", "-e", fixture];

async function sandbox(name: string): Promise<{ dir: string; agentDir: string }> {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, `pi-pause-${name}-`));
	const agentDir = join(dir, "agent");
	await mkdir(agentDir);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, quietStartup: true }));
	return { dir, agentDir };
}

/** Resolves once an update shows the child parked at its gate. */
function parked(updates: WorkerRunResult[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const poll = () => {
			if (updates.some((update) => update.paused?.state === "confirmed")) resolve();
			else if (Date.now() - started > 10_000) reject(new Error("child never parked at its pause gate"));
			else setTimeout(poll, 20);
		};
		poll();
	});
}

test("real Pi one-off run started during a host-wide pause parks before its first provider request", { timeout: 30_000 }, async () => {
	const { dir, agentDir } = await sandbox("print");
	const oldHome = process.env["HOME"];
	const oldAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["HOME"] = join(dir, "home");
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	const pauses = new SubagentPauseRegistry();
	const updates: WorkerRunResult[] = [];
	try {
		const runner = createStatelessAgentRunner({
			pauses,
			waitForRetry: async () => undefined,
			resolveInvocation: (args) => ({ command: process.execPath, args: [bundleCli, ...isolatedArgs, ...args] }),
		});
		pauses.pauseAll();
		const run = runner({ model, task: "ORIGINAL RETRY TASK", cwd: dir, onUpdate: (update) => updates.push(update) });
		await parked(updates);
		assert.equal(existsSync(join(dir, "provider-requests.jsonl")), false, "no provider request while paused");
		assert.equal(pauses.resumeAll(), 1);
		const result = await run;
		assert.equal(result.output, "continued with recorded tool result");
		assert.equal(result.retryCount, 1);
		assert.equal(result.paused, undefined);
		assert.deepEqual(pauses.list(), []);
	} finally {
		if (oldHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = oldHome;
		if (oldAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = oldAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
});

test("real Pi persistent worker parks at its gate and continues the same native run", { timeout: 30_000 }, async () => {
	const { dir, agentDir } = await sandbox("rpc");
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: "pause-session", timestamp: new Date().toISOString(), cwd: dir })}\n`);
	const gate = new PauseGate(join(dir, "pause", "agt_pause.gate"));
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--mode", "rpc", "--session", sessionPath, "--model", `${model.provider}/${model.modelId}`, ...isolatedArgs,
			"-e", contextExtensionPath(), "--rail-context-protocol", "1", ...pauseGateArgs(gate.file)],
		cwd: dir,
		env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
	});
	const updates: WorkerRunResult[] = [];
	let worker: RpcSessionWorker | undefined;
	try {
		await transport.start();
		worker = await RpcSessionWorker.connect({ agentId: "agt_pause", alias: "pause", model, cwd: dir, mode: "open", sessionPath }, transport, async () => undefined, gate);
		gate.pause();
		const run = worker.send("ORIGINAL RETRY TASK", { onUpdate: (update) => updates.push(update) });
		await parked(updates);
		assert.equal(existsSync(join(dir, "provider-requests.jsonl")), false, "no provider request while paused");
		gate.resume();
		const result = await run;
		assert.equal(result.output, "continued with recorded tool result");
		assert.equal(result.paused, undefined);
		assert.equal(updates.some((update) => update.paused?.state === "requested"), true, "a running child is pausing until it parks");
	} finally {
		if (worker) await worker.stop();
		else await transport.stop();
		await rm(dir, { recursive: true, force: true });
	}
	assert.equal(existsSync(gate.file), false);
});
