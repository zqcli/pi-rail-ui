import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { railFastExtensionPath, RAIL_FAST_MODE_FLAG } from "../../commands/rail-fast";
import { railOaiSearchExtensionPath, RAIL_OAI_SEARCH_MODE_FLAG } from "../../commands/rail-oai-search";
import { railResponsesWebSocketExtensionPath } from "../../openai/responses-websocket";
import { test, type TestContext } from "node:test";
import type { RailModelRef } from "../../tools/subagents/models";
import { createStatelessAgentRunner, type StatelessRunResult } from "../../tools/subagents/stateless-runner";
import { PAUSE_ENTRY_TYPE, PAUSE_GATE_FLAG, pauseGateArgs, SubagentPauseRegistry } from "../../tools/subagents/pause";
import { RETRY_DELAYS_MS } from "../../tools/subagents/retry";
import { CONTEXT_PROTOCOL_ERROR_PREFIX, contextExtensionPath } from "../../tools/subagents/context-window";

const model: RailModelRef = { provider: "cus-resp", modelId: "gpt-5.6-luna", thinkingLevel: "xhigh" };

function inlineScript(events: unknown[]): string {
	const settledEvents = [...events, { type: "agent_end", messages: [], willRetry: false }, { type: "agent_settled" }];
	const body = settledEvents.map((event) => `${JSON.stringify(event)}\n`).join("");
	return `process.stdout.write(${JSON.stringify(body)});`;
}

test("stateless runner uses Pi JSON mode with a private session cleaned after exit", async () => {
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const agentDir = await mkdtemp(join(tmpdir(), "rail-stateless-ws-route-"));
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	await mkdir(join(agentDir, "rail-openai-responses-ws"), { recursive: true });
	await writeFile(join(agentDir, "rail-openai-responses-ws", "settings.json"), JSON.stringify({
		version: 1,
		routes: [{ provider: "cus-resp", endpoint: "wss://ai.example.test/v1/responses", models: ["gpt-5.6-luna"] }],
	}));
	let capturedArgs: string[] = [];
	const fixture = resolve("tests/fixtures/fake-pi-json.mjs");
	const runner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			capturedArgs = args;
			return { command: process.execPath, args: [fixture] };
		},
	});
	const updates: any[] = [];

	let result;
	try {
		result = await runner({
			model,
			task: "inspect auth",
			cwd: process.cwd(),
			onUpdate: (update) => updates.push(update),
		});
	} finally {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}

	assert.notEqual(capturedArgs.indexOf("--session"), -1);
	const sessionPath = capturedArgs[capturedArgs.indexOf("--session") + 1];
	assert.ok(sessionPath);
	await assert.rejects(access(dirname(sessionPath)), /ENOENT/);
	assert.deepEqual(capturedArgs, [
		"--mode", "json", "-p", "--session", sessionPath,
		"--model", "cus-resp/gpt-5.6-luna",
		"-e", railResponsesWebSocketExtensionPath(),
		"--thinking", "xhigh",
		"-e", railOaiSearchExtensionPath(), `--${RAIL_OAI_SEARCH_MODE_FLAG}`, "live",
		"--exclude-tools", "subagent",
		...pauseGateArgs(join(dirname(sessionPath), "pause.gate")),
		"Task: inspect auth",
	]);
	assert.equal(result.output, "stateless done");
	assert.equal(result.exitCode, 0);
	assert.deepEqual(result.transcript?.entries.map((entry) => entry.kind), [
		"user",
		"thinking",
		"tool",
		"toolResult",
		"assistant",
	]);
	assert.equal(updates.some((update) => update.transcript?.entries.some((entry: any) => entry.kind === "toolResult")), true);
	assert.equal(updates.some((update) => update.usage.input === 12 && update.usage.output === 3), true);
	assert.deepEqual(result.usage, {
		input: 12,
		output: 3,
		cacheRead: 2,
		cacheWrite: 0,
		cost: 0.04,
		contextTokens: 17,
		turns: 1,
	});
});

test("stateless JSON adapter counts hosted search entries in final and streamed usage", async () => {
	const fixture = resolve("tests/fixtures/fake-pi-json-search.mjs");
	const runner = createStatelessAgentRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture] }),
	});
	const updates: any[] = [];

	const result = await runner({
		model,
		task: "hosted search",
		cwd: process.cwd(),
		onUpdate: (update) => updates.push(update),
	});

	assert.equal(result.exitCode, 0);
	assert.equal(result.output, "search done");
	assert.deepEqual(result.usage, {
		input: 97,
		output: 9,
		cacheRead: 22,
		cacheWrite: 0,
		cost: 0.55,
		contextTokens: 6,
		turns: 2,
		searches: 3,
	});
	assert.equal(updates.some((update) => update.usage.searches === 3), true);
	const flushed = updates.filter((update) => update.output === "search done");
	assert.equal(flushed.length, 1, "the final assistant message_end should flush exactly once");
	assert.equal(flushed[0]?.usage.searches, 3, "the message_end immediate flush should carry the final search count");
	assert.equal(updates.every((update) => (update.usage.searches ?? 0) <= 3), true);
});

