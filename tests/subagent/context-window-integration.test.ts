import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FileAgentInstanceStore } from "../../tools/subagents/instance-store";
import { SessionAgentRoster } from "../../tools/subagents/session-links";
import { SessionBroker } from "../../tools/subagents/session-broker";
import { createRpcWorkerFactory } from "../../tools/subagents/worker-factory";
import { contextExtensionPath } from "../../tools/subagents/context-window";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { RpcSessionWorker, buildRpcWorkerArgs, type RpcEvent } from "../../tools/subagents/rpc-worker";
import type { RailModelRef } from "../../tools/subagents/models";
import type { WorkerStartSpec } from "../../tools/subagents/session-broker";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const providerFixture = fileURLToPath(new URL("../fixtures/pi-context-window-stage2.mjs", import.meta.url));
const freezeFixture = fileURLToPath(new URL("../fixtures/pi-context-window-freeze.mjs", import.meta.url));
const freezeReplacementFixture = fileURLToPath(new URL("../fixtures/pi-context-window-freeze-replacement.mjs", import.meta.url));
const sessionLocalFixture = fileURLToPath(new URL("../fixtures/pi-context-window-session-local.mjs", import.meta.url));
const reregisterFixture = fileURLToPath(new URL("../fixtures/pi-context-window-reregister.mjs", import.meta.url));
const modelSelectFixture = fileURLToPath(new URL("../fixtures/pi-context-window-model-select.mjs", import.meta.url));
const compactionBoundaryFixture = fileURLToPath(new URL("../fixtures/pi-context-window-compaction-boundary.mjs", import.meta.url));
const model: RailModelRef = { provider: "rail-stage2-local", modelId: "probe" };

async function runJson(agentDir: string, logPath: string, budget: number | undefined, extensions: string[] = [], trailingExtensions: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const args = [
		bundleCli,
		"--mode", "json", "-p", "--no-session", "--offline", "--no-extensions",
		"-e", providerFixture,
		...extensions.flatMap((extension) => ["-e", extension]),
		"--model", `${model.provider}/${model.modelId}`,
		...(budget === undefined ? [] : ["-e", contextExtensionPath(), "--rail-context-protocol", "1", "--rail-context-window", String(budget)]),
		...trailingExtensions.flatMap((extension) => ["-e", extension]),
		"Task: stateless stage2",
	];
	const child = spawn(process.execPath, args, {
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_CONTEXT_WINDOW_STAGE2_LOG: logPath },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
	return { code, stdout, stderr };
}

async function runModelSelectJson(agentDir: string, logPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [
		bundleCli,
		"--mode", "json", "-p", "--no-session", "--offline", "--no-extensions",
		"-e", modelSelectFixture,
		"-e", contextExtensionPath(), "--rail-context-protocol", "1", "--rail-context-window", "64000",
		"--model", "rail-context-model-select/probe",
		"Task: model select regression",
	], {
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_CONTEXT_WINDOW_MODEL_SELECT_LOG: logPath },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
	return { code, stdout, stderr };
}

async function readProviderWindows(logPath: string): Promise<number[]> {
	const content = await readFile(logPath, "utf8").catch(() => "");
	return content.split("\n").filter(Boolean)
		.map((line) => JSON.parse(line) as { kind?: string; contextWindow?: number })
		.filter((entry) => entry.kind === "provider" && typeof entry.contextWindow === "number")
		.map((entry) => entry.contextWindow!);
}

async function writeSeedSession(path: string): Promise<void> {
	const entries = [
		{ type: "session", version: 3, id: "stage2-seed", timestamp: "2025-01-01T00:00:00.000Z", cwd: process.cwd() },
		{ type: "message", id: "seed-user", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "seed ".repeat(500) }], timestamp: 1735689601000 } },
		{ type: "message", id: "seed-assistant", parentId: "seed-user", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "seed response" }], api: "rail-stage2-local-api", provider: model.provider, model: model.modelId, usage: { input: 500, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 502, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1735689602000 } },
	].map((entry) => JSON.stringify(entry)).join("\n");
	await writeFile(path, `${entries}\n`);
}

async function writeCompactionSeedSession(path: string, provider: string): Promise<void> {
	const entries = [
		{ type: "session", version: 3, id: "stage2-compaction-seed", timestamp: "2025-01-01T00:00:00.000Z", cwd: process.cwd() },
		{ type: "message", id: "seed-user", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "prior history ".repeat(500) }], timestamp: 1735689601000 } },
		{ type: "message", id: "seed-assistant", parentId: "seed-user", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "prior response" }], api: "rail-context-window-compaction-api", provider, model: "probe", usage: { input: 1000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1735689602000 } },
	].map((entry) => JSON.stringify(entry)).join("\n");
	await writeFile(path, `${entries}\n`);
}

