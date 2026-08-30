import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	applySubagentMentionCompletion,
	buildSubagentRosterPrompt,
	extractSubagentMentions,
	subagentMentionSuggestions,
} from "../../tools/subagents/interaction";
import type { AgentInstance } from "../../tools/subagents/session-broker";

function instance(alias: string, agentId: string, lastTask: string): AgentInstance {
	return {
		version: 2,
		agentId,
		alias,
		model: { provider: "cus-resp", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh" },
		sessionId: `session-${agentId}`,
		sessionFile: `/tmp/${agentId}.jsonl`,
		cwd: "/tmp/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		lastTask,
	};
}

describe("subagent mentions", () => {
	test("extracts persistent targets and canonical model references without treating file mentions as sessions", () => {
		assert.deepEqual(
			extractSubagentMentions("Ask @agent/auth-review and agent://db.review; compare @new/cus-resp/gpt-5.6-sol with new://deepseek/deepseek-v4-flash:max, then read @src/index.ts"),
			{ targets: ["auth-review", "db.review"], models: ["cus-resp/gpt-5.6-sol", "deepseek/deepseek-v4-flash:max"] },
		);
	});

	test("suggests only the matching mention namespace", () => {
		const suggestions = subagentMentionSuggestions("@agent/a", [
			{ alias: "auth-review", description: "cus-resp/gpt-5.6-sol · idle" },
			{ alias: "db-review", description: "cus-resp/gpt-5.6-sol · idle" },
		], ["cus-resp/gpt-5.6-sol", "deepseek/deepseek-v4-flash"]);

		assert.deepEqual(suggestions, {
			prefix: "@agent/a",
			items: [{ value: "@agent/auth-review", label: "@agent/auth-review", description: "cus-resp/gpt-5.6-sol · idle" }],
		});
		assert.equal(subagentMentionSuggestions("@src/ind", [], ["cus-resp/gpt-5.6-sol"]), null);
	});

	test("replaces the mention token without delegating to file completion", () => {
		assert.deepEqual(
			applySubagentMentionCompletion(["Please ask @agent/a now"], 0, 19, "@agent/auth-review", "@agent/a"),
			{ lines: ["Please ask @agent/auth-review now"], cursorLine: 0, cursorCol: 29 },
		);
	});
});

test("buildSubagentRosterPrompt exposes model-bound sessions and makes explicit targets binding", () => {
	const prompt = buildSubagentRosterPrompt(
		[instance("auth-review", "agt_auth", "Review auth concurrency")],
		{ targets: ["auth-review"], models: [] },
	);

	assert.match(prompt, /auth-review \(agt_auth\).*cus-resp\/gpt-5\.6-sol:xhigh/);
	assert.match(prompt, /Last task: Review auth concurrency/);
	assert.match(prompt, /must call subagent with target="auth-review"/);
	assert.doesNotMatch(prompt, /sessionFile|systemPrompt|profile/);
});

test("buildSubagentRosterPrompt binds new model mentions to the canonical model", () => {
	const prompt = buildSubagentRosterPrompt([], { targets: [], models: ["cus-resp/gpt-5.6-terra"] });

	assert.match(prompt, /model="cus-resp\/gpt-5\.6-terra"/);
});
