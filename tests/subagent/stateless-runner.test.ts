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

	const result = await runner({
		model,
		task: "inspect auth",
		cwd: process.cwd(),
	});

	assert.deepEqual(capturedArgs.slice(0, 5), ["--mode", "json", "-p", "--no-session", "--model"]);
	assert.equal(capturedArgs.includes("--thinking"), true);
	assert.equal(capturedArgs.includes("--exclude-tools"), true);
	assert.equal(capturedArgs.includes("--tools"), false);
	assert.equal(capturedArgs.includes("--append-system-prompt"), false);
	assert.equal(result.output, "stateless done");
	assert.equal(result.exitCode, 0);
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