test("stateless dispatches load Fast and Search only for GPT models", async () => {
	const fixture = resolve("tests/fixtures/fake-pi-json.mjs");
	let capturedArgs: string[] = [];
	const runner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			capturedArgs = args;
			return { command: process.execPath, args: [fixture] };
		},
	});
	const assertLiveSearch = (label: string) => {
		const extensionIndex = capturedArgs.indexOf(railOaiSearchExtensionPath());
		assert.notEqual(extensionIndex, -1, `${label}: missing search extension`);
		assert.deepEqual(
			capturedArgs.slice(extensionIndex - 1, extensionIndex + 3),
			["-e", railOaiSearchExtensionPath(), `--${RAIL_OAI_SEARCH_MODE_FLAG}`, "live"],
			`${label}: hosted search must always start in live mode`,
		);
		assert.equal(capturedArgs.filter((arg) => arg === railOaiSearchExtensionPath()).length, 1, `${label}: duplicate search extension`);
		assert.equal(capturedArgs.filter((arg) => arg === `--${RAIL_OAI_SEARCH_MODE_FLAG}`).length, 1, `${label}: duplicate search flag`);
	};
	const assertNoNativeExtensions = (label: string) => {
		assert.equal(capturedArgs.includes(railOaiSearchExtensionPath()), false, `${label}: non-GPT must not load Search`);
		assert.equal(capturedArgs.includes(`--${RAIL_OAI_SEARCH_MODE_FLAG}`), false, `${label}: non-GPT must not pass the search flag`);
		assert.equal(capturedArgs.includes(railFastExtensionPath()), false, `${label}: non-GPT must not load Fast`);
		assert.equal(capturedArgs.includes(`--${RAIL_FAST_MODE_FLAG}`), false, `${label}: non-GPT must not pass the fast flag`);
	};

	await runner({ model, task: "default", cwd: process.cwd() });
	assertLiveSearch("default");
	await runner({ model, task: "fast", cwd: process.cwd(), fastMode: true });
	assertLiveSearch("fastMode");
	await runner({ model, task: "explicit budget", cwd: process.cwd(), contextWindow: 64_000 });
	assertLiveSearch("contextWindow");
	const nonGptModel: RailModelRef = { provider: "cus-resp", modelId: "deepseek-v4" };
	await runner({ model: nonGptModel, task: "non-GPT", cwd: process.cwd() });
	assertNoNativeExtensions("non-GPT model");
	await runner({ model: nonGptModel, task: "non-GPT fast", cwd: process.cwd(), fastMode: true });
	assertNoNativeExtensions("non-GPT fastMode");
});

test("stateless runner forwards fastMode only for an explicit true GPT dispatch", async () => {
	const fixture = resolve("tests/fixtures/fake-pi-json.mjs");
	let capturedArgs: string[] = [];
	const runner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			capturedArgs = args;
			return { command: process.execPath, args: [fixture] };
		},
	});

	await runner({ model, task: "fast", cwd: process.cwd(), fastMode: true as any });
	assert.deepEqual(capturedArgs.includes(`--${RAIL_FAST_MODE_FLAG}`), true);
	assert.deepEqual(capturedArgs.includes(railFastExtensionPath()), true);

	await runner({ model, task: "slow", cwd: process.cwd(), fastMode: false as any });
	assert.deepEqual(capturedArgs.includes(`--${RAIL_FAST_MODE_FLAG}`), false);
	assert.deepEqual(capturedArgs.includes(railFastExtensionPath()), false);

	await runner({ model, task: "default", cwd: process.cwd() });
	assert.deepEqual(capturedArgs.includes(`--${RAIL_FAST_MODE_FLAG}`), false);

	await runner({ model: { provider: "cus-resp", modelId: "deepseek-v4" }, task: "non-GPT fast", cwd: process.cwd(), fastMode: true });
	assert.equal(capturedArgs.includes(`--${RAIL_FAST_MODE_FLAG}`), false);
	assert.equal(capturedArgs.includes(railFastExtensionPath()), false);
	assert.equal(capturedArgs.includes(railOaiSearchExtensionPath()), false);
});