async function runCompactionBoundary(sandbox: string, mode: "oracle" | "rail"): Promise<{
	events: string[];
	records: Array<Record<string, any>>;
	messageCount: number;
}> {
	const agentDir = join(sandbox, `${mode}-agent`);
	const provider = mode === "oracle" ? "rail-context-window-compaction-oracle" : "rail-context-window-compaction-rail";
	const sessionPath = join(sandbox, `${mode}-seed.jsonl`);
	const logPath = join(sandbox, `${mode}-events.jsonl`);
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 5 }, retry: { enabled: false } }));
	await writeCompactionSeedSession(sessionPath, provider);
	const args = [
		bundleCli,
		"--no-extensions", "--mode", "rpc", "--session", sessionPath,
		"--model", `${provider}/probe`, "--exclude-tools", "subagent",
		...(mode === "rail" ? ["-e", contextExtensionPath(), "--rail-context-protocol", "1"] : []),
		"-e", compactionBoundaryFixture,
	];
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args,
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_CONTEXT_WINDOW_COMPACTION_LOG: logPath, RAIL_CONTEXT_WINDOW_COMPACTION_MODE: mode },
	});
	await transport.start();
	const events: RpcEvent[] = [];
	const unsubscribe = transport.onEvent((event) => events.push(event));
	let worker: RpcSessionWorker | undefined;
	try {
		if (mode === "rail") {
			const spec: WorkerStartSpec = { agentId: `agt_compaction_${mode}`, mode: "open", sessionPath, model: { provider, modelId: "probe" }, alias: `compaction-${mode}`, cwd: process.cwd() };
			worker = await RpcSessionWorker.connect(spec, transport);
			await worker.send("run the compaction boundary probe", { contextWindow: 64_000 });
		} else {
			let unsubscribeSettled!: () => void;
			const settled = new Promise<void>((resolve) => {
				unsubscribeSettled = transport.onEvent((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribeSettled();
					resolve();
				});
			});
			await transport.request({ type: "prompt", message: "run the compaction boundary probe" });
			await settled;
		}
		const messages = await transport.request({ type: "get_messages" }) as { messages?: unknown[] };
		const records = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
		return { events: events.map((event) => event.type), records, messageCount: messages.messages?.length ?? 0 };
	} finally {
		unsubscribe();
		await worker?.stop().catch(() => undefined);
		await transport.stop().catch(() => undefined);
	}
}

