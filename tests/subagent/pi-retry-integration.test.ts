import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { contextExtensionPath } from "../../tools/subagents/context-window";
import { RpcSessionWorker, type RpcEvent } from "../../tools/subagents/rpc-worker";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { createStatelessAgentRunner } from "../../tools/subagents/stateless-runner";
import type { RailModelRef } from "../../tools/subagents/models";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/pi-subagent-retry.mjs", import.meta.url));
const model: RailModelRef = { provider: "rail-retry-local", modelId: "offline-retry", thinkingLevel: "off" };
const isolatedArgs = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline", "--no-builtin-tools", "-e", fixture];

async function records(path: string): Promise<any[]> {
	return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

async function sandbox(name: string, nativeRetry = false): Promise<{ dir: string; agentDir: string }> {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, `pi-retry-${name}-`));
	const agentDir = join(dir, "agent");
	await mkdir(agentDir);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: nativeRetry, maxRetries: 1, baseDelayMs: 50 }, quietStartup: true }));
	return { dir, agentDir };
}

async function assertHistory(dir: string, prompts: number): Promise<void> {
	assert.equal(await readFile(join(dir, "append-marker.txt"), "utf8"), "completed\n", "completed side effect must never replay");
	const requests = await records(join(dir, "provider-requests.jsonl"));
	assert.equal(requests.length, 3);
	assert.equal(requests.every((request) => request.contextWindow === 65536), true, "context override must apply to every model call including retries");
	assert.equal(requests[2].hasResult, true, "continuation must include the actual recorded completed tool result");
	assert.equal(requests[2].messages.filter((message: any) => message.role === "toolResult" && message.toolName === "retry_append").length, 1);
	const events = await records(join(dir, "retry-events.jsonl"));
	const sent = events.filter((event) => event.type === "prompt");
	assert.equal(sent.length, prompts);
	assert.equal(sent.filter((event) => event.prompt.includes("ORIGINAL RETRY TASK")).length, 1);
	if (prompts > 1) {
		assert.match(sent[1].prompt, /Continue from where you stopped/i);
		const firstSettled = events.findIndex((event) => event.type === "agent_settled");
		const continuation = events.findIndex((event) => event === sent[1]);
		assert.ok(firstSettled >= 0 && continuation > firstSettled, "outer continuation cannot precede native settled");
	}
}

async function persistent(nativeRetry: boolean): Promise<void> {
	const { dir, agentDir } = await sandbox(nativeRetry ? "native" : "rpc", nativeRetry);
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: "retry-session", timestamp: new Date().toISOString(), cwd: dir })}\n`);
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--mode", "rpc", "--session", sessionPath, "--model", `${model.provider}/${model.modelId}`, ...isolatedArgs, "-e", contextExtensionPath(), "--rail-context-protocol", "1"],
		cwd: dir,
		env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
	});
	const events: RpcEvent[] = [];
	const updates: any[] = [];
	const waits: number[] = [];
	let worker: RpcSessionWorker | undefined;
	try {
		await transport.start();
		worker = await RpcSessionWorker.connect({ agentId: "agt_retry", alias: "retry", model, cwd: dir, mode: "open", sessionPath }, transport, async (delay) => { waits.push(delay); });
		const unsubscribe = transport.onEvent((event) => events.push(event));
		try {
			const result = await worker.send("ORIGINAL RETRY TASK", { contextWindow: 65536, onUpdate: (update) => updates.push(update) });
			assert.equal(result.output, "continued with recorded tool result");
			assert.equal(result.errorMessage, undefined);
			assert.equal(result.retry, undefined);
			assert.equal(result.retryCount, nativeRetry ? undefined : 1);
			assert.equal(worker.sessionId, "retry-session");
			assert.equal(worker.sessionFile, sessionPath);
			assert.equal(result.usage.input, 30);
			assert.equal(result.usage.output, 6);
			assert.equal(result.usage.cacheRead, 9);
			assert.equal(result.usage.turns, 3);
			assert.deepEqual(waits, nativeRetry ? [] : [10_000]);
			assert.equal(updates.some((update) => update.retry?.source === (nativeRetry ? "pi" : "rail")), true);
			assert.equal(events.filter((event) => event.type === "agent_settled").length, nativeRetry ? 1 : 2);
			const state = await transport.request({ type: "get_state" }) as any;
			assert.equal(state.model.contextWindow, 128000);
			await assertHistory(dir, nativeRetry ? 1 : 2);
		} finally { unsubscribe(); }
	} finally {
		if (worker) await worker.stop();
		else await transport.stop();
		await rm(dir, { recursive: true, force: true });
	}
}

test("real Pi persistent outer retry preserves completed tool history in the same session", { timeout: 20_000 }, async () => {
	await persistent(false);
});

test("real Pi native retry waits for agent_settled and cannot create a duplicate outer attempt", { timeout: 20_000 }, async () => {
	await persistent(true);
});

async function printRun(nativeRetry: boolean): Promise<void> {
	const { dir, agentDir } = await sandbox(nativeRetry ? "print-native" : "print", nativeRetry);
	const oldHome = process.env["HOME"];
	const oldAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["HOME"] = join(dir, "home");
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	const invocations: string[][] = [];
	const waits: number[] = [];
	const updates: any[] = [];
	try {
		const runner = createStatelessAgentRunner({
			waitForRetry: async (delay) => {
				waits.push(delay);
				const first = invocations[0]!;
				assert.equal(existsSync(first[first.indexOf("--session") + 1]!), true, "private session must remain on disk during backoff");
			},
			resolveInvocation: (args) => {
				invocations.push([...args]);
				return { command: process.execPath, args: [bundleCli, ...isolatedArgs, ...args] };
			},
		});
		const result = await runner({ model, task: "ORIGINAL RETRY TASK", cwd: dir, contextWindow: 65536, onUpdate: (update) => updates.push(update) });
		assert.equal(result.output, "continued with recorded tool result");
		assert.equal(result.exitCode, 0);
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.retryCount, nativeRetry ? undefined : 1);
		assert.equal(result.retry, undefined);
		assert.equal(result.usage.input, 30);
		assert.equal(result.usage.turns, 3);
		assert.equal(updates.some((update) => update.retry), true);
		assert.deepEqual(waits, nativeRetry ? [] : [10_000]);
		assert.equal(invocations.length, nativeRetry ? 1 : 2);
		const paths = invocations.map((args) => args[args.indexOf("--session") + 1]);
		assert.equal(new Set(paths).size, 1);
		assert.equal(existsSync(paths[0]!), false, "private session must be removed after the final child exits");
		assert.equal(invocations.every((args) => args.includes("--thinking") && args.includes("65536") && !args.includes("--no-session")), true);
		await assertHistory(dir, nativeRetry ? 1 : 2);
	} finally {
		if (oldHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = oldHome;
		if (oldAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = oldAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
}

test("real Pi one-off print retry reopens its private session and deletes it only after recovery exits", { timeout: 20_000 }, async () => {
	await printRun(false);
});

test("real Pi one-off native retry finishes before an outer continuation can spawn", { timeout: 20_000 }, async () => {
	await printRun(true);
});
