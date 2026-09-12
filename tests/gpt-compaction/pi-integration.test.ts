import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gptCompactionSummary } from "../../tools/gpt-compaction/types";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { createStatelessAgentRunner } from "../../tools/subagents/stateless-runner";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const railExtension = fileURLToPath(new URL("../../index.ts", import.meta.url));
const providerFixture = fileURLToPath(new URL("../fixtures/gpt-compaction-probe.mjs", import.meta.url));
const toolLoopFixture = fileURLToPath(new URL("../fixtures/gpt-compaction-tool-loop.mjs", import.meta.url));

async function writeSeedSession(path: string, invalidDetails = false): Promise<void> {
	const authFingerprint = createHash("sha256").update("api-key:probe-key").digest("hex");
	const checkpoint = { type: "compaction", encrypted_content: "opaque-checkpoint-for-probe" };
	const details = invalidDetails ? {
		version: 2,
		strategy: "gpt-remote-compaction-v2",
		checkpointId: "probe-checkpoint",
	} : {
		version: 2,
		strategy: "gpt-remote-compaction-v2",
		checkpointId: "probe-checkpoint",
		producer: { provider: "cus-resp", api: "openai-responses", model: "gpt-5.6-sol", baseUrl: "https://gateway.example/v1", authFingerprint },
		consumer: { provider: "cus-resp", api: "openai-responses", model: "gpt-5.6-sol", baseUrl: "https://gateway.example/v1", authFingerprint },
		checkpoint,
		replacement: [checkpoint],
		boundary: { parentEntryId: "seed-assistant", firstKeptEntryId: "seed-user", tokensBefore: 100 },
		createdAt: "2025-01-01T00:00:03.000Z",
	};
	const entries = [
		{ type: "session", version: 3, id: "probe-session", timestamp: "2025-01-01T00:00:00.000Z", cwd: process.cwd() },
		{ type: "message", id: "seed-user", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "original history" }], timestamp: 1735689601000 } },
		{ type: "message", id: "seed-assistant", parentId: "seed-user", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "original answer" }], api: "openai-responses", provider: "cus-resp", model: "gpt-5.6-sol", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1735689602000 } },
		{ type: "compaction", id: "seed-compaction", parentId: "seed-assistant", timestamp: "2025-01-01T00:00:03.000Z", summary: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${gptCompactionSummary("probe-checkpoint")}\n</summary>`, firstKeptEntryId: "seed-user", tokensBefore: 100, details, fromHook: true },
	].map((entry) => JSON.stringify(entry)).join("\n");
	await writeFile(path, `${entries}\n`);
}

async function writePlainSeedSession(path: string): Promise<void> {
	const history = "history before manual compaction ".repeat(2_000);
	const entries = [
		{ type: "session", version: 3, id: "plain-probe-session", timestamp: "2025-01-01T00:00:00.000Z", cwd: process.cwd() },
		{ type: "message", id: "plain-user", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: history }], timestamp: 1735689601000 } },
		{ type: "message", id: "plain-assistant", parentId: "plain-user", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "previous answer" }], api: "openai-responses", provider: "cus-resp", model: "gpt-5.6-sol", usage: { input: 10_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10_001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1735689602000 } },
	].map((entry) => JSON.stringify(entry)).join("\n");
	await writeFile(path, `${entries}\n`);
}

async function startMockCompactionServer(): Promise<{
	server: ReturnType<typeof createServer>;
	gateway: string;
	requests: Array<{ url: string | undefined; body: Record<string, any> }>;
}> {
	const requests: Array<{ url: string | undefined; body: Record<string, any> }> = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			requests.push({ url: request.url, body: JSON.parse(raw) as Record<string, any> });
			const checkpoint = { type: "compaction", id: "mock-item", encrypted_content: "opaque-server-checkpoint" };
			const events = [
				`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "mock-response" } })}\n\n`,
				`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "mock-response", status: "completed", output: [checkpoint], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } }, created_at: 1_735_689_600 } })}\n\n`,
			].join("");
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(events);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("mock server did not bind");
	return { server, gateway: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function runProbe(agentDir: string, sessionPath: string, logPath: string, mode: "on" | "off"): Promise<{ code: number | null; stdout: string; stderr: string }> {
	await mkdir(join(agentDir, "rail-gpt-compaction"), { recursive: true });
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: mode }));
	const child = spawn(process.execPath, [
		bundleCli,
		"--mode", "json", "--session", sessionPath, "--no-extensions", "--offline",
		"-e", providerFixture,
		"-e", railExtension,
		"--model", "cus-resp/gpt-5.6-sol",
		"-p", "latest live instruction",
	], {
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_GPT_COMPACTION_PROBE_LOG: logPath },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	const code = await new Promise<number | null>((resolve) => child.once("close", (exitCode) => resolve(exitCode)));
	return { code, stdout, stderr };
}

async function runStatelessProbe(agentDir: string, gateway: string, logPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [
		bundleCli,
		"--mode", "json", "-p", "--no-session", "--no-extensions", "--offline",
		"-e", providerFixture,
		"-e", railExtension,
		"--model", "cus-resp/gpt-5.6-sol",
		"stateless compaction ".repeat(30_000),
	], {
		cwd: process.cwd(),
		env: {
			...process.env,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_CODING_AGENT_DIR: agentDir,
			RAIL_GPT_COMPACTION_GATEWAY: gateway,
			RAIL_GPT_COMPACTION_CONTEXT_WINDOW: "20000",
			RAIL_GPT_COMPACTION_PROBE_LOG: logPath,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	const code = await new Promise<number | null>((resolve) => child.once("close", (exitCode) => resolve(exitCode)));
	return { code, stdout, stderr };
}

async function readProbe(logPath: string): Promise<Record<string, any>> {
	const content = await readFile(logPath, "utf8");
	const record = content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>).find((entry) => entry["kind"] === "provider");
	if (!record) throw new Error(`provider record missing: ${content}`);
	return record;
}

test("real Pi 0.85.1 loads the root extension and preserves live input in off/on replay", { timeout: 30_000 }, async (t) => {
	const sandbox = await mkdtemp(join(process.cwd(), ".tmp-gpt-compaction-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));

	for (const mode of ["off", "on"] as const) {
		const agentDir = join(sandbox, `${mode}-agent`);
		const sessionPath = join(sandbox, `${mode}-session.jsonl`);
		const logPath = join(sandbox, `${mode}-provider.jsonl`);
		await mkdir(agentDir, { recursive: true });
		await writeSeedSession(sessionPath);
		const header = (await readFile(sessionPath, "utf8")).split("\n")[0];
		if (!header) throw new Error("seed session header missing");
		assert.equal(JSON.parse(header).id, "probe-session");
		const result = await runProbe(agentDir, sessionPath, logPath, mode);
		assert.equal(result.code, 0, `${mode}: ${result.stderr}`);
		assert.match(result.stdout, /gpt-compaction-probe/);
		const provider = await readProbe(logPath);
		assert.match(JSON.stringify(provider["payload"]), /latest live instruction/);
		if (mode === "off") {
			assert.doesNotMatch(JSON.stringify(provider["payload"]), /opaque-checkpoint-for-probe/);
			assert.doesNotMatch(JSON.stringify(provider["payload"]), /rail-gpt-compaction:probe-checkpoint/);
			assert.match(JSON.stringify(provider["context"]), /original history/);
		} else {
			assert.equal(provider["payload"].input.filter((item: any) => item.type === "compaction").length, 1);
			assert.match(JSON.stringify(provider["payload"]), /opaque-checkpoint-for-probe/);
			assert.doesNotMatch(JSON.stringify(provider["payload"]), /rail-gpt-compaction:probe-checkpoint/);
		}
	}
});

test("real Pi blocks an invalid Rail marker before the provider sees it", { timeout: 30_000 }, async (t) => {
	const sandbox = await mkdtemp(join(process.cwd(), ".tmp-gpt-compaction-invalid-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const agentDir = join(sandbox, "agent");
	const sessionPath = join(sandbox, "session.jsonl");
	const logPath = join(sandbox, "provider.jsonl");
	await mkdir(agentDir, { recursive: true });
	await writeSeedSession(sessionPath, true);
	const result = await runProbe(agentDir, sessionPath, logPath, "on");
	assert.equal(result.code, 0, result.stderr);
	const provider = await readProbe(logPath);
	assert.doesNotMatch(JSON.stringify(provider["payload"]), /opaque-checkpoint-for-probe|probe-checkpoint|GPT remote compaction checkpoint/);
	assert.match(JSON.stringify(provider["payload"]), /original history/);
});

test("real RPC manual compaction uses the mocked Responses v2 handshake and persists the opaque checkpoint", { timeout: 30_000 }, async (t) => {
	const { server, gateway, requests } = await startMockCompactionServer();
	const sandbox = await mkdtemp(join(process.cwd(), ".tmp-gpt-compaction-rpc-"));
	t.after(async () => {
		await rm(sandbox, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const agentDir = join(sandbox, "agent");
	const sessionPath = join(sandbox, "session.jsonl");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(agentDir, "rail-gpt-compaction"), { recursive: true });
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "on" }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 }, retry: { enabled: false } }));
	await writePlainSeedSession(sessionPath);
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--mode", "rpc", "--session", sessionPath, "--no-extensions", "--offline", "-e", providerFixture, "-e", railExtension, "--model", "cus-resp/gpt-5.6-sol"],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_GPT_COMPACTION_GATEWAY: gateway },
	});
	await transport.start();
	try {
		await transport.request({ type: "compact" });
	} finally {
		await transport.stop();
	}
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.url, "/v1/responses");
	assert.equal(requests[0]?.body["store"], false);
	assert.equal(requests[0]?.body["stream"], true);
	assert.deepEqual(requests[0]?.body["input"].at(-1), { type: "compaction_trigger" });
	assert.equal(requests[0]?.body["input"].filter((item: any) => item["type"] === "compaction_trigger").length, 1);
	const saved = (await readFile(sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
	const compaction = saved.find((entry) => entry["type"] === "compaction");
	if (!compaction) throw new Error(`remote compaction entry missing: ${JSON.stringify(saved)}`);
	assert.equal(compaction["details"]?.checkpoint?.encrypted_content, "opaque-server-checkpoint");
	assert.match(compaction["summary"], /GPT remote compaction checkpoint/);
});

test("a persistent RPC worker observes a global compaction switch without restarting", { timeout: 30_000 }, async (t) => {
	const { server, gateway, requests } = await startMockCompactionServer();
	const sandbox = await mkdtemp(join(process.cwd(), ".tmp-gpt-compaction-worker-settings-"));
	t.after(async () => {
		await rm(sandbox, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const agentDir = join(sandbox, "agent");
	const sessionPath = join(sandbox, "session.jsonl");
	await mkdir(join(agentDir, "rail-gpt-compaction"), { recursive: true });
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "on" }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 }, retry: { enabled: false } }));
	await writePlainSeedSession(sessionPath);
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--mode", "rpc", "--session", sessionPath, "--no-extensions", "--offline", "-e", providerFixture, "-e", railExtension, "--model", "cus-resp/gpt-5.6-sol"],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, RAIL_GPT_COMPACTION_GATEWAY: gateway },
	});
	await transport.start();
	try {
		await transport.request({ type: "compact" });
		assert.equal(requests.length, 1);
		await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "off" }));
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = transport.onEvent((event) => {
				if (event.type !== "agent_settled") return;
				unsubscribe();
				resolve();
			});
		});
		await transport.request({ type: "prompt", message: "live after global switch" });
		await settled;
		await transport.request({ type: "compact" });
	} finally {
		await transport.stop();
	}
	assert.equal(requests.length, 1, "turns after the global off switch must not call Remote v2");
	const saved = (await readFile(sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
	const compactions = saved.filter((entry) => entry["type"] === "compaction");
	assert.ok(compactions.length >= 2);
	assert.equal(compactions.at(-1)?.["details"]?.strategy, undefined, "the persistent worker must repair with native compaction after the switch");
});

test("real Pi stateless JSON mode loads the root extension without a session", { timeout: 30_000 }, async (t) => {
	const { server, gateway, requests } = await startMockCompactionServer();
	const sandbox = await mkdtemp(join(process.cwd(), ".tmp-gpt-compaction-stateless-"));
	t.after(async () => {
		await rm(sandbox, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const agentDir = join(sandbox, "agent");
	const logPath = join(sandbox, "provider.jsonl");
	await mkdir(join(agentDir, "rail-gpt-compaction"), { recursive: true });
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "on" }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, retry: { enabled: false } }));
	const result = await runStatelessProbe(agentDir, gateway, logPath);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /gpt-compaction-probe/);
	assert.equal(requests.length, 0, "--no-session must not attempt to persist or remotely compact a session");
	const providerCalls = (await readFile(logPath, "utf8")).split("\n").filter((line) => line.includes('"kind":"provider"'));
	assert.equal(providerCalls.length, 1);
});

test("real stateless runner can use an ephemeral session for a multi-turn tool compaction", { timeout: 30_000 }, async (t) => {
	const { server, gateway, requests } = await startMockCompactionServer();
	const sandbox = await mkdtemp(join(process.cwd(), ".tmp-gpt-compaction-stateless-runner-"));
	t.after(async () => {
		await rm(sandbox, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const agentDir = join(sandbox, "agent");
	const nestedCwd = join(sandbox, "nested", "cwd");
	const logPath = join(sandbox, "tool-loop.jsonl");
	await mkdir(join(agentDir, "rail-gpt-compaction"), { recursive: true });
	await mkdir(nestedCwd, { recursive: true });
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "on" }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, retry: { enabled: false } }));
	const runner = createStatelessAgentRunner({
		useSessionForCompaction: true,
		resolveInvocation: (args) => {
			const task = args.at(-1)!;
			return {
				command: process.execPath,
				args: [bundleCli, ...args.slice(0, -1), "-e", toolLoopFixture, "-e", railExtension, task],
			};
		},
	});
	const previousGateway = process.env["RAIL_GPT_COMPACTION_GATEWAY"];
	const previousLog = process.env["RAIL_GPT_COMPACTION_TOOL_LOG"];
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["RAIL_GPT_COMPACTION_GATEWAY"] = gateway;
	process.env["RAIL_GPT_COMPACTION_TOOL_LOG"] = logPath;
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(() => {
		if (previousGateway === undefined) delete process.env["RAIL_GPT_COMPACTION_GATEWAY"];
		else process.env["RAIL_GPT_COMPACTION_GATEWAY"] = previousGateway;
		if (previousLog === undefined) delete process.env["RAIL_GPT_COMPACTION_TOOL_LOG"];
		else process.env["RAIL_GPT_COMPACTION_TOOL_LOG"] = previousLog;
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
	});
	const result = await runner({
		model: { provider: "cus-resp", modelId: "gpt-5.6-sol" },
		cwd: nestedCwd,
		contextWindow: 16_000,
		task: `run the tool loop ${"history ".repeat(5_000)}`,
	});
	assert.equal(result.exitCode, 0, result.errorMessage);
	assert.equal(result.output, "tool loop complete");
	assert.ok(requests.length >= 1, "the ephemeral stateless session must enter the real Remote v2 handshake");
	const records = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
	assert.ok(records.some((record) => record["kind"] === "tool"), "the runner must execute real tool turns");
	assert.ok(records.filter((record) => record["kind"] === "provider").length >= 3, "the runner must make multiple provider turns");
});

test("real RPC threshold compaction invokes Remote v2 before the next provider turn", { timeout: 30_000 }, async (t) => {
	const { server, gateway, requests } = await startMockCompactionServer();
	const sandbox = await mkdtemp(join(process.cwd(), ".tmp-gpt-compaction-threshold-"));
	t.after(async () => {
		await rm(sandbox, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const agentDir = join(sandbox, "agent");
	const sessionPath = join(sandbox, "session.jsonl");
	await mkdir(join(agentDir, "rail-gpt-compaction"), { recursive: true });
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "on" }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 }, retry: { enabled: false } }));
	await writePlainSeedSession(sessionPath);
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--mode", "rpc", "--session", sessionPath, "--no-extensions", "--offline", "-e", providerFixture, "-e", railExtension, "--model", "cus-resp/gpt-5.6-sol"],
		cwd: process.cwd(),
		env: {
			...process.env,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_CODING_AGENT_DIR: agentDir,
			RAIL_GPT_COMPACTION_GATEWAY: gateway,
			RAIL_GPT_COMPACTION_CONTEXT_WINDOW: "20000",
		},
	});
	await transport.start();
	const events: Array<Record<string, any>> = [];
	const unsubscribe = transport.onEvent((event) => events.push(event as Record<string, any>));
	const settled = new Promise<void>((resolve) => {
		const settleListener = transport.onEvent((event) => {
			if (event.type !== "agent_settled") return;
			settleListener();
			resolve();
		});
	});
	try {
		await transport.request({ type: "prompt", message: "trigger threshold compaction" });
		await settled;
	} finally {
		unsubscribe();
		await transport.stop();
	}
	const starts = events.filter((event) => event["type"] === "compaction_start");
	assert.equal(starts.length, 1);
	assert.equal(starts[0]?.["reason"], "threshold");
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.url, "/v1/responses");
	assert.deepEqual(requests[0]?.body["input"].at(-1), { type: "compaction_trigger" });
});

test("real RPC overflow recovery compacts once and retries the interrupted turn", { timeout: 30_000 }, async (t) => {
	const { server, gateway, requests } = await startMockCompactionServer();
	const sandbox = await mkdtemp(join(process.cwd(), ".tmp-gpt-compaction-overflow-"));
	t.after(async () => {
		await rm(sandbox, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const agentDir = join(sandbox, "agent");
	const sessionPath = join(sandbox, "session.jsonl");
	const providerLogPath = join(sandbox, "provider.jsonl");
	await mkdir(join(agentDir, "rail-gpt-compaction"), { recursive: true });
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "on" }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, retry: { enabled: false } }));
	await writePlainSeedSession(sessionPath);
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--mode", "rpc", "--session", sessionPath, "--no-extensions", "--offline", "-e", providerFixture, "-e", railExtension, "--model", "cus-resp/gpt-5.6-sol"],
		cwd: process.cwd(),
		env: {
			...process.env,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_CODING_AGENT_DIR: agentDir,
			RAIL_GPT_COMPACTION_GATEWAY: gateway,
			RAIL_GPT_COMPACTION_CONTEXT_WINDOW: "20000",
			RAIL_GPT_COMPACTION_OVERFLOW_ONCE: "1",
			RAIL_GPT_COMPACTION_PROBE_LOG: providerLogPath,
		},
	});
	await transport.start();
	const events: Array<Record<string, any>> = [];
	const unsubscribe = transport.onEvent((event) => events.push(event as Record<string, any>));
	const settled = new Promise<void>((resolve) => {
		const settleListener = transport.onEvent((event) => {
			if (event.type !== "agent_settled") return;
			settleListener();
			resolve();
		});
	});
	try {
		await transport.request({ type: "prompt", message: "recover after overflow" });
		await settled;
	} finally {
		unsubscribe();
		await transport.stop();
	}
	const starts = events.filter((event) => event["type"] === "compaction_start");
	assert.equal(starts.length, 1);
	assert.equal(starts[0]?.["reason"], "overflow");
	assert.equal(requests.length, 1);
	const providerCalls = (await readFile(providerLogPath, "utf8")).split("\n").filter((line) => line.includes('"kind":"provider"'));
	assert.equal(providerCalls.length, 2, "the overflow response must be followed by one retried provider call");
});