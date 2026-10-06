import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { runTeamCommand } from "../../tools/subagents/team-command";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import { restoreTeamHistory } from "../../tools/subagents/team-history";
import { TEAM_JOURNAL_ENTRY_TYPE, type TeamJournalRecord } from "../../tools/subagents/team-journal";
import type { SessionBroker } from "../../tools/subagents/session-broker";
import { TeamOverlayComponent } from "../../tools/subagents/team-overlay";

const plan = { title: "Agent 0.6 release", members: [{ alias: "lead", roleDescription: "Coordinate" }, { alias: "worker", roleDescription: "Implement" }],
	lead: "lead", brief: { goal: "Implement the Agent. Then release it." } };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function commandUi(rename: string | undefined, cancel = false) {
	const rendered: string[] = [];
	const notices: string[] = [];
	let calls = 0;
	return {
		rendered, notices,
		ctx: { mode: "tui", hasUI: true, ui: {
			notify: (message: string) => notices.push(message),
			custom: async (factory: any) => {
				let result: unknown;
				const component = factory({ requestRender: () => undefined, terminal: { rows: 40 } }, theme, { matches: () => false }, (value: unknown) => { result = value; });
				rendered.push(stripTerminalSequences(component.render(73).join("\n")));
				if (++calls === 1) component.handleInput("n");
				else if (cancel) component.handleInput("\x1b");
				else {
					if (rename !== undefined) {
						component.handleInput("\x01");
						component.handleInput("\x0b");
						component.handleInput(rename);
					}
					component.handleInput("\r");
				}
				component.dispose?.();
				return result;
			},
		} } as any,
	};
}

test("/rail-team title renames live Teams, lists their title, validates it, and journals only after launch", async () => {
	const records: TeamJournalRecord[] = [];
	const host = new TeamSessionHost({} as SessionBroker, (record) => records.push(record), []);
	const { teamId } = host.runtime.prepare(plan);
	const ui = commandUi(undefined);
	await runTeamCommand(host, `${teamId} title Prepared release`, ui.ctx);
	assert.equal(records.length, 0, "prepared Teams have no launched history record to rename");
	host.runtime.launch(teamId);
	assert.ok(records[0]?.kind === "launched");
	assert.equal(records[0].title, "Prepared release");
	await runTeamCommand(host, `${teamId.slice(0, 6)} title Renamed release`, ui.ctx);
	assert.equal(host.runtime.getTeam(teamId).title, "Renamed release");
	assert.deepEqual(records.at(-1), { version: 2, kind: "title", teamId, title: "Renamed release", at: records.at(-1)!.at });
	await runTeamCommand(host, "list", ui.ctx);
	assert.match(ui.notices.at(-1)!, /«Renamed release»/u);
	await assert.rejects(runTeamCommand(host, `${teamId} title`, ui.ctx), /title/u);
	await assert.rejects(runTeamCommand(host, `${teamId} title ${"x".repeat(61)}`, ui.ctx), /title/u);
	await assert.rejects(runTeamCommand(host, `${teamId} title Two\nlines`, ui.ctx), /title/u);
	assert.equal(host.runtime.getTeam(teamId).title, "Renamed release");
});

test("UUID prefixes rename read-only history and the latest title survives journal reload", async () => {
	const teamId = "3ce7a106-734b-4f49-a270-924fa00a4c61";
	const records: TeamJournalRecord[] = [
		{ version: 2, kind: "launched", teamId, at: 1, roster: { lead: "lead", members: ["lead", "worker"] }, goal: "Old UUID release. More details." },
		{ version: 2, kind: "interrupted", teamId, at: 2, reason: "Previous session" },
	];
	const entries = () => records.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data }));
	const host = new TeamSessionHost({} as SessionBroker, (record) => records.push(record), entries());
	const ui = commandUi(undefined);
	await runTeamCommand(host, "3ce7a106 title Historical candidate", ui.ctx);
	await runTeamCommand(host, `${teamId} title Historical release`, ui.ctx);
	assert.equal(host.history.teams[0]!.title, "Historical release");
	assert.equal(host.history.teams[0]!.shortId, "3ce7a106");
	assert.equal(restoreTeamHistory(entries()).teams[0]!.title, "Historical release");
	await runTeamCommand(host, "list", ui.ctx);
	assert.match(ui.notices.at(-1)!, /«Historical release»/u);
});