test("production stateless runner reuses its private session for persisted GPT compaction", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-stateless-gpt-setting-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	await mkdir(join(agentDir, "rail-gpt-compaction"), { recursive: true });
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "on" }));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
	});
	let capturedArgs: string[] = [];
	const fixture = resolve("tests/fixtures/fake-pi-json.mjs");
	const runner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			capturedArgs = args;
			return { command: process.execPath, args: [fixture] };
		},
	});
	await runner({ model, task: "ephemeral compaction", cwd: process.cwd() });
	assert.equal(capturedArgs.includes("--no-session"), false);
	assert.equal(capturedArgs.includes("--session"), true);
	assert.equal(capturedArgs.some((arg) => arg.endsWith("standalone-extension.ts")), true);
	const sessionIndex = capturedArgs.indexOf("--session");
	const sessionPath = capturedArgs[sessionIndex + 1];
	assert.ok(sessionPath);
	await assert.rejects(access(sessionPath), /ENOENT/);
	let failedSessionPath: string | undefined;
	const failingRunner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			const index = args.indexOf("--session");
			failedSessionPath = args[index + 1];
			throw new Error("invocation construction failed");
		},
	});
	await assert.rejects(failingRunner({ model, task: "setup failure", cwd: process.cwd() }), /invocation construction failed/);
	assert.ok(failedSessionPath);
	await assert.rejects(access(failedSessionPath), /ENOENT/);
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "off" }));
	capturedArgs = [];
	await runner({ model, task: "setting changed between dispatches", cwd: process.cwd() });
	assert.equal(capturedArgs.includes("--no-session"), false);
	assert.equal(capturedArgs.includes("--session"), true);
	assert.equal(capturedArgs.some((arg) => arg.endsWith("standalone-extension.ts")), false);
});

test("GPT setting does not enable GPT compaction for a non-GPT private session", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-stateless-non-gpt-setting-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	await mkdir(join(agentDir, "rail-gpt-compaction"), { recursive: true });
	await writeFile(join(agentDir, "rail-gpt-compaction", "settings.json"), JSON.stringify({ version: 1, remoteCompaction: "on" }));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
	});
	let capturedArgs: string[] = [];
	const runner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			capturedArgs = args;
			return { command: process.execPath, args: [resolve("tests/fixtures/fake-pi-json.mjs")] };
		},
	});
	await runner({ model: { provider: "cus-resp", modelId: "deepseek-v4" }, task: "native only", cwd: process.cwd() });
	assert.equal(capturedArgs.includes("--no-session"), false);
	assert.equal(capturedArgs.includes("--session"), true);
	assert.equal(capturedArgs.some((arg) => arg.endsWith("standalone-extension.ts")), false);
});

test("stateless runner adds the explicit context helper only for an explicit budget", async () => {
	const fixture = resolve("tests/fixtures/fake-pi-json.mjs");
	let explicitArgs: string[] = [];
	const runner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			explicitArgs = args;
			return { command: process.execPath, args: [fixture] };
		},
	});

	await runner({ model, task: "explicit budget", cwd: process.cwd(), contextWindow: 64_000 });
	assert.equal(explicitArgs.includes("-e"), true);
	assert.equal(explicitArgs.includes(contextExtensionPath()), true);
	assert.deepEqual(explicitArgs.slice(-5), ["--rail-context-protocol", "1", "--rail-context-window", "64000", "Task: explicit budget"]);

	let omittedArgs: string[] = [];
	const omittedRunner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			omittedArgs = args;
			return { command: process.execPath, args: [fixture] };
		},
	});
	await omittedRunner({ model, task: "omitted budget", cwd: process.cwd() });
	assert.equal(omittedArgs.includes(railOaiSearchExtensionPath()), true);
	assert.equal(omittedArgs.includes(contextExtensionPath()), false);
	assert.equal(omittedArgs.includes("--rail-context-window"), false);
});

test("explicit context startup errors fail closed and discard child output", async () => {
	const runner = createStatelessAgentRunner({
		resolveInvocation: () => ({ command: process.execPath, args: ["-e", inlineScript([
			{ type: "extension_error", error: `${CONTEXT_PROTOCOL_ERROR_PREFIX}context helper failed` },
			{ type: "agent_start" },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "must be discarded" }], stopReason: "stop" } },
		]) ] }),
	});

	const result = await runner({ model, task: "startup error", cwd: process.cwd(), contextWindow: 64_000 });
	assert.match(result.errorMessage ?? "", /context helper failed/);
	assert.match(result.output, /context protocol failed/);
	assert.doesNotMatch(result.output, /must be discarded/);
	assert.equal(result.transcript, undefined);
});

test("stateless abort clears queued transcript updates before rejecting", async () => {
	const fixture = resolve("tests/fixtures/fake-pi-json-slow.mjs");
	const runner = createStatelessAgentRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture] }),
	});
	const controller = new AbortController();
	const updates: any[] = [];
	let abortSent = false;
	const run = runner({
		model,
		task: "slow task",
		cwd: process.cwd(),
		signal: controller.signal,
		onUpdate: (update) => {
			updates.push(update);
			if (!abortSent) {
				abortSent = true;
				controller.abort();
			}
		},
	});

	await assert.rejects(run, /aborted/);
	const settledCount = updates.length;
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	assert.equal(updates.length, settledCount);
	assert.equal(updates.at(-1).transcript.entries.at(-1).text, "partial");
	assert.equal(updates.at(-1).stopReason, "aborted");
	assert.equal(updates.at(-1).errorMessage, "Subagent request was aborted");
});

