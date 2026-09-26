import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreTeamHistory } from "../../tools/subagents/team-history";
import { TEAM_JOURNAL_ENTRY_TYPE } from "../../tools/subagents/team-journal";
import type { ResultRecord, TeamResult } from "../../tools/subagents/team-protocol";

const teamId = "team-history-1";
const result: ResultRecord = {
	id: "result-1", work: { workId: "work-1", revision: 1 }, author: "worker",
	result: { status: "succeeded", summary: "Complete worker-authored result", findings: ["Observed the expected behavior"] },
	committedAt: 10, source: "explicit_reply",
};
const roots: TeamResult["roots"] = [{
	work: { workId: "work-1", revision: 1 }, state: "resolved", resultRef: result.id,
	review: { disposition: "accepted" },
}];

function terminal(): TeamResult {
	return {
		version: 2, teamId, lifecycle: "closed", outcome: "failed", reason: "Host selected a failed close",
		finalResultRefs: [result.id], roots,
		members: [
			{ id: "lead", role: "manager", lifecycle: "closed", resourceState: "released" },
			{ id: "worker", role: "worker", lifecycle: "closed", resourceState: "released" },
		],
		usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 8, turns: 2 },
		unresolvedIncidents: [],
	};
}

function entries(extra: Array<Record<string, unknown>> = [], closeId = "close-1") {
	return [
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "launched", teamId, at: 1, roster: { manager: "lead", workers: ["worker"] }, goal: "Retain history facts" } },
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "result", teamId, at: 2, result } },
		...extra.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data })),
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "close_decision", teamId, at: 3, closeId, outcome: "failed", resultRefs: [result.id], roots, reason: "Host selected a failed close" } },
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "terminal", teamId, at: 4, closeId, result: terminal() } },
	];
}

test("history retains bounded worker-authored ResultRecords and validates terminal close association", () => {
	const restored = restoreTeamHistory(entries());
	assert.equal(restored.skipped, 0);
	assert.equal(restored.teams.length, 1);
	assert.equal(restored.teams[0]?.lifecycle, "closed");
	assert.equal(restored.teams[0]?.outcome, "failed");
	assert.deepEqual(restored.teams[0]?.finalResultRefs, [result.id]);
	assert.deepEqual(restored.teams[0]?.results, [result], "history keeps the actual result facts, not only a count or summary snapshot");
});

test("a close decision with a mismatched terminal closeId remains interrupted", () => {
	const records = entries();
	const terminalRecord = records.at(-1)!.data as Record<string, unknown>;
	terminalRecord["closeId"] = "different-close";
	const restored = restoreTeamHistory(records);
	assert.equal(restored.teams[0]?.lifecycle, "interrupted");
	assert.equal(restored.teams[0]?.results.length, 1);
	assert.ok(restored.skipped >= 1);
});

test("interrupted history never accepts a later terminal or malformed grant", () => {
	const records = entries([
		{ version: 2, kind: "grant", teamId, at: 2, grant: { id: "g1", actor: "worker", scope: { kind: "team" }, increments: { teamToolCalls: 4 }, reason: "forbidden actor", at: 2 } },
	]) as any[];
	const lateTerminal = records.at(-1);
	records.splice(-2, 2,
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "interrupted", teamId, at: 3, reason: "branch changed" } },
		lateTerminal,
	);
	const restored = restoreTeamHistory(records);
	assert.equal(restored.teams[0]?.lifecycle, "interrupted");
	assert.equal(restored.teams[0]?.reason, "branch changed");
	assert.equal(restored.teams[0]?.finalResultRefs.length, 0);
	assert.ok(restored.skipped >= 2, "invalid grant and late terminal are counted without reviving the Team");
});
