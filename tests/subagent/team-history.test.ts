import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGACY_TEAM_HISTORY_TYPE, restoreTeamHistory } from "../../tools/subagents/team-history";
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
			{ id: "lead", lifecycle: "closed", resourceState: "released" },
			{ id: "worker", lifecycle: "closed", resourceState: "released" },
		],
		usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 8, turns: 2 },
		unresolvedIncidents: [],
	};
}

function entries(extra: Array<Record<string, unknown>> = [], closeId = "close-1") {
	return [
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "launched", teamId, at: 1, roster: { lead: "lead", members: ["lead", "worker"] }, goal: "Retain history facts" } },
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

test("unlimited history accepts 20000 results and roots beyond the old count and byte caps, with old launch records", () => {
	const results = Array.from({ length: 20000 }, (_, index): ResultRecord => ({ ...result,
		id: `result-${index}`, work: { workId: `work-${index}`, revision: 1 }, result: { status: "succeeded", summary: "x".repeat(1000) },
	}));
	const allRoots: TeamResult["roots"] = results.map((record) => ({ work: record.work, state: "resolved", resultRef: record.id, review: { disposition: "accepted" } }));
	const finalResultRefs = results.slice(0, 32).map((record) => record.id);
	const journal = entries();
	const close = journal.at(-2)!.data;
	const done = journal.at(-1)!.data;
	const restored = restoreTeamHistory([
		journal[0]!, // old launched records carry neither a plan nor a budget field
		...results.map((record) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "result", teamId, at: 2, result: record } })),
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { ...close, roots: allRoots, resultRefs: finalResultRefs } },
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { ...done, result: { ...terminal(), roots: allRoots, finalResultRefs } } },
	]);
	assert.equal(restored.skipped, 0);
	assert.equal(restored.teams[0]!.results.length, 20000);
	assert.equal(restored.teams[0]!.lifecycle, "closed");
	assert.equal(restored.teams[0]!.finalResultRefs.length, 32);
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

test("U08: retired v1 snapshots and launched v2 Teams without a terminal are read-only interrupted; damaged records are skipped", () => {
	const legacy = (id: string, phase: string) => ({ type: "custom", customType: LEGACY_TEAM_HISTORY_TYPE, data: {
		id, coordinator: "coord", workers: ["B1", "B2"], phase, seq: 9, createdAt: 5, deadline: 0, members: [], events: [],
	} });
	const restored = restoreTeamHistory([
		legacy("v1-running", "running"),
		legacy("v1-finalizing", "finalizing"),
		legacy("v1-prepared", "prepared"),
		legacy("v1-done", "completed"),
		legacy("v1-unknown-phase", "resumable"),
		{ type: "custom", customType: LEGACY_TEAM_HISTORY_TYPE, data: { id: "v1-damaged", coordinator: 7, workers: "B1", phase: "running" } },
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: "not a record" },
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "launched", teamId: "v2-open", at: 1,
			roster: { manager: "lead", workers: ["idle-writer"] }, goal: "An open/idle v2 Team before a parent restart" } },
	]);
	const byId = new Map(restored.teams.map((team) => [team.teamId, team]));
	for (const id of ["v1-running", "v1-finalizing", "v1-prepared"]) {
		assert.equal(byId.get(id)?.lifecycle, "interrupted", `${id} is never shown as live or resumable`);
		assert.equal(byId.get(id)?.version, 1);
		assert.equal(byId.get(id)?.lead, "coord", "the retired coordinator is displayed as the lead");
		assert.deepEqual(byId.get(id)?.members, ["coord", "B1", "B2"]);
	}
	assert.equal(byId.get("v1-done")?.lifecycle, "completed");
	assert.equal(byId.get("v2-open")?.lifecycle, "interrupted", "a v2 Team without a terminal record is interrupted, not closed success");
	assert.equal(byId.get("v2-open")?.outcome, undefined);
	assert.equal(byId.has("v1-unknown-phase"), false);
	assert.equal(byId.has("v1-damaged"), false);
	assert.equal(restored.skipped, 3, "unknown phase, damaged v1 and non-record v2 entries are skipped individually");
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

test("a journal written before the lead model (manager/workers roster, member roles, old budget counters) still loads and displays with the lead", async () => {
	const { formatHistorySummary } = await import("../../tools/subagents/team-tool");
	const oldTerminal = { ...terminal(), members: [
		{ id: "lead", role: "manager", lifecycle: "closed", resourceState: "released" },
		{ id: "worker", role: "worker", lifecycle: "closed", resourceState: "released" },
	] };
	const oldGrant = { id: "g1", actor: "@host", scope: { kind: "team" }, increments: { managerActivations: 64, emergencyManagerActivations: 1 }, reason: "raise", at: 2 };
	const oldPresetGrant = { id: "g2", actor: "@host", scope: { kind: "team" }, preset: "long", increments: { workerPermits: 4, teamToolCalls: 100, activationModelRequests: 63, activationToolCalls: 255 }, reason: "Raise to long", at: 2 };
	const records = entries([{ version: 2, kind: "grant", teamId, at: 2, grant: oldGrant }, { version: 2, kind: "grant", teamId, at: 2, grant: oldPresetGrant }]) as any[];
	records[0].data.roster = { manager: "lead", workers: ["worker"] };
	records[records.length - 1].data.result = oldTerminal;
	const restored = restoreTeamHistory(records);
	assert.equal(restored.skipped, 0, "no old record is dropped");
	const entry = restored.teams[0]!;
	assert.equal(entry.lifecycle, "closed");
	assert.equal(entry.lead, "lead", "the old manager is the lead");
	assert.deepEqual(entry.members, ["lead", "worker"]);
	assert.deepEqual(entry.results.map((record) => record.id), [result.id]);
	assert.deepEqual(entry.finalResultRefs, [result.id]);
	assert.match(formatHistorySummary(entry), /lead lead · members lead, worker · 1 results/u);

	// The same Team written by the current code displays identically.
	const current = restoreTeamHistory(entries()).teams[0]!;
	assert.deepEqual([current.lead, current.members, current.lifecycle], [entry.lead, entry.members, entry.lifecycle]);
	// A damaged roster (the lead missing from the members) is still skipped.
	const damaged = entries() as any[];
	damaged[0].data.roster = { lead: "ghost", members: ["lead", "worker"] };
	assert.equal(restoreTeamHistory(damaged).teams.length, 0);
});
