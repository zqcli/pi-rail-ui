import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	applySubagentMentionCompletion,
	buildSubagentRosterPrompt,
	extractSubagentMentions,
	subagentMentionSuggestions,
} from "../../subagent/interaction";
import type { AgentInstance } from "../../subagent/session-broker";

function instance(alias: string, agentId: string, lastTask: string): AgentInstance {
	return {
		version: 1,
		agentId,
		alias,
		profile: {
			name: "reviewer",
			description: "Review code",
			systemPrompt: "Review carefully.",
			source: "user",
			filePath: "/tmp/reviewer.md",
		},
		sessionId: `session-${agentId}`,
		sessionFile: `/tmp/${agentId}.jsonl`,
		cwd: "/tmp/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		lastTask,
	};
}

describe("subagent mentions", () => {
	test("extracts explicit persistent targets and new profiles without treating file mentions as agents", () => {
		assert.deepEqual(
			extractSubagentMentions("Ask @agent/auth-review and agent://db.review; compare @new/reviewer with new://scout, then read @src/index.ts"),
			{ targets: ["auth-review", "db.review"], profiles: ["reviewer", "scout"] },
		);
	});

	test("suggests only the matching mention namespace", () => {
		const suggestions = subagentMentionSuggestions("@agent/a", [
			{ alias: "auth-review", description: "reviewer · idle" },
			{ alias: "db-review", description: "reviewer · idle" },
		], ["reviewer", "scout"]);

		assert.deepEqual(suggestions, {
			prefix: "@agent/a",
			items: [{ value: "@agent/auth-review", label: "@agent/auth-review", description: "reviewer · idle" }],
		});
		assert.equal(subagentMentionSuggestions("@src/ind", [], ["reviewer"]), null);
	});

	test("replaces the mention token without delegating to file completion", () => {
		assert.deepEqual(
			applySubagentMentionCompletion(["Please ask @agent/a now"], 0, 19, "@agent/auth-review", "@agent/a"),
			{ lines: ["Please ask @agent/auth-review now"], cursorLine: 0, cursorCol: 29 },
		);
	});
});

test("buildSubagentRosterPrompt exposes only linked instances and makes explicit mentions binding", () => {
	const prompt = buildSubagentRosterPrompt(
		[instance("auth-review", "agt_auth", "Review auth concurrency")],
		{ targets: ["auth-review"], profiles: [] },
	);

	assert.match(prompt, /auth-review \(agt_auth\)/);
	assert.match(prompt, /Last task: Review auth concurrency/);
	assert.match(prompt, /must call subagent with target="auth-review"/);
	assert.doesNotMatch(prompt, /sessionFile/);
});

test("buildSubagentRosterPrompt pins project mentions to project scope", () => {
	const prompt = buildSubagentRosterPrompt([], { targets: [], profiles: ["reviewer"] }, [
		{ name: "reviewer", source: "project" },
	]);

	assert.match(prompt, /agentScope="project"/);
});
