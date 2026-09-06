import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { RailModelRef } from "../../tools/subagents/models";
import { createStatelessAgentRunner } from "../../tools/subagents/stateless-runner";

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