import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { contextExtensionPath } from "../../tools/subagents/context-window";
import { RpcSessionWorker, type RpcEvent } from "../../tools/subagents/rpc-worker";
import type { RailModelRef } from "../../tools/subagents/models";
import type { WorkerStartSpec } from "../../tools/subagents/session-broker";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const piPackage = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/pi-compaction-stage1.mjs", import.meta.url));
const model: RailModelRef = { provider: "rail-stage1-local", modelId: "offline-model" };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

async function createSession(sandbox: string, name: string): Promise<{ agentDir: string; sessionPath: string }> {
	const agentDir = join(sandbox, name, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		retry: { enabled: false },
		quietStartup: true,
	}, null, 2));
	const sessionPath = join(sandbox, name, "session.jsonl");
	const entries = [
		{
			type: "session",
			version: 3,
			id: `${name}-session-id`,
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: process.cwd(),
		},
		{
			type: "message",
			id: "00000001",
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
			message: { role: "user", content: `seed ${name} history`, timestamp: 1735689601000 },
		},
		{
			type: "message",
			id: "00000002",
			parentId: "00000001",
			timestamp: "2025-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "seed response" }],
				api: "openai-completions",
				provider: model.provider,
				model: model.modelId,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 1735689602000,
			},
		},
		{
			type: "message",
			id: "00000003",
			parentId: "00000002",
			timestamp: "2025-01-01T00:00:03.000Z",
			message: { role: "user", content: `latest ${name} history`, timestamp: 1735689603000 },
		},
	].map((entry) => JSON.stringify(entry)).join("\n");
	await writeFile(sessionPath, `${entries}\n`);
	return { agentDir, sessionPath };
}

async function startWorker(agentDir: string, sessionPath: string, alias: string): Promise<{ worker: RpcSessionWorker; transport: PiRpcProcessTransport }> {
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [
			bundleCli,
			"--mode", "rpc",
			"--session", sessionPath,
			"--model", `${model.provider}/${model.modelId}`,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--offline",
			"-e", fixture,
			"-e", contextExtensionPath(),
			"--rail-context-protocol", "1",
		],
		cwd: process.cwd(),
		env: {
			...process.env,
			HOME: join(agentDir, "home"),
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
		},
	});
	await transport.start();
	const spec: WorkerStartSpec = {
		agentId: `agt_${alias}`,
		mode: "open",
		model,
		alias,
		cwd: process.cwd(),
		sessionPath,
	};
	try {
		return { worker: await RpcSessionWorker.connect(spec, transport), transport };
	} catch (error) {
		await transport.stop().catch(() => undefined);
		throw error;
	}
}

test("Pi 0.85.1 compaction lifecycle is local, visible, and settled at the correct boundary", { timeout: 30_000 }, async (t) => {
	const { version } = JSON.parse(await readFile(piPackage, "utf8")) as { version: string };
	assert.equal(version, "0.85.1", "repo-local 0.85.1 bundle expected");
	const tempParent = join(process.cwd(), ".tmp");
	await mkdir(tempParent, { recursive: true });
	const sandbox = await mkdtemp(join(tempParent, "pi-compaction-stage1-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));

	const manual = await createSession(sandbox, "manual");
	const manualRuntime = await startWorker(manual.agentDir, manual.sessionPath, "manual");
	const manualEvents: RpcEvent[] = [];
	const manualUpdates: Array<{ isCompacting?: boolean }> = [];
	const unsubscribeManual = manualRuntime.transport.onEvent((event) => manualEvents.push(event));
	let manualAccepted = false;
	try {
		const manualOutcome = manualRuntime.worker.send("/manual-only", {
			onAccepted: () => { manualAccepted = true; },
			onUpdate: (update) => manualUpdates.push(update),
		}).then(
			(result) => ({ status: "resolved" as const, result }),
			(error) => ({ status: "rejected" as const, error: error instanceof Error ? error : new Error(String(error)) }),
		);
		const outcome = await withTimeout(manualOutcome, 2000, "manual compaction-only prompt");
		assert.equal(outcome.status, "rejected");
		if (outcome.status === "rejected") assert.match(outcome.error.message, /handled without starting an agent run/);
		assert.equal(manualAccepted, false);
		assert.deepEqual(manualEvents.map((event) => event.type), ["compaction_start", "compaction_end"]);
		assert.equal(manualUpdates.some((update) => update.isCompacting === true), true);
		assert.equal(manualUpdates.at(-1)?.isCompacting, undefined);
		assert.doesNotMatch(JSON.stringify(manualUpdates), /STAGE1 PRIVATE COMPACTION SUMMARY/);
	} finally {
		unsubscribeManual();
		await manualRuntime.worker.stop();
	}

	const auto = await createSession(sandbox, "auto");
	const autoRuntime = await startWorker(auto.agentDir, auto.sessionPath, "auto");
	const autoEvents: RpcEvent[] = [];
	const autoUpdates: Array<{ isCompacting?: boolean }> = [];
	const unsubscribeAuto = autoRuntime.transport.onEvent((event) => autoEvents.push(event));
	try {
		const result = await withTimeout(autoRuntime.worker.send("run auto compaction", {
			onUpdate: (update) => autoUpdates.push(update),
		}), 4000, "auto compaction run");
		const eventTypes = autoEvents.map((event) => event.type);
		const firstCompactionStart = eventTypes.indexOf("compaction_start");
		const firstCompactionEnd = eventTypes.indexOf("compaction_end");
		const agentStart = eventTypes.indexOf("agent_start");
		const lastCompactionEnd = eventTypes.lastIndexOf("compaction_end");
		const agentSettled = eventTypes.lastIndexOf("agent_settled");
		assert.equal(eventTypes.filter((type) => type === "compaction_start").length, 2);
		assert.equal(eventTypes.filter((type) => type === "compaction_end").length, 2);
		assert.ok(firstCompactionStart >= 0 && firstCompactionStart < firstCompactionEnd);
		assert.ok(firstCompactionEnd < agentStart, "preflight compaction must finish before agent_start");
		assert.ok(agentStart < lastCompactionEnd && lastCompactionEnd < agentSettled, "auto compaction must not replace agent_settled");
		assert.equal(autoUpdates.some((update) => update.isCompacting === true), true);
		assert.equal(autoUpdates.at(-1)?.isCompacting, undefined);
		assert.equal(result.output, "offline local provider response");
		assert.equal(result.isCompacting, undefined);
		assert.doesNotMatch(JSON.stringify(result), /STAGE1 PRIVATE COMPACTION SUMMARY/);
		assert.doesNotMatch(JSON.stringify(result.transcript), /STAGE1 PRIVATE COMPACTION SUMMARY/);
		const state = await autoRuntime.transport.request({ type: "get_state" }) as { isStreaming?: boolean; isCompacting?: boolean };
		assert.equal(state.isStreaming, false);
		assert.equal(state.isCompacting, false);
	} finally {
		unsubscribeAuto();
		await autoRuntime.worker.stop();
	}
});
