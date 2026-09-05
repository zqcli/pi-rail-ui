import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	applySubagentMentionCompletion,
	buildSubagentRosterPrompt,
	extractSubagentMentions,
	handleDirectSubagentControlInput,
	parseDirectSubagentControl,
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

test("parses only exact leading direct controls and maps delivery names", () => {
	assert.deepEqual(parseDirectSubagentControl("@agent/auth-review steer Focus on tests"), {
		target: "auth-review",
		delivery: "steer",
		message: "Focus on tests",
	});
	assert.deepEqual(parseDirectSubagentControl("@agent/db.review followup Then summarize risks"), {
		target: "db.review",
		delivery: "followUp",
		message: "Then summarize risks",
	});
	assert.deepEqual(parseDirectSubagentControl("@agent/auth-review steer   "), {
		target: "auth-review",
		delivery: "steer",
		message: "",
	});
	for (const text of [
		"Please @agent/auth-review steer Focus on tests",
		" @agent/auth-review steer Focus on tests",
		"@agent/auth-review steering Focus on tests",
		"@agent/auth-review followUp Focus on tests",
		"@agent/auth-review steerable Focus on tests",
		`@agent/${"a".repeat(65)} steer Focus on tests`,
		"@new/cus-resp/gpt-5.6-sol steer Focus on tests",
	]) {
		assert.equal(parseDirectSubagentControl(text), undefined, text);
	}
});

test("direct controls map to the local controller and are consumed", async () => {
	const requests: Array<{ target: string; delivery: "steer" | "followUp"; message: string }> = [];
	const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
		},
	};
	const control = async (target: string, request: { delivery: "steer" | "followUp"; message: string }) => {
		requests.push({ target, ...request });
		return { instance: { alias: target }, delivery: request.delivery };
	};

	const steer = await handleDirectSubagentControlInput(
		{ text: "@agent/auth-review steer Focus on tests", source: "interactive" },
		ctx,
		control,
	);
	const followUp = await handleDirectSubagentControlInput(
		{ text: "@agent/auth-review followup Then summarize risks", source: "rpc" },
		ctx,
		control,
	);

	assert.deepEqual(requests, [
		{ target: "auth-review", delivery: "steer", message: "Focus on tests" },
		{ target: "auth-review", delivery: "followUp", message: "Then summarize risks" },
	]);
	assert.deepEqual([steer, followUp], [{ action: "handled" }, { action: "handled" }]);
	assert.deepEqual(notifications, [
		{ message: "Steer accepted by auth-review", type: "info" },
		{ message: "Follow-up accepted by auth-review", type: "info" },
	]);
});

test("direct control errors are notified with the broker error and consumed", async () => {
	for (const message of [
		"Unknown persistent subagent: missing",
		"Subagent auth-review is not currently running; use target+task to continue an idle or stopped session",
		"Subagent worker is still starting",
		"Subagent session is owned by process 123",
		"Subagent control message cannot be empty",
	]) {
		const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
		const result = await handleDirectSubagentControlInput(
			{ text: message === "Subagent control message cannot be empty" ? "@agent/auth-review followup   " : "@agent/auth-review steer Focus", source: "interactive" },
			{ hasUI: true, ui: { notify: (value: string, type?: "info" | "warning" | "error") => notifications.push({ message: value, type }) } },
			async () => { throw new Error(message); },
		);

		assert.deepEqual(result, { action: "handled" });
		assert.deepEqual(notifications, [{ message, type: "error" }]);
	}
});

test("ordinary mentions, non-UI input, and extension input continue unchanged", async () => {
	let calls = 0;
	const control = async () => {
		calls++;
		return { instance: { alias: "auth-review" }, delivery: "steer" as const };
	};
	const cases = [
		{ text: "@agent/auth-review inspect auth", source: "interactive" as const, hasUI: true },
		{ text: "@new/cus-resp/gpt-5.6-sol review auth", source: "interactive" as const, hasUI: true },
		{ text: "@agent/auth-review steer Focus on tests", source: "interactive" as const, hasUI: false },
		{ text: "@agent/auth-review followup Focus on tests", source: "extension" as const, hasUI: true },
	];

	for (const input of cases) {
		const result = await handleDirectSubagentControlInput(input, {
			hasUI: input.hasUI,
			ui: { notify: () => undefined },
		}, control);
		assert.deepEqual(result, { action: "continue" }, input.text);
	}
	assert.equal(calls, 0);
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
