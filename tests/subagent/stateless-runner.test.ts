import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { railFastExtensionPath, RAIL_FAST_MODE_FLAG } from "../../commands/rail-fast";
import { railOaiSearchExtensionPath, RAIL_OAI_SEARCH_MODE_FLAG } from "../../commands/rail-oai-search";
import { test } from "node:test";
import type { RailModelRef } from "../../tools/subagents/models";
import { createStatelessAgentRunner } from "../../tools/subagents/stateless-runner";
import { CONTEXT_PROTOCOL_ERROR_PREFIX, contextExtensionPath } from "../../tools/subagents/context-window";

const model: RailModelRef = { provider: "cus-resp", modelId: "gpt-5.6-luna", thinkingLevel: "xhigh" };

function inlineScript(events: unknown[]): string {
	const body = events.map((event) => `${JSON.stringify(event)}\n`).join("");
	return `process.stdout.write(${JSON.stringify(body)});`;
}

test("stateless runner uses Pi JSON mode without creating a session", async () => {
	let capturedArgs: string[] = [];
	const fixture = resolve("tests/fixtures/fake-pi-json.mjs");
	const runner = createStatelessAgentRunner({
		resolveInvocation: (args) => {
			capturedArgs = args;
			return { command: process.execPath, args: [fixture] };
		},
	});
	const updates: any[] = [];

	const result = await runner({
		model,
		task: "inspect auth",
		cwd: process.cwd(),
		onUpdate: (update) => updates.push(update),
	});

	assert.deepEqual(capturedArgs, [
		"--mode", "json", "-p", "--no-session",
		"--model", "cus-resp/gpt-5.6-luna",
		"--thinking", "xhigh",
		"-e", railOaiSearchExtensionPath(), `--${RAIL_OAI_SEARCH_MODE_FLAG}`, "live",
		"--exclude-tools", "subagent",
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

test("production stateless runner enables an ephemeral session from the persisted GPT setting", async (t) => {
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
	assert.equal(capturedArgs.includes("--no-session"), true);
	assert.equal(capturedArgs.some((arg) => arg.endsWith("standalone-extension.ts")), false);
});

test("GPT setting does not change native stateless semantics for a non-GPT model", async (t) => {
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
	assert.equal(capturedArgs.includes("--no-session"), true);
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

test("ignores the tail of a malformed assistant message_end but keeps its transcript", async (t) => {
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
			errorMessage: undefined,
			usage: { input: 15, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 },
			transcript: ["malformed tail", "first done", "second text", "boom", "third done"],
		},
		{
			events: [start, first, start, malformed],
			updates: ["first done"],
			output: "first done",
			stopReason: "stop",
			errorMessage: undefined,
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