test("popup n uses an editable prefilled Input, submits edits through title command, and Escape cancels", async () => {
	const records: TeamJournalRecord[] = [];
	const host = new TeamSessionHost({} as SessionBroker, (record) => records.push(record), []);
	const { teamId } = host.runtime.prepare(plan);
	host.runtime.launch(teamId);
	const unchanged = commandUi(undefined);
	await runTeamCommand(host, "", unchanged.ctx);
	assert.match(unchanged.rendered[1]!, /Rename Team[\s\S]*Agent 0\.6 release/u);
	assert.equal(host.runtime.getTeam(teamId).title, "Agent 0.6 release", "Enter without typing submits the actual initial value");
	const changed = commandUi("Renamed in popup");
	await runTeamCommand(host, "", changed.ctx);
	assert.equal(host.runtime.getTeam(teamId).title, "Renamed in popup", "the original value can be edited, not just seen as a placeholder");
	assert.equal(records.at(-1)!.kind, "title");
	const count = records.length;
	const cancelled = commandUi(undefined, true);
	await runTeamCommand(host, "", cancelled.ctx);
	assert.equal(records.length, count);
	assert.equal(host.runtime.getTeam(teamId).title, "Renamed in popup");
});

test("popup n renames a selected history Team using the same prefilled command route", async () => {
	const teamId = "history1";
	const records: TeamJournalRecord[] = [{ version: 2, kind: "launched", teamId, at: 1, title: "Historical release", goal: "Retained goal",
		roster: { lead: "lead", members: ["lead", "worker"] } }];
	const host = new TeamSessionHost({} as SessionBroker, (record) => records.push(record), records.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data })));
	const ui = commandUi("Re-reviewed release");
	await runTeamCommand(host, "", ui.ctx);
	assert.match(ui.rendered[1]!, /Rename Team[\s\S]*Historical release/u);
	assert.equal(host.history.teams[0]!.title, "Re-reviewed release");
	assert.equal(records.at(-1)!.kind, "title");
});

test("host prepare retries an ID already present in this session's history", () => {
	const existing = "history1";
	const generated = [existing, "abc23456", "leadEpoch", "workerEpoch"];
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE,
		data: { version: 2, kind: "launched", teamId: existing, at: 1, goal: "Existing release",
			roster: { lead: "lead", members: ["lead", "worker"] } } }], { createId: () => generated.shift()! });
	assert.equal(host.runtime.prepare(plan).teamId, "abc23456");
	assert.equal(host.history.teams[0]!.teamId, existing);
});

test("delayed cancellation cleanup has the same Time row live and after history reload", async () => {
	let at = 1000;
	const records: TeamJournalRecord[] = [];
	const host = new TeamSessionHost({} as SessionBroker, (record) => records.push(record), [], { now: () => at });
	const { teamId } = host.runtime.prepare(plan);
	host.runtime.launch(teamId);
	at = 2000;
	host.runtime.cancelTeam(teamId, "Stop now");
	at = 7000;
	host.runtime.attachCleanupExecutor(teamId, { runActivation: async () => undefined, closeMember: async () => ({ ok: true }) });
	await host.runtime.waitForCompletion(teamId);
	assert.equal(host.teamEndedAt(teamId), 2000);
	const restored = new TeamSessionHost({} as SessionBroker, () => undefined, records.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data })));
	assert.equal(restored.teamEndedAt(teamId), 2000);
	const overview = (current: TeamSessionHost) => {
		const component = new TeamOverlayComponent({ requestRender: () => undefined, terminal: { rows: 40 } } as any, theme as any, { matches: () => false } as any, () => undefined, current);
		component.handleInput("\r");
		const output = stripTerminalSequences(component.render(73).join("\n"));
		component.dispose();
		return output;
	};
	const live = overview(host);
	const history = overview(restored);
	assert.match(live, /Time\s+0:01/u);
	assert.match(history, /Time\s+0:01/u);
	assert.doesNotMatch(history, /paused 0:05/u);
});
