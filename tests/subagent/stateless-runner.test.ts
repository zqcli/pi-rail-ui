import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../../subagent/agents";
import { createStatelessAgentRunner } from "../../subagent/stateless-runner";

const profile: AgentConfig = {
	name: "scout",
	description: "Scout quickly",
	tools: ["read", "grep"],
	systemPrompt: "Inspect quickly.",
	source: "user",
	filePath: "/tmp/scout.md",
};

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
		profile,
		task: "inspect auth",
		cwd: process.cwd(),
		defaultModel: "cus-resp/gpt-5.6-luna",
		defaultThinkingLevel: "xhigh",
	});

	assert.deepEqual(capturedArgs.slice(0, 5), ["--mode", "json", "-p", "--no-session", "--model"]);
	assert.equal(capturedArgs.includes("--thinking"), true);
	assert.equal(capturedArgs.includes("--exclude-tools"), true);
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