test("drops throttle-only updates when the process ends before an assistant message_end", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runner = createStatelessAgentRunner({
		resolveInvocation: () => ({ command: process.execPath, args: ["-e", inlineScript([
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "source" }], isError: false } },
		])] }),
	});
	const updates: any[] = [];

	const result = await runner({
		model,
		task: "result only",
		cwd: process.cwd(),
		onUpdate: (update) => updates.push(update),
	});
	t.mock.timers.tick(100);

	assert.equal(result.exitCode, 0);
	assert.equal(result.output, "(no output)");
	assert.equal(updates.length, 0);
});

async function retryFixture(t: TestContext, config: Record<string, unknown> = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "rail-stateless-retry-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const calls: string[][] = [];
	const resolveInvocation = (args: string[]) => {
		calls.push(args);
		return { command: process.execPath, args: [resolve("tests/fixtures/fake-pi-json-retry.mjs"), JSON.stringify(config), ...args] };
	};
	const sessionPath = () => calls[0]![calls[0]!.indexOf("--session") + 1]!;
	const invocations = async () => (await readFile(join(cwd, "invocations.jsonl"), "utf8")).trim().split("\n")
		.map((line) => JSON.parse(line) as { prompt: string; pid: number });
	const assertCleaned = async () => {
		assert.ok(calls[0]?.includes("--session"));
		await assert.rejects(access(dirname(sessionPath())), /ENOENT/);
	};
	return { cwd, calls, resolveInvocation, sessionPath, invocations, assertCleaned };
}

test("stateless retry reopens the same private session with completed tool results and unchanged options", async (t) => {
	const fixture = await retryFixture(t);
	const waits: number[] = [];
	const updates: StatelessRunResult[] = [];
	const runner = createStatelessAgentRunner({
		resolveInvocation: fixture.resolveInvocation,
		waitForRetry: async (delayMs) => {
			waits.push(delayMs);
			await access(fixture.sessionPath());
			assert.match(await readFile(fixture.sessionPath(), "utf8"), /appended marker once/u);
			const last = (await fixture.invocations()).at(-1)!;
			assert.throws(() => process.kill(last.pid, 0), /ESRCH/u, "retry waits until the prior print child has exited");
		},
	});
	const result = await runner({ model, task: "append marker exactly once", cwd: fixture.cwd, fastMode: true, contextWindow: 64_000, onUpdate: (update) => updates.push(update) });
	assert.deepEqual(waits, [10_000]);
	assert.equal(fixture.calls.length, 2);
	assert.deepEqual(fixture.calls[0]!.slice(0, -1), fixture.calls[1]!.slice(0, -1));
	assert.ok(fixture.calls[1]!.includes(railFastExtensionPath()));
	assert.ok(fixture.calls[1]!.includes(railOaiSearchExtensionPath()));
	assert.ok(fixture.calls[1]!.includes(contextExtensionPath()));
	assert.ok(fixture.calls[1]!.includes("64000"));
	assert.ok(fixture.calls[1]!.includes("xhigh"));
	assert.equal((await fixture.invocations()).filter((call) => call.prompt === "Task: append marker exactly once").length, 1);
	assert.equal(await readFile(join(fixture.cwd, "side-effect.txt"), "utf8"), "once\n");
	assert.equal(result.output, "continued with recorded tool result");
	assert.equal(result.exitCode, 0);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.errorMessage, undefined);
	assert.equal(result.retry, undefined);
	assert.equal(result.retryCount, 1);
	assert.deepEqual(result.usage, { input: 32, output: 6, cacheRead: 3, cacheWrite: 0, cost: 0.32, contextTokens: 24, turns: 3 });
	assert.equal(result.transcript?.entries.filter((entry) => entry.kind === "toolResult").length, 1);
	assert.equal(result.transcript?.entries.some((entry) => entry.kind === "note" && /Continuing/u.test(entry.text)), true);
	assert.equal(updates.some((update) => update.retry?.attempt === 1 && update.retry.error === "503 Service Unavailable" && update.retry.source === "rail"), true);
	assert.equal(updates.some((update) => update.retryCount === 1 && update.usage.input === 32), true);
	const sessionEntries = result.transcript?.entries.filter((entry) => entry.kind === "user") ?? [];
	assert.equal(sessionEntries[0]?.text, "append marker exactly once");
	await fixture.assertCleaned();
});

