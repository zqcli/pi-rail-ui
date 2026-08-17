import assert from "node:assert/strict";
import { test } from "node:test";
import { buildParentSessionLabel, buildSubagentSessionName } from "../../subagent/session-name";

test("persistent child names include the subagent prefix, parent session name, and alias", () => {
	assert.equal(
		buildSubagentSessionName(buildParentSessionLabel("Main Auth Work", "session-123", "/tmp/auth"), "auth-review"),
		"subagent · Main Auth Work · auth-review",
	);
});

test("unnamed parents use a stable project and session-id fallback", () => {
	assert.equal(
		buildParentSessionLabel(undefined, "01a00f5c-254b-71c4", "/Users/example/project-a"),
		"project-a-01a00f5c",
	);
});

test("session display names strip terminal controls and reserved separators", () => {
	assert.equal(
		buildSubagentSessionName("\u001b[31mMain · Work\u001b[0m", "review/one"),
		"subagent · Main - Work · review-one",
	);
});