test("real Pi stateless and persistent children observe per-dispatch contextWindow without protocol noise", { timeout: 30_000 }, async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-context-window-stage2-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));

	const statelessAgentDir = join(sandbox, "stateless-agent");
	await mkdir(statelessAgentDir, { recursive: true });
	const statelessLog = join(sandbox, "stateless.jsonl");
	for (const budget of [64_000, 128_000, undefined]) {
		const result = await runJson(statelessAgentDir, statelessLog, budget);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, budget === undefined ? /stage2:128000/ : new RegExp(`stage2:${budget}`));
	}
	assert.deepEqual(await readProviderWindows(statelessLog), [64_000, 128_000, 128_000]);

	const persistentAgentDir = join(sandbox, "persistent-agent");
	await mkdir(persistentAgentDir, { recursive: true });
	const persistentLog = join(sandbox, "persistent.jsonl");
	const spec: WorkerStartSpec = {
		agentId: "agt_stage2",
		mode: "new",
		model,
		alias: "stage2",
		cwd: process.cwd(),
	};
	const args = buildRpcWorkerArgs(spec);
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--no-extensions", ...args, "-e", providerFixture],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: persistentAgentDir, RAIL_CONTEXT_WINDOW_STAGE2_LOG: persistentLog },
	});
	await transport.start();
	let worker: RpcSessionWorker | undefined;
	try {
		worker = await RpcSessionWorker.connect(spec, transport);
		await worker.send("persistent 64000", { contextWindow: 64_000 });
		await worker.send("persistent 128000", { contextWindow: 128_000 });
		await worker.send("persistent omitted");
		assert.deepEqual(await readProviderWindows(persistentLog), [64_000, 128_000, 128_000]);
		const state = await transport.request({ type: "get_state" }) as { model?: { contextWindow?: number }; isStreaming?: boolean; isCompacting?: boolean };
		assert.equal(state.model?.contextWindow, 128_000);
		assert.equal(state.isStreaming, false);
		assert.equal(state.isCompacting, false);
		const sessionPath = worker.sessionFile;
		const session = await readFile(sessionPath, "utf8");
		assert.doesNotMatch(session, /rail-context-internal|"contextWindow"/);
		assert.equal((session.match(/model_change/g) ?? []).length, 1);
	} finally {
		await worker?.stop().catch(() => undefined);
		await transport.stop().catch(() => undefined);
	}

	const thresholdAgentDir = join(sandbox, "threshold-agent");
	await mkdir(thresholdAgentDir, { recursive: true });
	await writeFile(join(thresholdAgentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 }, retry: { enabled: false } }));
	const seedSession = join(sandbox, "threshold-seed.jsonl");
	await writeSeedSession(seedSession);
	const thresholdLog = join(sandbox, "threshold.jsonl");
	const thresholdSpec: WorkerStartSpec = { agentId: "agt_threshold", mode: "fork", model, alias: "threshold", cwd: process.cwd(), sessionPath: seedSession };
	const thresholdTransport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, ...buildRpcWorkerArgs(thresholdSpec), "-e", providerFixture],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: thresholdAgentDir, RAIL_CONTEXT_WINDOW_STAGE2_LOG: thresholdLog },
	});
	await thresholdTransport.start();
	let thresholdWorker: RpcSessionWorker | undefined;
	try {
		thresholdWorker = await RpcSessionWorker.connect(thresholdSpec, thresholdTransport);
		await assert.rejects(() => thresholdWorker!.send("reserve boundary", { contextWindow: 16_384 }), /reserveTokens/);
		const events: string[] = [];
		const unsubscribe = thresholdTransport.onEvent((event) => events.push(event.type));
		await thresholdWorker.send("threshold compaction", { contextWindow: 16_385 });
		unsubscribe();
		assert.ok(events.indexOf("compaction_start") >= 0);
		assert.ok(events.indexOf("compaction_end") > events.indexOf("compaction_start"));
		assert.ok(events.indexOf("agent_start") > events.indexOf("compaction_end"));
		const thresholdWindows = await readProviderWindows(thresholdLog);
		assert.ok(thresholdWindows.length >= 1);
		assert.equal(thresholdWindows.every((window) => window === 16_385), true);
	} finally {
		await thresholdWorker?.stop().catch(() => undefined);
		await thresholdTransport.stop().catch(() => undefined);
	}

	const normalAgentDir = join(sandbox, "normal-threshold-agent");
	await mkdir(normalAgentDir, { recursive: true });
	const normalLog = join(sandbox, "normal-threshold.jsonl");
	const normalTransport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, ...buildRpcWorkerArgs({ ...thresholdSpec, agentId: "agt_normal_threshold" }), "-e", providerFixture],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: normalAgentDir, RAIL_CONTEXT_WINDOW_STAGE2_LOG: normalLog },
	});
	await normalTransport.start();
	let normalWorker: RpcSessionWorker | undefined;
	try {
		normalWorker = await RpcSessionWorker.connect({ ...thresholdSpec, agentId: "agt_normal_threshold" }, normalTransport);
		const events: string[] = [];
		const unsubscribe = normalTransport.onEvent((event) => events.push(event.type));
		await normalWorker.send("normal threshold", { contextWindow: 32_768 });
		unsubscribe();
		assert.equal(events.includes("compaction_start"), false);
		assert.deepEqual(await readProviderWindows(normalLog), [32_768]);
	} finally {
		await normalWorker?.stop().catch(() => undefined);
		await normalTransport.stop().catch(() => undefined);
	}
});