test("stateless retry exhausts exactly five continuations and folds every attempt once", async (t) => {
	const fixture = await retryFixture(t, { failures: 20 });
	const waits: number[] = [];
	const runner = createStatelessAgentRunner({ resolveInvocation: fixture.resolveInvocation, waitForRetry: async (delay) => { waits.push(delay); } });
	const result = await runner({ model, task: "exhaust", cwd: fixture.cwd });
	assert.deepEqual(waits, [...RETRY_DELAYS_MS]);
	assert.equal(fixture.calls.length, 6);
	assert.equal(result.retryCount, 5);
	assert.equal(result.retry, undefined);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "503 Service Unavailable");
	assert.equal(result.usage.input, 62);
	assert.equal(result.usage.output, 13);
	assert.equal(result.usage.cacheRead, 7);
	assert.equal(result.usage.turns, 7);
	assert.equal(result.usage.contextTokens, 13);
	assert.equal(await readFile(join(fixture.cwd, "side-effect.txt"), "utf8"), "once\n");
	await fixture.assertCleaned();
});

test("stateless terminal native and uncertain process outcomes never retry", async (t) => {
	const cases = [
		{ error: "401 unauthorized" },
		{ error: "429 quota exceeded" },
		{ error: "400 invalid argument" },
		{ error: "503 context length exceeded" },
		{ stopReason: "length" },
		{ stopReason: "aborted" },
		{ noSettled: true },
		{ exitCode: 1 },
		{ signalExit: true },
		{ protocolError: "helper failed" },
		{ malformedLine: true },
		{ malformedAssistant: true },
	];
	for (const config of cases) {
		await t.test(JSON.stringify(config), async (child) => {
			const fixture = await retryFixture(child, config);
			const runner = createStatelessAgentRunner({
				resolveInvocation: fixture.resolveInvocation,
				waitForRetry: async () => assert.fail("terminal or uncertain outcome must not retry"),
			});
			const result = await runner({ model, task: "terminal failure", cwd: fixture.cwd });
			assert.equal(fixture.calls.length, 1);
			assert.equal(result.retryCount, undefined);
			assert.equal(result.retry, undefined);
			assert.ok(result.errorMessage);
			if (config.protocolError) assert.equal(result.transcript, undefined);
			await fixture.assertCleaned();
		});
	}
});

test("stateless apparent success without settlement or with malformed protocol is terminal failure", async (t) => {
	const cases = [
		{ config: { noSettled: true }, error: /without native agent_settled/u },
		{ config: { malformedLine: true }, error: /malformed JSON or message events/u },
		{ config: { malformedAssistant: true }, error: /malformed JSON or message events/u },
	];
	for (const { config, error } of cases) {
		await t.test(JSON.stringify(config), async (child) => {
			const fixture = await retryFixture(child, { failures: 0, ...config });
			const runner = createStatelessAgentRunner({
				resolveInvocation: fixture.resolveInvocation,
				waitForRetry: async () => assert.fail("uncertain completion must not continue"),
			});
			const result = await runner({ model, task: "uncertain completion", cwd: fixture.cwd });
			assert.equal(result.output, "continued with recorded tool result");
			assert.match(result.errorMessage ?? "", error);
			assert.equal(result.usage.input, 22);
			assert.equal(result.usage.turns, 2);
			assert.equal(result.retryCount, undefined);
			assert.equal(fixture.calls.length, 1);
			await fixture.assertCleaned();
		});
	}
});

test("stateless native Pi retry finishes before considering a Rail continuation", async (t) => {
	const fixture = await retryFixture(t, { nativeRecovery: true });
	const updates: StatelessRunResult[] = [];
	const runner = createStatelessAgentRunner({
		resolveInvocation: fixture.resolveInvocation,
		waitForRetry: async () => assert.fail("native recovery succeeded; no outer retry"),
	});
	const result = await runner({ model, task: "native retry", cwd: fixture.cwd, onUpdate: (update) => updates.push(update) });
	assert.equal(fixture.calls.length, 1);
	assert.equal(result.output, "native recovery done");
	assert.equal(result.retryCount, undefined);
	assert.equal(result.errorMessage, undefined);
	assert.equal(updates.some((update) => update.retry?.source === "pi"), true);
	assert.equal(updates.some((update) => update.retry?.source === "rail"), false);
	await fixture.assertCleaned();
});

test("stateless retry fails closed when its session disappears before or during backoff", async (t) => {
	for (const duringBackoff of [false, true]) {
		await t.test(duringBackoff ? "during backoff" : "before backoff", async (child) => {
			const fixture = await retryFixture(child, { removeSession: !duringBackoff });
			const runner = createStatelessAgentRunner({
				resolveInvocation: fixture.resolveInvocation,
				waitForRetry: async () => {
					assert.equal(duringBackoff, true);
					await rm(fixture.sessionPath());
				},
			});
			const result = await runner({ model, task: "missing history", cwd: fixture.cwd });
			assert.equal(fixture.calls.length, 1);
			assert.match(result.errorMessage ?? "", /private session is missing/u);
			assert.equal(result.retry, undefined);
			assert.equal(result.retryCount, undefined);
			await fixture.assertCleaned();
		});
	}
});

