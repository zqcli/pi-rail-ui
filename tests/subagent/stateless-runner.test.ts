import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { RailModelRef } from "../../subagent/models";
import { createStatelessAgentRunner } from "../../subagent/stateless-runner";

const model: RailModelRef = { provider: "cus-resp", modelId: "gpt-5.6-luna", thinkingLevel: "xhigh" };

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

	assert.deepEqual(capturedArgs.slice(0, 5), ["--mode", "json", "-p", "--no-session", "--model"]);
	assert.equal(capturedArgs.includes("--thinking"), true);
	assert.equal(capturedArgs.includes("--exclude-tools"), true);
	assert.equal(capturedArgs.includes("--tools"), false);
	assert.equal(capturedArgs.includes("--append-system-prompt"), false);
	assert.equal(capturedArgs.includes("--name"), false);
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
});