test("turn_end guard preserves native next-turn compaction after same-key model replacement", { timeout: 30_000 }, async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-context-window-compaction-boundary-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const oracle = await runCompactionBoundary(sandbox, "oracle");
	const rail = await runCompactionBoundary(sandbox, "rail");
	const expectedEvents = [
		"agent_start", "turn_start", "message_start", "message_end", "message_start", "message_end",
		"tool_execution_start", "tool_execution_end", "message_start", "message_end", "turn_end",
		"compaction_start", "compaction_end", "turn_start", "message_start", "message_end", "turn_end",
		"agent_end", "agent_settled",
	];
	for (const result of [oracle, rail]) {
		assert.deepEqual(result.events, expectedEvents);
		const compactionStart = result.events.indexOf("compaction_start");
		const compactionEnd = result.events.indexOf("compaction_end");
		const turnEnds = result.events.reduce<number[]>((indexes, type, index) => type === "turn_end" ? [...indexes, index] : indexes, []);
		const turnStarts = result.events.reduce<number[]>((indexes, type, index) => type === "turn_start" ? [...indexes, index] : indexes, []);
		assert.ok(compactionStart >= 0, `${result.events.join(",")} should compact`);
		assert.ok(compactionEnd > compactionStart);
		assert.ok(turnEnds[0]! < compactionStart);
		assert.ok(compactionEnd < turnStarts.at(-1)!);
		assert.ok(turnStarts.at(-1)! < result.events.lastIndexOf("agent_settled"));
		const providers = result.records.filter((record) => record["kind"] === "provider");
		const finalProvider = providers.at(-1)!;
		assert.equal(finalProvider["contextWindow"], 64_000);
		assert.equal(finalProvider["messageCount"], 3);
		assert.deepEqual(finalProvider["roles"], ["user", "assistant", "toolResult"]);
		assert.equal(result.messageCount, 4);
	}
	assert.deepEqual(rail.events, oracle.events);
	const railRecords = rail.records;
	const indexOf = (kind: string, from = 0) => railRecords.findIndex((record, index) => index >= from && record["kind"] === kind);
	const firstTurnEnd = indexOf("turn_end");
	const beforeReregister = indexOf("before_reregister_tool_result");
	const afterReregister = indexOf("after_reregister_tool_result");
	const beforeCompact = indexOf("session_before_compact");
	const compact = indexOf("session_compact");
	const secondTurnStart = railRecords.findIndex((record, index) => index > firstTurnEnd && record["kind"] === "turn_start");
	assert.ok(beforeReregister < afterReregister && afterReregister < firstTurnEnd);
	assert.ok(firstTurnEnd < beforeCompact && beforeCompact < compact && compact < secondTurnStart);
	assert.equal(railRecords.find((_record, index) => index === firstTurnEnd)?.["current"]?.["contextWindow"], 64_000);
});

test("real stateless helper failure is namespaced, handled, and never reaches the provider", { timeout: 30_000 }, async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-context-window-frozen-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const agentDir = join(sandbox, "agent");
	await mkdir(agentDir, { recursive: true });
	const logPath = join(sandbox, "provider.jsonl");
	const result = await runJson(agentDir, logPath, 64_000, [freezeFixture]);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stderr, /\[rail-context-protocol-error\].*read only property/);
	assert.doesNotMatch(result.stdout, /stage2:/);
	assert.equal(await readFile(logPath, "utf8").catch(() => ""), "");

});

test("real model_select during an active override aborts before the replacement provider call", { timeout: 30_000 }, async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-context-window-model-select-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const agentDir = join(sandbox, "agent");
	const logPath = join(sandbox, "provider.jsonl");
	await mkdir(agentDir, { recursive: true });
	const result = await runModelSelectJson(agentDir, logPath);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stderr, /\[rail-context-protocol-error\]/);
	assert.doesNotMatch(await readFile(logPath, "utf8").catch(() => ""), /"kind":"provider"/);
	assert.doesNotMatch(result.stdout, /model-select:/);
});

test("real persistent helper failure retires before provider invocation", { timeout: 30_000 }, async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-context-window-persistent-frozen-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const agentDir = join(sandbox, "agent");
	await mkdir(agentDir, { recursive: true });
	const logPath = join(sandbox, "provider.jsonl");
	const spec: WorkerStartSpec = { agentId: "agt_persistent_frozen", mode: "new", model, alias: "persistent-frozen", cwd: process.cwd() };
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--no-extensions", ...buildRpcWorkerArgs(spec), "-e", providerFixture, "-e", freezeFixture],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_CONTEXT_WINDOW_STAGE2_LOG: logPath },
	});
	await transport.start();
	let worker: RpcSessionWorker | undefined;
	try {
		worker = await RpcSessionWorker.connect(spec, transport);
		await assert.rejects(() => worker!.send("frozen persistent helper", { contextWindow: 64_000 }), /contextWindow|context protocol/);
		assert.equal(worker.isReusable(), false);
		assert.equal(await readFile(logPath, "utf8").catch(() => ""), "");
	} finally {
		await worker?.stop().catch(() => undefined);
		await transport.stop().catch(() => undefined);
	}
});