test("stateless backoff abort wakes promptly, preserves usage and clears retry state before cleanup", async (t) => {
	const fixture = await retryFixture(t);
	const controller = new AbortController();
	const updates: StatelessRunResult[] = [];
	const runner = createStatelessAgentRunner({ resolveInvocation: fixture.resolveInvocation });
	const started = Date.now();
	await assert.rejects(runner({
		model, task: "abort retry", cwd: fixture.cwd, signal: controller.signal,
		onUpdate: (update) => {
			updates.push(update);
			if (update.retry?.source === "rail") controller.abort();
		},
	}), /aborted/u);
	assert.ok(Date.now() - started < 2000, "abort must not wait for 10s backoff");
	assert.equal(fixture.calls.length, 1);
	assert.equal(updates.at(-1)?.retry, undefined);
	assert.equal(updates.at(-1)?.stopReason, "aborted");
	assert.equal(updates.at(-1)?.usage.input, 12);
	const count = updates.length;
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	assert.equal(updates.length, count, "no transcript/countdown updates after rejection");
	await fixture.assertCleaned();
});

test("stateless active abort reaps the child before deleting its private session", async (t) => {
	const fixture = await retryFixture(t, { stall: true });
	const controller = new AbortController();
	const runner = createStatelessAgentRunner({ resolveInvocation: fixture.resolveInvocation });
	await assert.rejects(runner({
		model, task: "abort active process", cwd: fixture.cwd, signal: controller.signal,
		onUpdate: (update) => {
			if (update.transcript?.entries.some((entry) => entry.kind === "toolResult")) controller.abort();
		},
	}), /aborted/u);
	const child = (await fixture.invocations())[0]!;
	assert.throws(() => process.kill(child.pid, 0), /ESRCH/u);
	assert.equal(await readFile(join(fixture.cwd, "side-effect.txt"), "utf8"), "once\n");
	assert.equal(fixture.calls.length, 1);
	await fixture.assertCleaned();
});

test("stateless concurrent calls never share their private retry sessions", async (t) => {
	const first = await retryFixture(t);
	const second = await retryFixture(t);
	const runFirst = createStatelessAgentRunner({ resolveInvocation: first.resolveInvocation, waitForRetry: async () => {} });
	const runSecond = createStatelessAgentRunner({ resolveInvocation: second.resolveInvocation, waitForRetry: async () => {} });
	const results = await Promise.all([
		runFirst({ model, task: "first isolated call", cwd: first.cwd }),
		runSecond({ model, task: "second isolated call", cwd: second.cwd }),
	]);
	assert.notEqual(first.sessionPath(), second.sessionPath());
	assert.equal(results.every((result) => result.retryCount === 1 && !result.errorMessage), true);
	await first.assertCleaned();
	await second.assertCleaned();
});

test("stateless continuation invocation failure clears retry metadata and preserves prior usage", async (t) => {
	const fixture = await retryFixture(t);
	const updates: StatelessRunResult[] = [];
	const runner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			if (fixture.calls.length > 0) throw new Error("continuation invocation failed");
			return fixture.resolveInvocation(args);
		},
		waitForRetry: async () => {},
	});
	await assert.rejects(runner({ model, task: "resolver retry failure", cwd: fixture.cwd, onUpdate: (update) => updates.push(update) }), /continuation invocation failed/u);
	assert.equal(updates.at(-1)?.retry, undefined);
	assert.equal(updates.at(-1)?.retryCount, 1);
	assert.equal(updates.at(-1)?.usage.input, 12);
	assert.equal(updates.at(-1)?.usage.turns, 2);
	assert.equal(updates.at(-1)?.errorMessage, "continuation invocation failed");
	await fixture.assertCleaned();
});

test("stateless private session is cleaned on first-attempt success, resolver failure and spawn failure", async (t) => {
	const fixture = await retryFixture(t, { failures: 0 });
	const runner = createStatelessAgentRunner({ resolveInvocation: fixture.resolveInvocation });
	const result = await runner({ model, task: "first success", cwd: fixture.cwd });
	assert.equal(fixture.calls.length, 1);
	assert.equal(result.retryCount, undefined);
	await fixture.assertCleaned();
	for (const failBeforeSpawn of [true, false]) {
		let privatePath = "";
		const failing = createStatelessAgentRunner({
			resolveInvocation: (args) => {
				privatePath = args[args.indexOf("--session") + 1]!;
				if (failBeforeSpawn) throw new Error("resolver failed");
				return { command: "/nonexistent/rail-pi", args: [] };
			},
		});
		const run = failing({ model, task: "startup failure", cwd: fixture.cwd });
		if (failBeforeSpawn) await assert.rejects(run, /resolver failed/u);
		else assert.match((await run).errorMessage ?? "", /ENOENT/u);
		await assert.rejects(access(dirname(privatePath)), /ENOENT/u);
	}
});

test("stateless JSON events expose native compaction while it is active and clear it at compaction_end", async () => {
	const secret = "PRIVATE MODEL SUMMARY";
	const runner = createStatelessAgentRunner({
		resolveInvocation: () => ({ command: process.execPath, args: ["-e", inlineScript([
			{ type: "compaction_start", reason: "threshold" },
			{ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 5, errorMessage: "temporary" },
			{ type: "compaction_end", reason: "threshold", result: { summary: secret }, aborted: false, willRetry: true },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done after compaction" }], stopReason: "stop" } },
		])] }),
	});
	const updates: any[] = [];
	const result = await runner({ model, task: "compact task", cwd: process.cwd(), onUpdate: (update) => updates.push(update) });

	assert.equal(updates.some((update) => update.isCompacting === true), true);
	assert.equal(updates.at(-1)?.isCompacting, undefined);
	assert.equal(result.output, "done after compaction");
	assert.equal(result.isCompacting, undefined);
	assert.doesNotMatch(JSON.stringify(updates), new RegExp(secret));
	assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("clears compaction state when the JSON process exits before compaction_end", async () => {
	const runner = createStatelessAgentRunner({
		resolveInvocation: () => ({ command: process.execPath, args: ["-e", inlineScript([
			{ type: "compaction_start", reason: "threshold" },
		])] }),
	});
	const updates: any[] = [];
	const result = await runner({ model, task: "process exit during compaction", cwd: process.cwd(), onUpdate: (update) => updates.push(update) });

	assert.equal(updates.some((update) => update.isCompacting === true), true);
	assert.equal(result.isCompacting, undefined);
	assert.equal(result.output, "(no output)");
});

test("flushes exactly once on the final assistant message_end", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runner = createStatelessAgentRunner({
		resolveInvocation: () => ({ command: process.execPath, args: ["-e", inlineScript([
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{ type: "message_update", usage: { input: 12, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { total: 0.04 } } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 12, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { total: 0.04 } }, stopReason: "stop" } },
		])] }),
	});
	const updates: any[] = [];

	const result = await runner({
		model,
		task: "short run",
		cwd: process.cwd(),
		onUpdate: (update) => updates.push(update),
	});
	t.mock.timers.tick(100);

	assert.equal(updates.length, 1);
	assert.equal(updates.at(-1).output, "done");
	assert.equal(updates.at(-1).stopReason, "stop");
	assert.equal(result.output, "done");
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.usage, {
		input: 12,
		output: 3,
		cacheRead: 2,
		cacheWrite: 0,
		cost: 0.04,
		contextTokens: 17,
		turns: 1,
	});
});

test("fails a malformed assistant tail while keeping observed output, usage and transcript", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const start = { type: "message_start", message: { role: "assistant", content: [] } };
	const first = {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "first done" }], usage: { input: 10, output: 1 }, stopReason: "stop" },
	};
	const malformed = {
		type: "message_end",
		message: { role: "assistant", content: [null, { type: "text", text: "second text" }], usage: { input: 999, output: 9 }, stopReason: "error", errorMessage: "boom" },
	};
	const third = {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "third done" }], usage: { input: 5, output: 1 }, stopReason: "stop" },
	};
	const cases = [
		{
			events: [start, first, start, malformed, start, third],
			updates: ["first done", "third done"],
			output: "third done",
			stopReason: "stop",
			errorMessage: "Subagent process emitted malformed JSON or message events",
			usage: { input: 15, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 },
			transcript: ["malformed tail", "first done", "second text", "boom", "third done"],
		},
		{
			events: [start, first, start, malformed],
			updates: ["first done"],
			output: "first done",
			stopReason: "stop",
			errorMessage: "Subagent process emitted malformed JSON or message events",
			usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			transcript: ["malformed tail", "first done", "second text", "boom"],
		},
	];

	for (const c of cases) {
		const runner = createStatelessAgentRunner({
			resolveInvocation: () => ({ command: process.execPath, args: ["-e", inlineScript(c.events)] }),
		});
		const updates: any[] = [];

		const result = await runner({
			model,
			task: "malformed tail",
			cwd: process.cwd(),
			onUpdate: (update) => updates.push(update),
		});
		t.mock.timers.tick(100);

		assert.deepEqual(updates.map((update) => update.output), c.updates);
		assert.equal(result.output, c.output);
		assert.equal(result.stopReason, c.stopReason);
		assert.equal(result.errorMessage, c.errorMessage);
		assert.deepEqual(result.usage, c.usage);
		assert.deepEqual(result.transcript?.entries.map((entry) => entry.text), c.transcript);
	}
});