test("real persistent cleanup preserves a session-local default and same-key replacement keeps the requested budget", { timeout: 30_000 }, async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-context-window-ownership-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const agentDir = join(sandbox, "agent");
	await mkdir(agentDir, { recursive: true });
	const localLog = join(sandbox, "local.jsonl");
	const localSpec: WorkerStartSpec = { agentId: "agt_local_default", mode: "new", model, alias: "local-default", cwd: process.cwd() };
	const localTransport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--no-extensions", ...buildRpcWorkerArgs(localSpec), "-e", providerFixture, "-e", sessionLocalFixture],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_CONTEXT_WINDOW_STAGE2_LOG: localLog },
	});
	await localTransport.start();
	let localWorker: RpcSessionWorker | undefined;
	try {
		localWorker = await RpcSessionWorker.connect(localSpec, localTransport);
		await localWorker.send("preserve session local default", { contextWindow: 64_000 });
		const localState = await localTransport.request({ type: "get_state" }) as { model?: { contextWindow?: number } };
		assert.equal(localState.model?.contextWindow, 150_000);
		assert.deepEqual(await readProviderWindows(localLog), [64_000]);
	} finally {
		await localWorker?.stop().catch(() => undefined);
		await localTransport.stop().catch(() => undefined);
	}

	const replaceLog = join(sandbox, "replace.jsonl");
	const replaceSpec: WorkerStartSpec = { agentId: "agt_reregister", mode: "new", model: { provider: "rail-stage2-reregister", modelId: "probe" }, alias: "reregister", cwd: process.cwd() };
	const replaceTransport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--no-extensions", ...buildRpcWorkerArgs(replaceSpec), "-e", reregisterFixture],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_CONTEXT_WINDOW_REREGISTER_LOG: replaceLog },
	});
	await replaceTransport.start();
	let replaceWorker: RpcSessionWorker | undefined;
	try {
		replaceWorker = await RpcSessionWorker.connect(replaceSpec, replaceTransport);
		await replaceWorker.send("same-key replacement", { contextWindow: 64_000 });
		assert.deepEqual(await readProviderWindows(replaceLog), [64_000]);
		assert.equal(replaceWorker.isReusable(), true);
	} finally {
		await replaceWorker?.stop().catch(() => undefined);
		await replaceTransport.stop().catch(() => undefined);
	}

	const frozenReplaceLog = join(sandbox, "replace-frozen.jsonl");
	const frozenReplaceTransport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--no-extensions", ...buildRpcWorkerArgs({ ...replaceSpec, agentId: "agt_reregister_frozen", alias: "reregister-frozen" }), "-e", freezeReplacementFixture],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_CONTEXT_WINDOW_FREEZE_REPLACEMENT_LOG: frozenReplaceLog, RAIL_CONTEXT_WINDOW_FREEZE_REPLACEMENT_PROVIDER: "rail-stage2-reregister" },
	});
	await frozenReplaceTransport.start();
	let frozenReplaceWorker: RpcSessionWorker | undefined;
	try {
		frozenReplaceWorker = await RpcSessionWorker.connect({ ...replaceSpec, agentId: "agt_reregister_frozen", alias: "reregister-frozen" }, frozenReplaceTransport);
		await assert.rejects(() => frozenReplaceWorker!.send("frozen same-key replacement", { contextWindow: 64_000 }), /context protocol|contextWindow/);
		assert.equal(frozenReplaceWorker.isReusable(), false);
		assert.deepEqual(await readProviderWindows(frozenReplaceLog), []);
	} finally {
		await frozenReplaceWorker?.stop().catch(() => undefined);
		await frozenReplaceTransport.stop().catch(() => undefined);
	}
});

test("real persistent validation race cleans up a worker created before settings changed", { timeout: 30_000 }, async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-context-window-race-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const agentDir = join(sandbox, "agent");
	const stateDir = join(agentDir, "stateful-subagents");
	const logPath = join(sandbox, "provider.jsonl");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 100 } }));
	const store = new FileAgentInstanceStore(stateDir);
	const roster = new SessionAgentRoster(() => undefined);
	const actualFactory = createRpcWorkerFactory({
		stateDir,
		resolveInvocation: (args) => ({ command: process.execPath, args: [bundleCli, "--no-extensions", ...args, "-e", providerFixture] }),
	});
	const broker = new SessionBroker({
		store,
		roster,
		defaultCwd: process.cwd(),
		workerFactory: async (spec) => {
			await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 200 } }));
			return actualFactory(spec);
		},
	});
	try {
		await assert.rejects(
			() => broker.dispatch({ model, alias: "settings-race", task: "must not reach provider", cwd: process.cwd(), contextWindow: 150 }),
			/reserveTokens/,
		);
		assert.deepEqual(await store.list(), []);
		assert.equal(await readFile(logPath, "utf8").catch(() => ""), "");
	} finally {
		await broker.shutdown();
	}
});