test("surfaces a spawn failure through the run's shared error slot", async () => {
	const runner = createStatelessAgentRunner({
		resolveInvocation: () => ({ command: "/nonexistent/rail-pi", args: [] }),
	});
	const updates: any[] = [];

	const result = await runner({
		model,
		task: "boom",
		cwd: process.cwd(),
		onUpdate: (update) => updates.push(update),
	});

	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /ENOENT/);
	assert.equal(result.output, result.errorMessage);
	assert.equal(updates.length, 0);
});
/** A child that reports one message, then parks at the gate like the real pause extension and finishes after resume. */
function pausableChild(args: string[]) {
	const gate = args[args.indexOf(`--${PAUSE_GATE_FLAG}`) + 1]!;
	const parked = (value: boolean) => ({ type: "entry_appended", entry: { type: "custom", customType: PAUSE_ENTRY_TYPE, data: { parked: value } } });
	const script = `
const fs = require("node:fs");
const gate = ${JSON.stringify(gate)};
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
setTimeout(() => process.exit(1), 15000).unref();
out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }], usage: { input: 1, output: 1 }, stopReason: "stop" } });
let isParked = false;
setInterval(() => {
	const held = fs.existsSync(gate);
	if (held && !isParked) { isParked = true; out(${JSON.stringify(parked(true))}); }
	else if (!held && isParked) {
		out(${JSON.stringify(parked(false))});
		out({ type: "agent_end", messages: [], willRetry: false });
		out({ type: "agent_settled" });
		process.exit(0);
	}
}, 10);
`;
	return { command: process.execPath, args: ["-e", script] };
}

async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	assert.equal(condition(), true, "condition was not met in time");
}

test("stateless run registers a pause target, reports requested then confirmed pause, and unregisters after resume", async () => {
	const pauses = new SubagentPauseRegistry();
	let capturedArgs: string[] = [];
	const runner = createStatelessAgentRunner({
		pauses,
		resolveInvocation: (args) => {
			capturedArgs = args;
			return pausableChild(args);
		},
	});
	const updates: StatelessRunResult[] = [];
	const run = runner({ model, task: "pause\nme please", cwd: process.cwd(), onUpdate: (update) => updates.push(update) });

	await until(() => updates.some((update) => update.output === "working"));
	assert.equal(pauses.list().length, 1);
	assert.equal(pauses.list()[0]!.label, "one-off · pause me please");
	const gateFile = pauses.list()[0]!.gate.file;
	assert.deepEqual(capturedArgs.slice(capturedArgs.indexOf("-e", capturedArgs.indexOf("--exclude-tools")), -1), pauseGateArgs(gateFile));
	assert.equal(existsSync(gateFile), false);
	assert.equal(updates.at(-1)!.paused, undefined);

	assert.equal(pauses.pauseAll(), 1);
	assert.equal(existsSync(gateFile), true);
	assert.equal(updates.at(-1)!.paused?.state, "requested", "the child is still running until it parks");
	await until(() => updates.at(-1)!.paused?.state === "confirmed");

	assert.equal(pauses.resumeAll(), 1);
	assert.equal(updates.at(-1)!.paused, undefined);
	const result = await run;
	assert.equal(result.exitCode, 0);
	assert.equal(result.paused, undefined);
	assert.equal(pauses.list().length, 0);
	assert.equal(existsSync(gateFile), false);
});

test("stateless run uses an explicit label and holds a run that starts while the registry is paused", async () => {
	const pauses = new SubagentPauseRegistry();
	pauses.pauseAll();
	const runner = createStatelessAgentRunner({ pauses, resolveInvocation: pausableChild });
	const updates: StatelessRunResult[] = [];
	const run = runner({ model, task: "late", label: "chain step 2 · late", cwd: process.cwd(), onUpdate: (update) => updates.push(update) });
	await until(() => updates.some((update) => update.output === "working"));
	assert.equal(pauses.list()[0]!.label, "chain step 2 · late");
	assert.ok(updates.some((update) => update.paused));
	await until(() => updates.at(-1)!.paused?.state === "confirmed");
	pauses.resumeAll();
	assert.equal((await run).paused, undefined);
});

test("stateless retry waits for resume after its backoff when paused", async (t) => {
	const fixture = await retryFixture(t);
	const pauses = new SubagentPauseRegistry();
	let backoffReached!: () => void;
	const reached = new Promise<void>((resolvePromise) => { backoffReached = resolvePromise; });
	const updates: StatelessRunResult[] = [];
	const runner = createStatelessAgentRunner({
		pauses,
		resolveInvocation: fixture.resolveInvocation,
		waitForRetry: async () => {
			pauses.pauseAll();
			backoffReached();
		},
	});
	const run = runner({ model, task: "append marker exactly once", cwd: fixture.cwd, onUpdate: (update) => updates.push(update) });
	await reached;
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	assert.equal(fixture.calls.length, 1, "no continuation starts while paused");
	assert.equal(updates.at(-1)!.paused?.state, "confirmed", "the parent waiting between attempts counts as parked");
	assert.ok(updates.at(-1)!.retry, "the pending retry stays visible");

	pauses.resumeAll();
	const result = await run;
	assert.equal(fixture.calls.length, 2);
	assert.equal(result.retryCount, 1);
	assert.equal(result.paused, undefined);
	await fixture.assertCleaned();
});
