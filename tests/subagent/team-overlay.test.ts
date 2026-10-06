import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCompactThreshold } from "../../tools/subagents/team-compaction-settings";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentInstance, SessionBroker } from "../../tools/subagents/session-broker";
import type { TeamHistoryEntry } from "../../tools/subagents/team-history";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import { TEAM_JOURNAL_ENTRY_TYPE } from "../../tools/subagents/team-journal";
import { TeamOverlayComponent, buildTeamTaskRows, type TeamOverlayAction } from "../../tools/subagents/team-overlay";
import type { TeamFlowStats } from "../../tools/subagents/team-flow";
import type { RuntimeActivation } from "../../tools/subagents/team-runtime";
import type { TeamReviewRecord, TeamWorkSummary } from "../../tools/subagents/team-protocol";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = { tab: "\t", backTab: "\x1b[Z", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", escape: "\x1b", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F" };

function fixture(children = 1) {
	let id = 0;
	let time = 1_700_000_000_000;
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [], { createId: () => `id${++id}`, now: () => time += 1000 });
	const { teamId } = host.runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage." }, ...["runner", "waiter", "held"].map((alias) => ({ alias, roleDescription: "Work." }))], lead: "lead",
		brief: { goal: "Ship the local Team popup." }, timeoutSeconds: null,
		initialRequests: [{ to: "runner", task: "Implement the popup" }, { to: "waiter", task: "Review the work\nKeep every detail of this task." }, { to: "held", task: "Check requirements" }],
	});
	const runtime = host.runtime;
	runtime.launch(teamId);
	const next = () => {
		const activation = runtime.takeNextActivation(teamId)!;
		assert.ok(activation);
		assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
		return activation;
	};
	const action = (activation: RuntimeActivation, sequence: number, args: unknown) => {
		const call = `${activation.scope.activationId}-${sequence}`;
		const result = runtime.handleAction(activation.binding, activation.scope, sequence, call, args, call);
		assert.equal(result.ok, true, JSON.stringify(result));
		return call;
	};
	const settle = (activation: RuntimeActivation, call: string) => {
		runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: call });
		runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
	};
	const boot = next();
	settle(boot, action(boot, 1, { action: "yield" }));
	const runner = next();
	const waiter = next();
	const held = next();
	for (let index = 0; index < children; index++) action(waiter, index + 1, { action: "request", to: "runner", task: `Check child ${index + 1}` });
	const childRefs = runtime.listWorks(teamId).filter((work) => work.parent).map((work) => work.work);
	settle(waiter, action(waiter, children + 1, { action: "yield", waitingFor: childRefs, checkpoint: "Await checks" }));
	settle(held, action(held, 1, { action: "yield", attention: "Which requirements?", checkpoint: "Need a decision" }));
	return { host, teamId, runner, action, settle, now: () => time + 5000 };
}

function overlay(host: TeamSessionHost, options: { rows?: number; now?: () => number; theme?: Theme; bindings?: Record<string, string> } = {}) {
	let renders = 0;
	const closed: Array<TeamOverlayAction | undefined> = [];
	const tui = { requestRender: () => renders++, terminal: { rows: options.rows ?? 40 } };
	const bindings: Record<string, string> = { "tui.select.up": keys.up, "tui.select.down": keys.down, "tui.select.confirm": keys.enter, "tui.select.cancel": keys.escape, ...options.bindings };
	const component = new TeamOverlayComponent(tui as any, options.theme ?? theme, { matches: (data: string, action: string) => bindings[action] === data } as any, (action) => closed.push(action), host, options.now);
	return { component, closed, tui, renders: () => renders, text: (width = 120) => component.render(width).join("\n"), key: (key: keyof typeof keys) => component.handleInput(keys[key]) };
}

test("z selects the Progress row or detail and opens the chooser from other tabs", (t) => {
	const { host, teamId } = fixture();
	for (const detail of [false, true]) {
		const ui = overlay(host);
		ui.key("tab"); ui.text(); ui.key("down"); ui.text();
		if (detail) { ui.key("enter"); ui.text(); }
		ui.component.handleInput("z");
		assert.deepEqual(ui.closed, [{ teamId, action: "compact", memberId: "runner" }]);
	}
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.component.handleInput("z");
	assert.deepEqual(ui.closed, [{ teamId, action: "compact" }]);
});

test("t cycles all thresholds, persists them in a temporary agent dir and updates wrapped help", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "team-overlay-compact-"));
	const previous = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = dir;
	t.after(() => {
		if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previous;
		rmSync(dir, { recursive: true, force: true });
	});
	const { host } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	assert.equal(readCompactThreshold(), 80);
	for (const next of [90, 95, null, 60, 70, 80]) {
		ui.component.handleInput("t");
		assert.equal(readCompactThreshold(), next);
		const lines = ui.component.render(73);
		assert.ok(lines.some((line) => line.includes(`t compact at ${next === null ? "off" : `${next}%`}`)));
		for (const line of lines) assert.equal(visibleWidth(line), 73);
	}
	assert.deepEqual(ui.closed, []);
});

test("Members show context, running compaction and the last reduction at popup width", (t) => {
	const { host, teamId } = fixture();
	const team = host.runtime.getTeam(teamId);
	team.members[1]!.context = { used: 286000, window: 328000, percent: 87 };
	team.members[1]!.compacting = true;
	host.runtime.listTeams = () => [team];
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("tab");
	assert.match(ui.text(73), /ctx 286k\/328k 87% · compacting…/u);
	team.members[1]!.compacting = false;
	team.members[1]!.lastCompaction = { tokensBefore: 286000, tokensAfter: 41000 };
	team.members[1]!.context = { used: 41000, window: 328000, percent: 13 };
	assert.match(ui.text(73), /ctx 41k\/328k 13% · compacted 286k→41k/u);
	for (const line of ui.component.render(73)) assert.equal(visibleWidth(line), 73);
});

test("five views show real running, waiting and held work, routes and attention", (t) => {
	const { host, now } = fixture();
	const ui = overlay(host, { now });
	t.after(() => ui.component.dispose());
	assert.match(ui.text(POPUP_WIDTH), /id1 · ACTIVE · \d\d-\d\d \d\d:\d\d → now/u);
	assert.doesNotMatch(ui.text(POPUP_WIDTH), /Progress:|Recent:/u);
	assert.match(ui.text(POPUP_WIDTH), /Waiting\s+Lead decision/u);
	assert.match(ui.text(POPUP_WIDTH), /Attention\s+1 open holds/u);
	assert.match(ui.text(POPUP_WIDTH), /Budget\s+activations/u);
	ui.key("tab");
	assert.match(ui.text(POPUP_WIDTH), /\[Progress\]/u);
	assert.match(ui.text(POPUP_WIDTH), /▶ runner\s+running work/u);
	assert.match(ui.text(POPUP_WIDTH), /⧗ waiter\s+waiting for runner/u);
	assert.match(ui.text(POPUP_WIDTH), /⏸ held\s+held · asks: "Which requirements\?"/u);
	ui.key("tab");
	assert.match(ui.text(POPUP_WIDTH), /3 deliverables · 1 sub-task · 1 running/u);
	ui.key("down"); ui.key("down"); ui.text(); ui.key("right");
	assert.match(ui.text(POPUP_WIDTH), /○ Check child 1\s+runner\s+queued · member busy/u);
	ui.key("tab"); ui.text(); ui.key("home");
	assert.match(ui.text(), /0:00  launch/u);
	assert.match(ui.text(), /waiter requested work.*«Check child 1»/u);
	ui.key("backTab");
	assert.match(ui.text(), /\[Tasks\]/u);
});

test("Members Enter shows full task, outbound works, and latest result with destination", (t) => {
	const { host, runner, action, settle } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("tab"); ui.text(); ui.key("down"); ui.key("down"); ui.text(); ui.key("enter");
	assert.match(ui.text(), /Member waiter · Esc back/u);
	assert.match(ui.text(), /Keep every detail of this task\./u);
	assert.match(ui.text(), /→ runner · queued/u);
	ui.key("escape");
	settle(runner, action(runner, 1, { action: "reply", result: { status: "succeeded", summary: "Popup implemented." } }));
	ui.text(); ui.key("down"); ui.text(); ui.key("enter");
	assert.match(ui.text(), /Latest result: succeeded · /u);
	assert.match(ui.text(), /Latest result: succeeded · "Popup implemented\." · awaiting acceptance/u);
	assert.match(ui.text(), /Popup implemented\./u);
});

test("Tasks fold more than five children, expand with Enter, and collapse again", (t) => {
	const { host } = fixture(6);
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	const original = host.runtime.listWorks.bind(host.runtime);
	host.runtime.listWorks = (id) => original(id).map((work) => work.parent ? { ...work, state: "resolved" } : work);
	ui.key("tab"); ui.key("tab"); ui.text();
	assert.doesNotMatch(ui.text(), /sub-tasks done|Check child/u, "sub-tasks stay collapsed until the deliverable is expanded");
	ui.key("down"); ui.key("down"); ui.text(); ui.key("right");
	assert.match(ui.text(), /✓ 6 sub-tasks done \[\+\]/u);
	assert.doesNotMatch(ui.text(), /Check child 6/u);
	ui.key("down"); ui.text(); ui.key("enter");
	assert.match(ui.text(), /\[−\]/u);
	ui.key("pageDown");
	assert.match(ui.text(), /Check child 6/u);
	for (let index = 0; index < 6; index++) ui.key("up");
	ui.key("enter");
	assert.doesNotMatch(ui.text(), /Check child 6/u);
});

test("task rows preserve nesting across parent revisions and use state/review icons", () => {
	const root: TeamWorkSummary = { work: { workId: "work:root", revision: 2 }, title: "Root release", requester: "lead", assignee: "gate", state: "resolved", review: "accepted", taskPreview: "Full root instruction", resultRef: "result:one" };
	const children = ["resolved", "running", "blocked", "failed", "cancelled", "superseded", "queued"] as const;
	const works: TeamWorkSummary[] = [root, ...children.map((state, index) => ({ work: { workId: `work:c${index}`, revision: 1 }, parent: { ...root.work, revision: 1 }, requester: "gate", assignee: index % 2 ? "rpc" : "reviewer", state, taskPreview: `Child\n${index}` }))];
	const rows = buildTeamTaskRows(works, new Set([`${root.work.workId}:cancelled`]), theme);
	assert.match(rows[0]!.text, /^✓ Root release.*gate.*@2 \(rev 1×\)$/u);
	assert.match(rows[6]!.text, /– 2 cancelled\/superseded \[−\]/u);
	assert.deepEqual(rows.slice(1, 6).map((row) => row.text.trim()[0]), ["✓", "▶", "⧗", "✗", "○"]);
	assert.ok(rows.slice(1).every((row) => row.text.startsWith("  ") && !row.text.includes("\n")));
});

test("runtime and driver subscriptions request renders and are released on dispose", async () => {
	const { host, teamId } = fixture();
	let activity: (() => void) | undefined;
	let removed = 0;
	host.driver.onActivity = (listener) => { activity = () => listener(teamId); return () => { removed++; }; };
	const ui = overlay(host);
	const before = ui.renders();
	host.runtime.messageLead(teamId, "New review instruction");
	await Promise.resolve();
	assert.ok(ui.renders() > before);
	const changed = ui.renders();
	activity!();
	assert.equal(ui.renders(), changed + 1);
	ui.component.dispose(); ui.component.dispose();
	assert.equal(removed, 1);
	host.runtime.messageLead(teamId, "After dispose"); activity!();
	await Promise.resolve();
	assert.equal(ui.renders(), changed + 1);
});

test("all views and details fit widths 60–200 and respect a short terminal", (t) => {
	const { host } = fixture(6);
	const ui = overlay(host, { rows: 18 });
	t.after(() => ui.component.dispose());
	for (let view = 0; view < 5; view++) {
		for (const width of [60, 100, 120, 200]) {
			const lines = ui.component.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.length <= Math.floor(18 * 0.88));
			assert.ok(lines.at(-1)?.startsWith("╰"));
		}
		ui.key("tab");
	}
	ui.key("tab"); ui.key("tab"); ui.text(); ui.key("down"); ui.key("down"); ui.text(); ui.key("enter");
	assert.ok(ui.component.render(60).every((line) => visibleWidth(line) <= 60));
});

test("narrow member rows retain state and active time; long Unicode task titles retain result status", (t) => {
	const { host } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("tab");
	assert.match(ui.text(60), /held · asks:/u);
	assert.match(ui.text(60), /active \d+:\d\d · busy/u);
	const root: TeamWorkSummary = { work: { workId: "work:root", revision: 1 }, requester: "lead", assignee: "w1", state: "resolved", review: "accepted", taskPreview: "检查🧪".repeat(100), resultRef: "r1" };
	const colored = { ...theme, fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m` } as Theme;
	for (const width of [60, 120]) {
		const row = buildTeamTaskRows([root], new Set(), colored, width)[0]!;
		assert.ok(visibleWidth(row.text) <= width);
		assert.match(row.text, /resolved\/accepted\s*$/u);
	}
});

test("long Tasks lists keep selection visible; Timeline pages from newest to oldest", (t) => {
	const { host } = fixture(6);
	const ui = overlay(host, { rows: 14 });
	t.after(() => ui.component.dispose());
	ui.key("tab"); ui.key("tab"); ui.text();
	ui.key("down"); ui.key("down"); ui.text(); ui.key("right"); ui.text();
	for (let index = 0; index < 6; index++) { ui.key("down"); ui.text(); }
	assert.match(ui.text(), /→\s+○ Check child 6/u);
	assert.match(ui.text(), /↑ \d+ more/u);
	ui.key("tab");
	assert.match(ui.text(), /held ended work/u);
	assert.doesNotMatch(ui.text(), /0:00  launch/u);
	for (let index = 0; index < 20; index++) { ui.key("pageUp"); ui.text(); }
	assert.match(ui.text(), /0:00  launch/u);
	for (let index = 0; index < 20; index++) { ui.key("pageDown"); ui.text(); }
	assert.match(ui.text(), /held ended work/u);
});

test("Timeline shows retained omission notice and updates after runtime change", (t) => {
	const { host, teamId } = fixture();
	const original = host.runtime.panelFacts.bind(host.runtime);
	host.runtime.panelFacts = (id) => ({ ...original(id), timelineOmitted: 12 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("tab"); ui.key("tab"); ui.key("tab");
	assert.match(ui.text(), /… 12 earlier milestones omitted …/u);
	const hold = host.runtime.listHolds(teamId)[0]!;
	host.runtime.releaseHold(teamId, hold.work, hold.incidentId, "Use the approved requirements");
	assert.match(ui.text(), /host released the hold on work/u);
});

test("Team selector defaults to active, orders recent history last, and prevents history actions", (t) => {
	const { host } = fixture();
	host.runtime.prepare({ members: [{ alias: "other", roleDescription: "Manage." }, { alias: "worker", roleDescription: "Work." }], lead: "other", brief: { goal: "Prepared" }, timeoutSeconds: null });
	host.history.teams.push({ teamId: "old", version: 2, lifecycle: "interrupted", lead: "lead", members: ["lead", "worker"], results: [], finalResultRefs: [], at: 1 },
		{ teamId: "recent", version: 2, lifecycle: "closed", lead: "lead", members: ["lead", "worker"], goal: "Historic goal", results: [], finalResultRefs: [], at: 2 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	assert.match(ui.text(), /‹ 1\/4 ›/u);
	ui.component.handleInput("]"); ui.component.handleInput("]");
	assert.match(ui.text(), /Historic goal\s+│\n│ recent · CLOSED/u);
	ui.component.handleInput("c");
	assert.equal(ui.closed.length, 0);
	ui.component.handleInput("]");
	assert.match(ui.text(), /old · INTERRUPTED/u);
	ui.component.handleInput("["); ui.component.handleInput("["); ui.component.handleInput("[");
	assert.match(ui.text(), /‹ 1\/4 ›/u);
	assert.match(ui.text(), /ACTIVE/u);
});

test("ended Teams stay visible and read-only", (t) => {
	const { host, teamId } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	host.runtime.cancelTeam(teamId, "Done testing");
	assert.match(ui.text(), /id1 · CANCELLED/u);
	ui.component.handleInput("c");
	assert.match(ui.text(), /This Team is read-only\./u);
	assert.equal(ui.closed.length, 0);
});

for (const [key, action] of Object.entries({ c: "cancel", r: "resume", g: "grant", m: "message" })) {
	test(`action ${key} closes with ${action} without mutating the runtime`, () => {
		const { host, teamId } = fixture();
		const ui = overlay(host);
		ui.component.handleInput(key);
		assert.deepEqual(ui.closed, [{ teamId, action }]);
		assert.equal(host.runtime.getTeam(teamId).lifecycle, "active");
		ui.component.handleInput(key);
		assert.equal(ui.closed.length, 1);
	});
}

test("empty overlay closes with Escape", () => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
	const ui = overlay(host);
	assert.match(ui.text(), /No teams/u);
	ui.key("escape");
	assert.deepEqual(ui.closed, [undefined]);
});

function taggingTheme() {
	const calls: Array<{ color: string; text: string }> = [];
	const colors: Record<string, number> = { borderAccent: 201, border: 33, accent: 45, dim: 240, warning: 214, error: 196, muted: 245, toolTitle: 81, success: 82 };
	const tag = (color: string, text: string) => `\x1b[38;5;${colors[color]}m${text}\x1b[39m`;
	return { calls, tag, theme: { fg: (color: string, text: string) => { calls.push({ color, text }); return tag(color, text); }, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as Theme };
}

test("Rail Team frame, title, tabs, summary, and selection use Rail Agent theme roles", (t) => {
	const { host } = fixture();
	const tagged = taggingTheme();
	const ui = overlay(host, { theme: tagged.theme });
	t.after(() => ui.component.dispose());
	const lines = ui.component.render(200);
	assert.equal(lines[0], tagged.tag("borderAccent", `╭${"─".repeat(198)}╮`));
	assert.equal(lines.at(-1), tagged.tag("borderAccent", `╰${"─".repeat(198)}╯`));
	assert.ok(lines.slice(1, -1).every((line) => line.startsWith(tagged.tag("border", "│")) && line.endsWith(tagged.tag("border", "│"))));
	assert.ok(lines.slice(1, -1).every((line) => /^│[ →]/u.test(stripTerminalSequences(line))));
	assert.ok(tagged.calls.some(({ color, text }) => color === "accent" && text === "\x1b[1mRail Team\x1b[22m"));
	assert.ok(tagged.calls.some(({ color, text }) => color === "accent" && text === "[Overview]"));
	assert.ok(tagged.calls.some(({ color, text }) => color === "dim" && text === "Progress"));
	assert.match(stripTerminalSequences(lines[2]!), /Ship the local Team popup\./u);
	assert.match(stripTerminalSequences(lines[3]!), /id1 · ACTIVE · \d\d-\d\d \d\d:\d\d → now/u);
	assert.equal(stripTerminalSequences(lines[4]!).trim(), "│" + " ".repeat(198) + "│");
	ui.key("right");
	const members = ui.text(100);
	assert.match(stripTerminalSequences(members), /│ → ○ lead/u);
	assert.ok(tagged.calls.some(({ color, text }) => color === "accent" && text === " → "));
	assert.ok(tagged.calls.some(({ color, text }) => color === "muted" && text === "○"));
	for (const width of [60, 100, 200]) assert.ok(ui.component.render(width).every((line) => visibleWidth(line) === width));
});

test("summary omits zero activity counts and Teams rows show only eight ID characters", (t) => {
	let id = 0;
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [], { createId: () => `long-team-id-${++id}` });
	for (let index = 0; index < 2; index++) host.runtime.prepare({ members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "worker", roleDescription: "Work." }], lead: "lead", brief: { goal: "Test" }, timeoutSeconds: null });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	const lines = ui.component.render(100);
	assert.match(lines[1]!, /Rail Team\s+\[Teams\]\s+Overview\s+Progress/u);
	assert.match(lines[1]!, /‹ 1\/2 ›│$/u);
	assert.match(lines.join("\n"), /○ Test\s+│\n│\s+long-tea · PREPARED/u);
	assert.doesNotMatch(lines.join("\n"), /long-team-id/u);
	assert.match(lines[2]!, /2 Teams/u);
	assert.doesNotMatch(lines[2]!, /0 running|held|waiting/u);
});

test("Progress aligns alias/state, shows two-line active/usage rows and selected work/results", (t) => {
	const { host, runner, action, settle } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	const lines = ui.component.render(POPUP_WIDTH);
	const members = lines.filter((line) => /[○▶⧗⏸] (lead|runner|waiter|held)/u.test(line));
	assert.equal(members.length, 4);
	assert.equal(lines.filter((line) => /active \d+:\d\d · busy/u.test(line)).length, 4);
	const workerLines = members.slice(1);
	assert.equal(new Set(workerLines.map((line) => line.indexOf("running work") >= 0 ? line.indexOf("running work") : line.indexOf("waiting for") >= 0 ? line.indexOf("waiting for") : line.indexOf("held ·"))).size, 1);
	ui.key("down");
	assert.match(ui.text(POPUP_WIDTH), /runner · Implement the popup · from lead · work/u);
	settle(runner, action(runner, 1, { action: "reply", result: { status: "succeeded", summary: "Done" } }));
	assert.match(ui.text(POPUP_WIDTH), /Latest result: succeeded · "Done" · awaiting acceptance/u);
});

test("Tasks align title, assignee and state, with selected route, work ref and accounting", (t) => {
	const { host, teamId } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right");
	const lines = ui.component.render(POPUP_WIDTH);
	const rows = lines.map(stripTerminalSequences).filter((line) => /[▶⧗○⏸] (Implement|Review|Check)/u.test(line));
	assert.equal(rows.length, 3, "one row per deliverable; sub-tasks stay collapsed");
	assert.equal(new Set(rows.map((line) => line.search(/(?:runner|waiter|held)\s+(?:running|waiting|held:)/u))).size, 1, rows.join("\n"));
	ui.key("down"); ui.key("down"); ui.text(); ui.key("right"); ui.text(); ui.key("down");
	const child = host.runtime.listWorks(teamId).find((work) => work.parent)!;
	assert.ok(ui.text(POPUP_WIDTH).includes(`work ${child.work.workId.split(":")[1]}@1`));
	assert.match(ui.text(POPUP_WIDTH), /Check child 1 · waiter → runner/u);
	assert.match(ui.text(POPUP_WIDTH), /active \d+:\d\d · in 0 · out 0 · cache 0/u);
	ui.key("enter");
	assert.match(ui.text(POPUP_WIDTH), /Task: Check child 1/u);
	assert.match(ui.text(POPUP_WIDTH), /Lifecycle:/u);
});

test("Overview aligns labels and renders budget bars, small shares, warning/exhaustion, and unlimited", (t) => {
	const { host, teamId } = fixture();
	const budget = host.runtime.inspectBudget(teamId);
	Object.assign(budget.used, { teamActivations: 50, leadActivations: 80, teamModelRequests: 100, teamToolCalls: 156, teamWorks: 30 });
	Object.assign(budget.limits, { teamActivations: 100, leadActivations: 100, teamModelRequests: 100, teamToolCalls: 1_000_000_000, teamWorks: 4096 });
	host.runtime.inspectBudget = () => budget;
	const tagged = taggingTheme();
	const ui = overlay(host, { theme: tagged.theme });
	t.after(() => ui.component.dispose());
	const text = stripTerminalSequences(ui.text(100));
	assert.match(text, /activations\s+█{10}░{10}  50\/100 · 50%/u);
	assert.ok(tagged.calls.some(({ color, text }) => color === "warning" && text === "█".repeat(16)));
	assert.ok(tagged.calls.some(({ color, text }) => color === "error" && text === "█".repeat(20)));
	// 30 of 4096 is under one cell: still a visible sliver, not an empty bar.
	assert.match(text, /works\s+▏░{19}  30\/4096 · 0%/u);
	assert.match(text, /tool calls\s+156 · unlimited/u);
	assert.doesNotMatch(text.split("\n").find((line) => line.includes("156 · unlimited"))!, /[█░]/u);
	assert.ok(text.includes("│ → Goal      "));
	for (const label of ["Outcome", "Review", "Time", "Tokens", "Roots", "Waiting", "Attention", "Budget"]) {
		const line = text.split("\n").find((line) => line.startsWith(`│   ${label}`))!;
		assert.ok(line, label);
		assert.equal(line.slice(4, 14), label.padEnd(10), label);
		assert.notEqual(line[14], " ", `${label} value starts in the value column`);
	}
});

test("short terminals drop selected details before list rows in Members and Tasks", (t) => {
	const { host } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	assert.match(ui.text(100), /lead · Ship the local Team popup/u);
	ui.tui.terminal.rows = 18;
	assert.doesNotMatch(ui.text(100), /Latest result:/u);
	assert.ok(ui.component.render(100).filter((line) => /[○▶⧗⏸] (lead|runner|waiter|held)/u.test(line)).length >= 1);
	ui.key("right");
	assert.doesNotMatch(ui.text(100), /Task:|From:|resultRef:/u);
	assert.equal(ui.component.render(100).filter((line) => /[▶⧗○⏸] (Implement|Review|Check)/u.test(line)).length, 3);
	ui.tui.terminal.rows = 40;
	assert.match(ui.text(100), /Check requirements · lead → held/u);
});

test("Timeline cursor uses aligned time, pages, Home/End, and follows only at newest", (t) => {
	const { host } = fixture();
	const facts = host.runtime.panelFacts(host.runtime.listTeams()[0]!.teamId);
	facts.timeline = Array.from({ length: 20 }, (_, index) => ({ at: index * 60_000, text: `milestone ${index}` }));
	facts.timelineOmitted = 3;
	host.runtime.panelFacts = () => facts;
	const ui = overlay(host, { rows: 22 }); // A short terminal leaves ten Timeline rows.
	t.after(() => ui.component.dispose());
	ui.key("left"); ui.key("left");
	const cursor = () => ui.component.render(100).find((line) => line.startsWith("│ →"))!;
	assert.match(cursor(), /19:00  milestone 19/u);
	facts.timeline.push({ at: 20 * 60_000, text: "milestone 20" });
	assert.match(cursor(), /20:00  milestone 20/u);
	ui.key("up");
	assert.match(cursor(), /19:00  milestone 19/u);
	facts.timeline.push({ at: 21 * 60_000, text: "milestone 21" });
	assert.match(cursor(), /19:00  milestone 19/u);
	ui.key("pageUp");
	assert.match(cursor(), /9:00  milestone 9/u);
	ui.key("home");
	assert.match(cursor(), /0:00  milestone 0/u);
	assert.match(ui.text(100), /… 3 earlier milestones omitted …/u);
	const first = cursor().indexOf("milestone");
	ui.key("down");
	assert.match(cursor(), /1:00  milestone 1/u);
	ui.key("pageDown");
	assert.match(cursor(), /11:00  milestone 11/u);
	ui.key("down");
	assert.equal(cursor().indexOf("milestone"), first);
	// Dropping older retained entries must not move a cursor to a different milestone.
	facts.timeline.splice(1, 2);
	facts.timelineOmitted += 2;
	assert.match(cursor(), /12:00  milestone 12/u);
	ui.key("end");
	assert.match(cursor(), /21:00  milestone 21/u);
	facts.timeline.push({ at: 22 * 60_000, text: "milestone 22" });
	assert.match(cursor(), /22:00  milestone 22/u);
});

test("arrows switch views, brackets switch Teams, and configurable select keys are honored", (t) => {
	const { host } = fixture();
	host.history.teams.push({ teamId: "history", version: 2, lifecycle: "closed", members: [], results: [], finalResultRefs: [], at: 1 });
	const ui = overlay(host, { bindings: { "tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "e", "tui.select.cancel": "q" } });
	t.after(() => ui.component.dispose());
	ui.key("right");
	assert.match(ui.text(), /\[Progress\]/u);
	assert.match(ui.text(), /‹ 1\/2 ›/u);
	ui.component.handleInput("j");
	assert.match(ui.text(), /→ ▶ runner/u);
	ui.component.handleInput("e");
	assert.match(ui.text(), /Member runner · Esc back/u);
	ui.component.handleInput("q");
	assert.doesNotMatch(ui.text(), /Member runner · Esc back/u);
	ui.component.handleInput("j"); ui.text(); ui.component.handleInput("k");
	assert.match(ui.text(), /→ ○ lead/u);
	ui.key("left");
	assert.match(ui.text(), /\[Overview\]/u);
	ui.key("backTab");
	assert.match(ui.text(), /\[Teams\]/u);
	ui.key("backTab");
	assert.match(ui.text(), /\[Timeline\]/u);
	ui.key("tab"); ui.key("tab");
	assert.match(ui.text(), /\[Overview\]/u);
	ui.component.handleInput("]");
	assert.match(ui.text(), /‹ 2\/2 ›/u);
	assert.match(ui.text(), /\[Overview\]/u);
	ui.component.handleInput("[");
	assert.match(ui.text(), /‹ 1\/2 ›/u);
	ui.component.handleInput("q");
	assert.match(ui.text(), /\[Teams\]/u);
	assert.deepEqual(ui.closed, []);
	ui.component.handleInput("q");
	assert.deepEqual(ui.closed, [undefined]);
});

test("Members state shows lifecycle, error and pause instead of idle", (t) => {
	const { host } = fixture();
	const original = host.runtime.listTeams.bind(host.runtime);
	host.runtime.listTeams = () => original().map((team) => ({ ...team, members: team.members.map((member) =>
		member.id === "runner" ? { ...member, lifecycle: "faulted" as const, activity: "idle" as const, currentWork: undefined, error: { code: "model_error", message: "Provider failed" } }
			: member.id === "waiter" ? { ...member, lifecycle: "closed" as const, activity: "idle" as const, currentWork: undefined }
				: member) })) as ReturnType<typeof original>;
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	const text = ui.text();
	assert.match(text, /✗ runner\s+faulted · .*model_error: Provider failed/u);
	assert.match(text, /✓ waiter\s+closed/u);
	assert.doesNotMatch(text, /(runner|waiter)\s+idle/u);
});

test("Timeline is a fixed 12-row pane even on a tall terminal", (t) => {
	const { host } = fixture();
	const facts = host.runtime.panelFacts(host.runtime.listTeams()[0]!.teamId);
	facts.timeline = Array.from({ length: 40 }, (_, index) => ({ at: index * 1000, text: `milestone ${index}` }));
	host.runtime.panelFacts = () => facts;
	const ui = overlay(host, { rows: 40 });
	t.after(() => ui.component.dispose());
	ui.key("left"); ui.key("left");
	const shown = () => ui.component.render(100).filter((line) => /milestone \d+/u.test(line)).length;
	const page = shown();
	assert.equal(page, 12);
	ui.key("pageUp");
	assert.match(ui.component.render(100).find((line) => line.startsWith("│ →"))!, new RegExp(`milestone ${39 - page}\\b`, "u"));
});

test("in an overflowing Overview one Down press scrolls to the next field and PageDown/PageUp reach the facts", (t) => {
	const { host } = fixture();
	const ui = overlay(host, { rows: 14 });
	t.after(() => ui.component.dispose());
	const first = () => ui.text().split("\n")[5]!;
	assert.match(first(), /→ Goal/u);
	ui.key("down");
	assert.match(first(), /→ Outcome/u);
	ui.key("end"); ui.text();
	assert.doesNotMatch(first(), /Outcome/u);
	const end = first();
	ui.key("pageDown");
	assert.equal(first(), end);
	ui.key("pageUp");
	assert.notEqual(first(), end);
});

function reviewRecord(id: string, minutes: number, verdict: TeamReviewRecord["verdict"] | undefined, extra: Partial<TeamReviewRecord> = {}): TeamReviewRecord {
	const label = verdict ? verdict.replace("_", " ").toUpperCase() : undefined;
	return { id: `review:${id}`, at: 1_700_000_000_000 + minutes * 60_000, by: "waiter", work: { workId: `work:r${id}`, revision: 1 }, resultRef: `result:r${id}`, status: "succeeded",
		...(verdict ? { verdict } : {}), summary: `${label ? `${label}: ` : ""}Review ${id} summary.`,
		snapshot: { elapsedMs: minutes * 60_000, works: { total: 4, resolved: 0, running: 1, blocked: 1, held: 1, failed: 0, cancelled: 0 }, finishedSinceLast: 1,
			budget: [{ counter: "teamActivations", used: 5, limit: 100 }, { counter: "teamToolCalls", used: 9, limit: 1_000_000_000 }] }, ...extra };
}

function withReviews(host: TeamSessionHost, teamId: string, reviews: TeamReviewRecord[], nextAt: number | null = null) {
	host.runtime.listReviews = () => reviews;
	host.runtime.reviewSchedule = () => ({ by: "waiter", everyMinutes: 5, nextAt });
	return teamId;
}

test("Overview opens reviews newest first with schedule and verdict colours", (t) => {
	const { host, teamId, now } = fixture();
	withReviews(host, teamId, [reviewRecord("a1", 5, "on_track"), reviewRecord("b2", 10, "at_risk"), reviewRecord("c3", 15, "off_track"), reviewRecord("d4", 20, undefined, { summary: "Plain note." })], now() + 150_000);
	const tagged = taggingTheme();
	const ui = overlay(host, { theme: tagged.theme, now });
	t.after(() => ui.component.dispose());
	assert.match(stripTerminalSequences(ui.text(POPUP_WIDTH)), /4 reviews · 2 at risk · next in 3m/u);
	ui.key("down"); ui.key("down"); ui.key("enter");
	const text = stripTerminalSequences(ui.text(POPUP_WIDTH));
	assert.match(text, /\[Overview\]/u);
	assert.match(text, /Reviews · 4 · waiter every 5 min · next in 3m/u);
	assert.doesNotMatch(text, /Budget\s+activations|█/u, "the Overview's budget bars are not repeated here");
	const rows = text.split("\n").filter((line) => /\d+:\d\d  waiter  /u.test(line)).map((line) => line.replace(/^│\s+(→\s)?/u, "").replace(/\s*│$/u, ""));
	assert.deepEqual(rows.map((row) => row.replace(/\s+/gu, " ")), ["20:00 waiter no verdict Plain note.", "15:00 waiter off track Review c3 summary.", "10:00 waiter at risk Review b2 summary.", "5:00 waiter on track Review a1 summary."]);
	for (const [color, label] of [["success", "on track"], ["warning", "at risk"], ["error", "off track"], ["muted", "no verdict"]]) {
		assert.ok(tagged.calls.some((call) => call.color === color && call.text.trim() === label), label);
	}
});

test("Overview review sub-page selection shows summary/snapshot and Enter opens the full review", (t) => {
	const { host, teamId } = fixture();
	withReviews(host, teamId, [reviewRecord("a1", 5, "on_track"), reviewRecord("b2", 10, "at_risk", {
		summary: "AT RISK: Two works wait.\nSecond summary line.", findings: ["held work blocks the lead", "no result for runner"], limitations: ["no tool output inspected"] })]);
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.text(); ui.key("down"); ui.key("down"); ui.key("enter"); ui.text();
	assert.match(ui.text(POPUP_WIDTH), /→\s+10:00  waiter  at risk\s+Two works wait\./u);
	assert.match(ui.text(POPUP_WIDTH), /10:00 · waiter · at risk/u);
	assert.match(ui.text(POPUP_WIDTH), /Summary: Two works wait\./u);
	assert.match(ui.text(POPUP_WIDTH), /Snapshot: works 0\/4 resolved · 1 running · 1 held · 0 failed/u);
	ui.key("down");
	assert.match(ui.text(POPUP_WIDTH), /5:00 · waiter · on track/u);
	ui.key("up"); ui.key("enter");
	const detail = ui.text(100);
	assert.match(detail, /Review review:b2 · Esc back/u);
	assert.match(detail, /By: waiter · at risk · work:rb2@1 succeeded · result:rb2/u);
	assert.match(detail, /Second summary line\./u);
	assert.match(detail, /- held work blocks the lead/u);
	assert.match(detail, /Budget: teamActivations 5\/100 · teamToolCalls 9\/unlimited/u);
	assert.doesNotMatch(detail, /Review: waiter every/u);
	ui.key("escape");
	assert.match(ui.text(POPUP_WIDTH), /Reviews · 2 · waiter every 5 min/u);
	assert.match(ui.text(POPUP_WIDTH), /→\s+10:00  waiter  at risk/u);
	ui.key("escape");
	assert.match(ui.text(POPUP_WIDTH), /→ Review\s+10:00 waiter AT RISK · Two works wait\./u, "the cursor returns to the Review field");
	assert.doesNotMatch(ui.text(POPUP_WIDTH), /Reviews · 2/u);
});

test("Overview Review off still opens an empty review sub-page", (t) => {
	const { host, teamId } = fixture();
	host.runtime.setReview(teamId, null);
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.text(); ui.key("down"); ui.key("down");
	assert.match(ui.text(POPUP_WIDTH), /→ Review\s+off/u);
	ui.key("enter");
	const text = ui.text(POPUP_WIDTH);
	assert.match(text, /Reviews · 0 · off/u);
	assert.match(text, /No reviews yet/u);
	assert.doesNotMatch(text, /│ →/u);
	ui.key("enter"); ui.key("down");
	assert.doesNotMatch(ui.text(POPUP_WIDTH), /Esc back/u);
});

test("closed Teams from history show their recorded reviews and schedule", (t) => {
	const { host } = fixture();
	host.history.teams.push({ teamId: "old", version: 2, lifecycle: "closed", lead: "lead", members: ["lead", "waiter"], results: [], finalResultRefs: [], at: 1,
		review: { by: "waiter", everyMinutes: 10 }, reviews: [reviewRecord("h1", 10, "on_track"), reviewRecord("h2", 20, "off_track")] },
		{ teamId: "bare", version: 2, lifecycle: "closed", lead: "lead", members: ["lead"], results: [], finalResultRefs: [], at: 0 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.component.handleInput("]"); ui.text(); ui.key("down"); ui.key("enter");
	let text = ui.text(POPUP_WIDTH);
	assert.match(text, /‹ 2\/3 ›/u);
	assert.match(text, /Reviews · 2 · waiter every 10 min/u);
	assert.doesNotMatch(text, /next in|Elapsed|Budget {2}/u);
	assert.match(text, /→\s+20:00  waiter  off track\s+Review h2 summary\./u);
	assert.match(text, /10:00  waiter  on track/u);
	ui.key("enter");
	assert.match(ui.text(100), /Review review:h2 · Esc back/u);
	ui.key("escape"); ui.key("escape");
	ui.component.handleInput("]"); ui.text(); ui.key("down"); ui.key("enter");
	text = ui.text(POPUP_WIDTH);
	assert.match(text, /Reviews · 0 · off/u);
	assert.match(text, /No reviews yet/u);
	ui.key("escape");
	assert.match(ui.text(POPUP_WIDTH), /not retained\s+│\n│ bare · CLOSED/u);
});

test("review sub-page fits widths 60/80/120 and short terminals", () => {
	const { host, teamId } = fixture();
	const long = "x".repeat(300);
	withReviews(host, teamId, Array.from({ length: 12 }, (_, index) => reviewRecord(String(index), index * 7, (["on_track", "at_risk", "off_track", undefined] as const)[index % 4], { by: index % 2 ? "a-very-long-reviewer-alias" : "waiter", summary: `AT RISK: ${long}`, findings: [long], limitations: [long] })), Date.now() + 60_000);
	for (const rows of [40, 18, 14]) {
		const ui = overlay(host, { rows });
		ui.text(); ui.key("down"); ui.key("down"); ui.key("enter");
		for (const width of [60, 80, 120]) {
			for (let step = 0; step < 3; step++) {
				const lines = ui.component.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) === width), `${rows}x${width}`);
				assert.ok(lines.length <= Math.floor(rows * 0.88), `${rows}x${width}: ${lines.length}`);
				// Below 100 columns the wrapped help rows take the room the snapshot block yields to the list.
				if (rows >= 18 && width >= 100) assert.match(lines.join("\n"), /Reviews · 12 · waiter every 5 min/u);
				ui.key("down");
			}
			ui.key("home");
		}
		ui.key("enter");
		for (const width of [60, 80, 120]) assert.ok(ui.component.render(width).every((line) => visibleWidth(line) === width));
		ui.component.dispose();
	}
});

test("review works do not count in the Overview progress", (t) => {
	const { host } = fixture();
	const original = host.runtime.listWorks.bind(host.runtime);
	host.runtime.listWorks = (id) => [...original(id), { work: { workId: "work:review", revision: 1 }, requester: "lead", assignee: "waiter", state: "queued", taskPreview: "Team progress review", kind: "review" }];
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	assert.match(ui.text(), /Roots\s+0\/3 accepted · 0 waived/u);
});

/** The popup is 92% of the terminal: 73 columns at 80. */
const POPUP_WIDTH = 73;

test("Teams is the first view; Enter opens the selected Team and Escape returns before closing", (t) => {
	const { host } = fixture();
	host.history.teams.push({ teamId: "history", version: 2, lifecycle: "closed", members: ["lead", "worker"], goal: "Past work", results: [], finalResultRefs: [], at: 1 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	assert.match(ui.text(POPUP_WIDTH), /\[Overview\]/u, "the active Team starts in Overview");
	ui.key("escape");
	let lines = ui.component.render(POPUP_WIDTH);
	assert.match(lines.join("\n"), /\[Teams\]/u);
	assert.deepEqual(ui.closed, []);
	assert.match(lines.join("\n"), /↑↓ select · enter open · n rename · space mark · d delete · esc close/u);
	assert.ok(lines.findIndex((line) => line.includes("▶ Ship the")) < lines.findIndex((line) => line.includes("✓ Past work")));
	ui.key("down"); ui.text(); ui.key("enter");
	assert.match(ui.text(POPUP_WIDTH), /Past work\s+│\n│ history · CLOSED/u);
	assert.match(ui.text(POPUP_WIDTH), /Goal\s+Past work/u);
	ui.key("escape");
	lines = ui.component.render(POPUP_WIDTH);
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
	ui.key("escape");
	assert.deepEqual(ui.closed, [undefined]);
});

test("every selected tab stays visible beside the Team selector at popup width", (t) => {
	const { host } = fixture();
	host.history.teams.push({ teamId: "history", version: 2, lifecycle: "closed", members: [], results: [], finalResultRefs: [], at: 1 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	for (const tab of ["Overview", "Progress", "Tasks", "Timeline", "Teams"]) {
		const lines = ui.component.render(POPUP_WIDTH);
		assert.ok(stripTerminalSequences(lines[1]!).includes(`[${tab}]`));
		assert.match(stripTerminalSequences(lines[1]!), /‹ 1\/2 ›/u);
		for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
		ui.key("tab");
	}
});

test("without an active Team multiple Teams start in Teams, but one Team starts in Overview", (t) => {
	for (const count of [1, 2]) {
		const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
		for (let index = 0; index < count; index++) host.history.teams.push({ teamId: `history${index}`, version: 2, lifecycle: "closed", members: [], goal: "Historical work", results: [], finalResultRefs: [], at: index });
		const ui = overlay(host);
		t.after(() => ui.component.dispose());
		assert.match(ui.text(POPUP_WIDTH), count === 1 ? /\[Overview\]/u : /\[Teams\]/u);
		if (count === 2) {
			const rows = ui.component.render(POPUP_WIDTH);
			assert.ok(rows.findIndex((line) => /history1 · CLOSED/u.test(line)) < rows.findIndex((line) => /history0 · CLOSED/u.test(line)));
		}
	}
});

test("space marks only the selected Teams row and brackets move the Teams cursor", (t) => {
	const { host, teamId } = fixture();
	host.history.teams.push({ teamId: "history", version: 2, lifecycle: "interrupted", members: [], results: [], finalResultRefs: [], at: 1 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("escape"); ui.text();
	ui.component.handleInput(" ");
	assert.match(ui.text(POPUP_WIDTH), new RegExp(`→ \\* Ship the local Team popup\\.\\s+│\\n│\\s+${teamId} · ACTIVE`, "u"));
	ui.component.handleInput("]"); ui.text();
	assert.match(ui.text(POPUP_WIDTH), /→ ✗ not retained\s+│\n│\s+history · INTERRUPTED/u);
	ui.component.handleInput(" ");
	assert.match(ui.text(POPUP_WIDTH), /→ \* not retained\s+│\n│\s+history · INTERRUPTED/u);
	ui.component.handleInput(" ");
	assert.match(ui.text(POPUP_WIDTH), /→ ✗ not retained\s+│\n│\s+history · INTERRUPTED/u);
});

test("Teams rows are two lines at 73 columns: outcome icon and full-width title, then id, state, duration, start, members and roots; no details block", (t) => {
	const { host, teamId } = fixture();
	const title = "长".repeat(60);
	host.history.teams.push({ teamId: "historic", version: 2, lifecycle: "interrupted", members: ["one"], title, goal: "History goal", results: [], finalResultRefs: [], at: 1 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("escape");
	const lines = ui.component.render(POPUP_WIDTH).map(stripTerminalSequences);
	for (const line of ui.component.render(POPUP_WIDTH)) assert.equal(visibleWidth(line), POPUP_WIDTH);
	const first = lines.findIndex((line) => line.includes("Ship the local Team popup."));
	assert.match(lines[first]!, /^│ → ▶ Ship the local Team popup\./u);
	assert.match(lines[first + 1]!, new RegExp(`^│ {7}${teamId} · ACTIVE · \\d+:\\d\\d · \\d\\d-\\d\\d \\d\\d:\\d\\d · 4 members · roots 0/3 +│$`, "u"));
	assert.match(lines[first + 2]!, /^│ {3}✗ 长+… ?│$/u, "the title takes the full width and ends in …");
	assert.match(lines[first + 3]!, /^│ {7}historic · INTERRUPTED · — · — · 1 members · roots — +│$/u);
	assert.doesNotMatch(lines.join("\n"), /History goal|accepted/u, "no details block under the list");
});

test("Teams outcome icons: ✓ succeeded, ⚠ partial, ✗ failed/cancelled/interrupted, ▶ active, ○ prepared", (t) => {
	const { host } = fixture();
	const base = { version: 2 as const, members: ["one"], results: [], finalResultRefs: [] };
	const history: TeamHistoryEntry[] = [{ ...base, teamId: "h-ok", lifecycle: "closed", outcome: "succeeded", at: 6 }, { ...base, teamId: "h-part", lifecycle: "closed", outcome: "partial", at: 5 },
		{ ...base, teamId: "h-fail", lifecycle: "closed", outcome: "failed", at: 4 }, { ...base, teamId: "h-canc", lifecycle: "cancelled", at: 3 }, { ...base, teamId: "h-intr", lifecycle: "interrupted", at: 2 },
		{ ...base, teamId: "h-old", lifecycle: "completed", at: 1 }];
	host.history.teams.push(...history);
	host.runtime.prepare({ members: [{ alias: "a", roleDescription: "A." }, { alias: "b", roleDescription: "B." }], lead: "a", brief: { goal: "Prepared one." }, timeoutSeconds: null });
	const tagged = taggingTheme();
	const ui = overlay(host, { theme: tagged.theme });
	t.after(() => ui.component.dispose());
	ui.key("escape");
	const lines = ui.component.render(POPUP_WIDTH).map(stripTerminalSequences);
	const icon = (id: string) => lines[lines.findIndex((line) => line.includes(`${id} ·`)) - 1]!.charAt(4);
	assert.deepEqual(["h-ok", "h-part", "h-fail", "h-canc", "h-intr", "h-old"].map(icon), ["✓", "⚠", "✗", "✗", "✗", "✓"]);
	assert.equal(icon("id1"), "▶");
	assert.equal(lines[lines.findIndex((line) => line.includes("Prepared one."))]!.charAt(4), "○");
	for (const [color, glyph] of [["accent", "▶"], ["success", "✓"], ["warning", "⚠"], ["error", "✗"], ["muted", "○"]]) assert.ok(tagged.calls.some((call) => call.color === color && call.text === glyph), glyph);
});

test("d deletes marked Teams in list order, the cursor without marks, or the viewed Team on another tab", () => {
	const { host, teamId } = fixture();
	host.history.teams.push({ teamId: "history", version: 2, lifecycle: "closed", members: [], results: [], finalResultRefs: [], at: 1 });
	const marked = overlay(host);
	marked.key("escape"); marked.text(); marked.component.handleInput(" ");
	marked.key("down"); marked.text(); marked.component.handleInput(" ");
	marked.component.handleInput("d");
	assert.deepEqual(marked.closed, [{ action: "delete", teamIds: [teamId, "history"] }]);
	assert.equal(host.runtime.getTeam(teamId).lifecycle, "active", "deletion is delegated to the command's confirmation and eligibility checks");
	marked.component.handleInput("d");
	assert.equal(marked.closed.length, 1);
	const cursor = overlay(host);
	cursor.key("escape"); cursor.text(); cursor.key("down"); cursor.text(); cursor.component.handleInput("d");
	assert.deepEqual(cursor.closed, [{ action: "delete", teamIds: ["history"] }]);
	const viewed = overlay(host);
	viewed.component.handleInput("]"); viewed.text(); viewed.component.handleInput("d");
	assert.deepEqual(viewed.closed, [{ action: "delete", teamIds: ["history"] }]);
	const unmarked = overlay(host);
	unmarked.key("escape"); unmarked.text(); unmarked.component.handleInput(" "); unmarked.component.handleInput(" ");
	unmarked.key("down"); unmarked.text(); unmarked.component.handleInput("d");
	assert.deepEqual(unmarked.closed, [{ action: "delete", teamIds: ["history"] }]);
});

test("history Overview and Teams rows show terminal tokens, flow, roots and start/end duration; old journals still render", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
	const entry: TeamHistoryEntry = { teamId: "historic", version: 2, lifecycle: "closed", outcome: "succeeded", members: ["lead", "worker"], goal: "Historic goal", results: [], finalResultRefs: [],
		startedAt: 1_700_000_000_000, at: 1_700_000_300_000, usage: { input: 123, output: 45, cacheRead: 67, cacheWrite: 89, turns: 2, cost: 0, contextTokens: 0 },
		flow: "workers avg 1.2 · only lead 25%", rootCounts: { accepted: 2, waived: 1, total: 3 } };
	host.history.teams.push(entry);
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	let lines = ui.component.render(POPUP_WIDTH);
	assert.match(lines.join("\n"), /historic · CLOSED ok · \d\d-\d\d \d\d:\d\d → \d\d:\d\d/u);
	assert.match(lines.join("\n"), /Time\s+5:00/u);
	assert.match(lines.join("\n"), /Tokens\s+in 123 · out 45 · cache 67\/89/u);
	assert.match(lines.join("\n"), /Roots\s+2\/3 accepted · 1 waived/u);
	ui.key("right");
	assert.match(ui.text(POPUP_WIDTH), /workers avg 1\.2 · only lead 25%/u);
	ui.key("escape");
	lines = ui.component.render(POPUP_WIDTH);
	assert.match(lines.join("\n"), /✓ Historic goal\s+│\n│\s+historic · CLOSED ok · 5:00 · \d\d-\d\d \d\d:\d\d · roots 2\/3/u);
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
	host.history.teams.push({ teamId: "legacy", version: 1, lifecycle: "completed", members: [], results: [], finalResultRefs: [], at: 1 });
	ui.component.handleInput("]"); ui.text(); ui.key("enter");
	assert.match(ui.text(POPUP_WIDTH), /legacy · COMPLETED/u);
	assert.doesNotMatch(ui.text(POPUP_WIDTH), /│   (Time|Tokens|Roots) |Goal/u, "fields that are not retained are omitted");
});

test("history Members cache verified saved-session models/sizes, final lifecycles and result counts, while absent or reused aliases show session deleted", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "team-history-members-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const instance = (alias: string): AgentInstance => ({ version: 2, agentId: alias, alias, model: { provider: "local", modelId: "fake" }, sessionId: alias,
		sessionFile: join(dir, `${alias}.jsonl`), cwd: dir, createdAt: "2023-11-14T00:00:00Z", updatedAt: "2023-11-14T00:00:00Z", lastTask: "Team work" });
	const saved = [instance("lead"), instance("reused")];
	writeFileSync(saved[0]!.sessionFile, "history session contents");
	writeFileSync(saved[1]!.sessionFile, "an unrelated Team session");
	let lookups = 0;
	const host = new TeamSessionHost({ listSaved: async () => { lookups++; return saved; } } as SessionBroker, () => undefined, []);
	host.history.teams.push({ teamId: "history", version: 2, lifecycle: "closed", members: ["lead", "gone", "reused"], results: [{ id: "result:a", author: "lead", work: { workId: "work:a", revision: 1 }, result: { status: "succeeded", summary: "Done" }, committedAt: 1, source: "explicit_reply" }],
		finalResultRefs: [], memberStates: [{ id: "lead", lifecycle: "closed", resourceState: "released" }, { id: "gone", lifecycle: "faulted", resourceState: "released" }, { id: "reused", lifecycle: "closed", resourceState: "released" }], at: 1 });
	const original = host.memberSessions.bind(host);
	let loaded: ReturnType<TeamSessionHost["memberSessions"]> | undefined;
	host.memberSessions = (teamId, aliases) => loaded = original(teamId, aliases);
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	assert.match(ui.text(POPUP_WIDTH), /checking session/u);
	const before = ui.renders();
	await loaded; await Promise.resolve();
	let text = ui.text(POPUP_WIDTH);
	assert.match(text, /lead · closed · 1 results · local\/fake · 24 B/u);
	ui.key("down"); text = ui.text(POPUP_WIDTH);
	assert.match(text, /gone · faulted · 0 results · session deleted/u);
	ui.key("down"); text = ui.text(POPUP_WIDTH);
	assert.match(text, /reused · closed · 0 results · session deleted/u);
	assert.ok(ui.renders() > before, "the lookup completion refreshes the popup");
	assert.equal(lookups, 1, "subsequent renders reuse the resolved sessions");
	delete host.history.teams[0]!.memberStates;
	assert.match(ui.text(POPUP_WIDTH), /activity not retained/u, "old member snapshots need no lifecycle field");
	for (const line of ui.component.render(POPUP_WIDTH)) assert.equal(visibleWidth(line), POPUP_WIDTH);
});
/** The action keys wrapped by whole keys at the popup width. */
const ACTION_HELP = ["p pause · c cancel · r resume hold · g grant · m message · v revive", "l new lead · z compact · t compact at 80% · d delete"];
/** The text of each popup row, without the frame and its leading space. */
const rowsOf = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).slice(2, -1).trimEnd());
/** The help rows: everything between the last blank row and the bottom border, without the lead-decision notice above them. */
const helpOf = (lines: string[]) => {
	const rows = rowsOf(lines).slice(0, -1);
	return rows.slice(rows.lastIndexOf("") + 1).filter((row) => !row.startsWith("Waiting for:"));
};

test("Overview shows title/short ID, and action keys fit whole help rows at 73 columns", (t) => {
	const { host, teamId } = fixture();
	host.runtime.prepare({ members: [{ alias: "a", roleDescription: "A." }, { alias: "b", roleDescription: "B." }], lead: "a", brief: { goal: "Second Team." }, timeoutSeconds: null });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	const lines = ui.component.render(POPUP_WIDTH);
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
	assert.match(stripTerminalSequences(lines.join("\n")), new RegExp(`Ship the local Team popup\\.\\s+│\\n│ ${teamId} · ACTIVE`, "u"));
	assert.deepEqual(helpOf(lines), ["↑↓ select · enter open · n rename · ←→/tab views · esc teams", ...ACTION_HELP],
		"navigation and the actions on whole rows, no key cut");
	for (const row of ACTION_HELP) assert.ok(row.length <= POPUP_WIDTH - 3, row);
	// Wider hints wrap instead of being cut, and stay dim.
	const tagged = taggingTheme();
	for (const [tab, navigation] of [[1, "↑↓ select · enter details · z compact · ←→/tab views · esc teams"], [3, "↑↓ cursor · pgup/dn page · home/end · ←→/tab views · esc teams"]] as const) {
		const popup = overlay(host, { theme: tagged.theme });
		for (let index = 0; index < tab; index++) popup.component.handleInput("\t");
		tagged.calls.length = 0;
		const rendered = popup.component.render(POPUP_WIDTH);
		const help = helpOf(rendered);
		assert.equal(help.join(" "), navigation, `tab ${tab}: the navigation hint is whole`);
		for (const row of help) assert.ok(tagged.calls.some((call) => call.color === "dim" && call.text === row), `dim: ${row}`);
		for (const line of rendered) assert.equal(visibleWidth(line), POPUP_WIDTH);
		popup.component.dispose();
	}
	for (const [key, action] of [["v", "revive"], ["l", "lead"]] as const) {
		const popup = overlay(host);
		popup.component.handleInput(key);
		assert.deepEqual(popup.closed, [{ teamId, action }]);
	}
});

test("a paused Team shows PAUSED in the Overview header and Waiting; p pauses a running Team and continues a paused one; the help row stays whole at 73 columns", (t) => {
	const { host, teamId } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	assert.doesNotMatch(ui.text(), /PAUSED/u);
	assert.deepEqual(helpOf(ui.component.render(POPUP_WIDTH)).slice(-2), ACTION_HELP);
	ui.component.handleInput("p");
	assert.deepEqual(ui.closed, [{ teamId, action: "pause" }]);

	host.runtime.pauseTeam(teamId);
	const paused = overlay(host);
	t.after(() => paused.component.dispose());
	assert.match(paused.text(), /id1 · ACTIVE · PAUSED · \d\d-\d\d \d\d:\d\d → now/u);
	assert.match(paused.text(), /Waiting\s+Paused by the host/u);
	const lines = paused.component.render(POPUP_WIDTH);
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
	assert.deepEqual(helpOf(lines).slice(-2), ["p continue · c cancel · r resume hold · g grant · m message · v revive", "l new lead · z compact · t compact at 80% · d delete"]);
	paused.component.handleInput("p");
	assert.deepEqual(paused.closed, [{ teamId, action: "continue" }]);
	host.runtime.cancelTeam(teamId, "done");
	const ended = overlay(host);
	t.after(() => ended.component.dispose());
	ended.component.handleInput("p");
	assert.equal(ended.closed.length, 0, "an ended Team is read-only");
});

const FLOW_STATS: TeamFlowStats = {
	slotLimit: 4, activeMs: 42 * 60_000, workersAvg: 1.6, workersRecent: 2.3, allSlotsShare: 0.06, leadBusyShare: 0.41, onlyLeadShare: 0.18,
	startP50: 0, startP90: 72_000, queued: { count: 2, oldestMs: 180_000, reason: "slots full" }, waitP50: 40_000, waitP90: 360_000,
	waited: [{ member: "fix-test", count: 9, ms: 42 * 60_000 }, { member: "fix-scroll", count: 4, ms: 10 * 60_000 }], acceptP50: 50_000, acceptP90: 180_000,
	pendingEvents: 2, tokensPerWork: 1_100_000, context: { member: "reviewer", tokens: 151_000 }, warn: { lead: false, queue: false, waits: false, cost: false },
};

test("Progress shows Σ Team and lead shares without always-on flow rows, legend or budget", (t) => {
	const { host, teamId } = fixture();
	host.runtime.flowStats = () => FLOW_STATS;
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	const lines = ui.component.render(POPUP_WIDTH);
	assert.match(lines.join("\n"), /Σ Team 42:00 · 1 running · 1 waiting · 1 idle · workers avg 1.6/u);
	assert.match(lines.join("\n"), /in 0 · out 0 · cache 0 · lead busy 41% · only lead 18%/u);
	assert.doesNotMatch(lines.join("\n"), /Budget|Warn:|⚠|Flow|Queue|Waits|Cost/u);
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
	const budget = host.runtime.inspectBudget(teamId);
	Object.assign(budget.used, { teamModelRequests: 85 });
	Object.assign(budget.limits, { teamModelRequests: 100 });
	host.runtime.inspectBudget = () => budget;
	assert.doesNotMatch(ui.text(POPUP_WIDTH), /Budget|░/u);
});

test("a crossed flow threshold colors only its row warning", (t) => {
	const { host } = fixture();
	const tagged = taggingTheme();
	const ui = overlay(host, { theme: tagged.theme });
	t.after(() => ui.component.dispose());
	ui.key("right");
	const colored = (stats: TeamFlowStats) => {
		host.runtime.flowStats = () => stats;
		tagged.calls.length = 0;
		ui.text(120);
		return tagged.calls.filter((call) => call.color === "warning" && /^⚠ (Queue|Waits|Lead|Cost) /u.test(call.text)).map((call) => call.text.split(" ")[1]);
	};
	assert.deepEqual(colored(FLOW_STATS), []);
	assert.deepEqual(colored({ ...FLOW_STATS, warn: { lead: true, queue: true, waits: true, cost: true } }), ["Lead", "Queue", "Waits", "Cost"], "the Flow row has no threshold");
	assert.deepEqual(colored({ ...FLOW_STATS, warn: { ...FLOW_STATS.warn, lead: true } }), ["Lead"], "the Lead row carries the only-lead warning");
	assert.deepEqual(colored({ ...FLOW_STATS, warn: { ...FLOW_STATS.warn, waits: true } }), ["Waits"]);
	assert.ok(!tagged.calls.some((call) => call.text.startsWith("Warn:")), "the legend is removed");
});

test("before launch Progress shows zero time/usage and unknown worker/lead shares", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [], { createId: () => "x" });
	host.runtime.prepare({ members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w", roleDescription: "Work." }], lead: "lead", brief: { goal: "Idle." }, timeoutSeconds: null });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	const text = stripTerminalSequences(ui.text(120));
	assert.match(text, /Σ Team 0:00.*workers avg —/u);
	assert.match(text, /in 0 · out 0 · cache 0 · lead busy — · only lead —/u);
	assert.match(text, /active 0:00 · busy 0% · in 0 · out 0 · cache 0/u);
	assert.doesNotMatch(text, /⚠|Warn:/u);
});

test("a history Team shows its stored flow summary, and omits the flow rows without one", (t) => {
	const { host } = fixture();
	const base = { version: 2 as const, lifecycle: "closed" as const, lead: "lead", members: ["lead", "waiter"], results: [], finalResultRefs: [] };
	host.history.teams.push({ ...base, teamId: "with-flow", at: 2, flow: "workers avg 1.2 · only lead 25% · start delay p90 19s · waits p90 4.5m · most waited: rpc 26×" },
		{ ...base, teamId: "no-flow", at: 1 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	ui.component.handleInput("]");
	let text = stripTerminalSequences(ui.text(120));
	assert.match(text, /workers avg 1\.2 · only lead 25%/u);
	assert.doesNotMatch(text, /Queue {3}|Warn:/u);
	ui.component.handleInput("]");
	text = stripTerminalSequences(ui.text(120));
	assert.doesNotMatch(text, /workers avg|Flow {4}/u);
});

test("Overview formats live title, active/wall/pause time and compact usage, with one budget row for unlimited counters", (t) => {
	const { host, teamId } = fixture();
	host.runtime.renameTeam(teamId, "MiniCore release");
	host.runtime.teamTime = () => ({ activeMs: 6_595_000, wallMs: 6_775_000, pausedMs: 180_000, startedAt: 0 });
	const team = host.runtime.getTeam(teamId);
	team.usage = { ...team.usage, input: 4_190_000, output: 352_000, cacheRead: 155_800_000 };
	host.runtime.listTeams = () => [team];
	const budget = host.runtime.inspectBudget(teamId);
	for (const key of ["teamActivations", "leadActivations", "teamModelRequests", "teamToolCalls"] as const) budget.limits[key] = 1_000_000_000;
	budget.limits.teamWorks = 20_000;
	host.runtime.inspectBudget = () => budget;
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	let text = ui.text(POPUP_WIDTH);
	assert.match(text, /MiniCore release\s+│\n│ id1 · ACTIVE/u);
	assert.match(text, /Time\s+1:49:55 active · 1:52:55 wall \(paused 3:00\)/u);
	assert.match(text, /Tokens\s+in 4.19M · out 352k · cache 155.8M/u);
	assert.match(text, /Budget\s+all counters unlimited · works 4\/20000/u);
	assert.doesNotMatch(text, /Progress:|Recent:|░/u);
	team.usage.cacheWrite = 912;
	text = ui.text(POPUP_WIDTH);
	assert.match(text, /cache 155.8M\/912/u);
	host.runtime.teamTime = () => ({ activeMs: 252_000, wallMs: 252_000, pausedMs: 0, startedAt: 0 });
	assert.match(ui.text(POPUP_WIDTH), /Time\s+4:12\s+│/u);
});

test("Progress shows accumulated member/current-work times and in-flight usage once, with busy/context threshold colors", (t) => {
	const { host, teamId } = fixture();
	const original = host.runtime.listTeams.bind(host.runtime);
	host.runtime.listTeams = () => original().map((team) => ({ ...team, members: team.members.map((member) => member.id === "runner" ? { ...member, context: { used: 80, window: 100, percent: 80 } } : member) }));
	host.runtime.teamTime = () => ({ activeMs: 100_000, wallMs: 120_000, pausedMs: 20_000, startedAt: 0 });
	const usage = { ...host.runtime.getTeam(teamId).usage, input: 1_220_000, output: 88_000, cacheRead: 37_900_000 };
	host.runtime.memberStats = (_id, member) => ({ activeMs: member === "runner" ? 94_000 : 20_000, usage });
	host.runtime.workStats = () => ({ activeMs: 252_000, usage });
	host.driver.memberActivity = () => ({ liveUsage: usage } as any);
	const tagged = taggingTheme();
	const ui = overlay(host, { theme: tagged.theme });
	t.after(() => ui.component.dispose());
	ui.key("right");
	const text = stripTerminalSequences(ui.text(POPUP_WIDTH));
	assert.match(text, /runner\s+running work .*now 4:12.*ctx 80%/u);
	assert.match(text, /active 1:34 · busy 94% · in 1.22M · out 88k · cache 37.9M/u);
	assert.doesNotMatch(text, /2.44M|176k/u, "driver live usage is already in the runtime totals");
	assert.ok(tagged.calls.some((call) => call.color === "warning" && call.text === "busy 94%"));
	assert.ok(tagged.calls.some((call) => call.color === "warning" && call.text === "ctx 80%"));
});

test("history Progress restores memberStats, final memberStates, usage and pause-excluding busy; old stats may be absent", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
	const usage = { input: 4_190_000, output: 352_000, cacheRead: 155_800_000, cacheWrite: 0, turns: 1, cost: 0, contextTokens: 0 };
	host.history.teams.push({ teamId: "k7m2qx3a", title: "Historical release", version: 2, lifecycle: "closed", members: ["lead", "qa"], lead: "lead", results: [], finalResultRefs: [], at: 120_000, startedAt: 0, activeMs: 100_000, usage,
		memberStates: [{ id: "lead", lifecycle: "closed", resourceState: "released" }, { id: "qa", lifecycle: "faulted", resourceState: "released" }], memberStats: [{ id: "lead", activeMs: 25_000, usage }, { id: "qa", activeMs: 94_000, usage }] });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	let text = ui.text(POPUP_WIDTH);
	assert.match(text, /Σ Team 1:40 · history · 2 members/u);
	assert.match(text, /✓ lead \(lead\)\s+closed/u);
	assert.match(text, /✗ qa\s+faulted/u);
	assert.match(text, /active 1:34 · busy 94%/u);
	assert.match(text, /in 4.19M · out 352k · cache 155.8M/u);
	delete host.history.teams[0]!.memberStats;
	text = ui.text(POPUP_WIDTH);
	assert.match(text, /Σ Team 1:40 · history · 2 members · stats not retained/u);
	assert.match(text, /✓ lead \(lead\)\s+closed\s+│\n│ {3}✗ qa\s+faulted/u, "members without stats are one line each");
	assert.doesNotMatch(text, /active —|busy —|tokens not retained/u);
});

test("Tasks collapse revisions, exclude review works, keep accepted roots expanded and fold only finished/cancelled children", () => {
	const root: TeamWorkSummary = { work: { workId: "work:release", revision: 2 }, requester: "lead", assignee: "dev", title: "Release", taskPreview: "Full instruction", state: "resolved", review: "accepted" };
	const child = (id: string, state: TeamWorkSummary["state"]): TeamWorkSummary => ({ work: { workId: `work:${id}`, revision: 1 }, parent: { ...root.work, revision: 1 }, requester: "dev", assignee: "qa", title: id, taskPreview: id, state });
	const works = [{ ...root, work: { ...root.work, revision: 1 }, title: "Obsolete" }, root,
		...Array.from({ length: 6 }, (_, i) => child(`done${i}`, "resolved")), child("live", "running"), child("cancelled", "cancelled"), child("superseded", "superseded"), { ...child("review", "queued"), kind: "review" as const }];
	let rows = buildTeamTaskRows(works, new Set(), theme, POPUP_WIDTH - 5);
	assert.equal(rows.length, 4);
	assert.match(rows[0]!.text, /Release.*@2 \(rev 1×\)/u);
	assert.match(rows[1]!.text, /^  ▶ live/u, "accepted roots remain expanded");
	assert.match(rows[2]!.text, /– 2 cancelled\/superseded \[\+\]/u);
	assert.match(rows[3]!.text, /✓ 6 sub-tasks done \[\+\]/u);
	assert.doesNotMatch(rows.map((row) => row.text).join("\n"), /Obsolete|review/u);
	rows = buildTeamTaskRows(works, new Set(["work:release:cancelled", "work:release:done"]), theme, POPUP_WIDTH - 5);
	assert.equal(rows.length, 12);
	assert.ok(rows.every((row) => visibleWidth(row.text) <= POPUP_WIDTH - 5));
});

test("Tasks rows use waiting/held/delivered/accepted/reason/error words; result summaries appear only in the selection details", (t) => {
	const { host, teamId, runner, action, settle } = fixture();
	settle(runner, action(runner, 1, { action: "reply", result: { status: "succeeded", summary: "Three fixes shipped. Long detail." } }));
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right");
	let text = ui.text(POPUP_WIDTH);
	assert.match(text, /◐ Implement.*delivered · awaiting acceptance/u);
	assert.match(text, /Review.*waiting for runner/u);
	assert.match(text, /held: attention/u);
	assert.doesNotMatch(text.split("\n").find((line) => line.includes("◐ Implement"))!, /Three fixes/u, "a delivered row has no result summary");
	assert.match(text, /· "Three fixes shipped\."/u, "the selection details have it");
	const originalWorks = host.runtime.listWorks.bind(host.runtime);
	const originalWork = host.runtime.getWork.bind(host.runtime);
	const originalResult = host.runtime.getResult.bind(host.runtime);
	const root = originalWorks(teamId)[0]!;
	const child = originalWorks(teamId).find((work) => work.parent)!;
	host.runtime.listWorks = (id) => originalWorks(id).map((work) => work.work.workId === root.work.workId ? { ...work, review: "accepted" } : work.parent ? { ...work, state: "resolved", resultRef: "result:synthetic" } : work);
	host.runtime.getResult = (id, ref) => ref === "result:synthetic" ? { id: ref, author: child.assignee, work: child.work, committedAt: 1, source: "explicit_reply", result: { status: "succeeded", summary: "3 fixed. Second sentence." } } : originalResult(id, ref);
	text = ui.text(POPUP_WIDTH);
	assert.match(text, /✓ Done · 1\s+\[\+\]/u, "an accepted deliverable moves to the folded Done group");
	ui.key("down"); ui.text(); ui.key("right"); ui.text(); ui.key("down");
	text = ui.text(POPUP_WIDTH);
	assert.match(text, /Check child 1\s+runner\s+done \d+:\d\d\s+│/u, "a sub-task row has no result summary");
	assert.match(text, /Check child 1 · waiter → runner/u);
	assert.match(text, /· "3 fixed\."/u, "the selection details carry the first result sentence");
	assert.doesNotMatch(text, /Second sentence/u);
	ui.key("left"); ui.text(); ui.key("down"); ui.key("enter"); ui.text(); ui.key("down");
	text = stripTerminalSequences(ui.text(POPUP_WIDTH));
	assert.match(text, /✓ Implement the \S+…\s+runner\s+accepted\s+│/u, "the title yields to the widest state column");
	assert.match(text, /· "Three fixes shipped\."/u);
	assert.doesNotMatch(text, /Long detail/u);
	host.runtime.getWork = (id, ref) => {
		const view = originalWork(id, ref);
		return view && ref.workId === root.work.workId ? { ...view, current: { ...view.current, review: { disposition: "waived", reason: "No longer required" }, error: { code: "PROVIDER_DOWN", message: "Failed" } } } : view;
	};
	host.runtime.listWorks = (id) => originalWorks(id).map((work) => work.work.workId === root.work.workId ? { ...work, review: "waived" } : work);
	assert.match(ui.text(POPUP_WIDTH), /waived · No longer required/u);
	host.runtime.listWorks = (id) => originalWorks(id).map((work) => work.work.workId === root.work.workId ? { ...work, state: "failed" } : work);
	assert.match(ui.text(POPUP_WIDTH), /failed: PROVIDER_DOWN/u);
});

test("accepted deliverables sit in the folded Done group: the row shows an explicit disposition reason, the selection details the first result sentence at 73 columns", (t) => {
	for (const reason of [undefined, "QA approved"] as const) {
		const { host, teamId, runner, action, settle } = fixture();
		settle(runner, action(runner, 1, { action: "reply", result: { status: "succeeded", summary: "1178/0 pass. Further detailed notes." } }));
		const lead = host.runtime.takeNextActivation(teamId)!;
		assert.equal(lead.binding.memberId, "lead");
		assert.equal(host.runtime.inputReady(lead.binding, lead.scope.activationId, lead.deliveryId).ok, true);
		const root = host.runtime.listWorks(teamId).find((work) => work.assignee === "runner" && !work.parent)!;
		action(lead, 1, { action: "control", command: "accept_result", work: root.work, disposition: "accepted", ...(reason ? { reason } : {}) });
		const ui = overlay(host);
		t.after(() => ui.component.dispose());
		ui.key("right"); ui.key("right"); ui.text();
		assert.doesNotMatch(ui.text(POPUP_WIDTH), /Implement the popup/u, "Done starts folded");
		ui.key("down"); ui.key("down"); ui.key("enter"); ui.text(); ui.key("down");
		const lines = ui.component.render(POPUP_WIDTH).map(stripTerminalSequences);
		const row = lines.find((line) => line.includes("✓ Implement the popup"))!;
		assert.match(row, reason ? /accepted · QA approved\s+│$/u : /accepted\s+│$/u);
		assert.ok(lines.some((line) => line.includes('· "1178/0 pass."')));
		assert.doesNotMatch(lines.join("\n"), /Further detailed notes/u);
		for (const line of ui.component.render(POPUP_WIDTH)) assert.equal(visibleWidth(line), POPUP_WIDTH);
	}
});

test("real dependency-yield lifecycle identifies the awaited member, WorkRef/title and queued start duration", (t) => {
	const { host, teamId } = fixture();
	const child = host.runtime.listWorks(teamId).find((work) => work.parent)!;
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right"); ui.text(POPUP_WIDTH); ui.key("down"); ui.key("down"); ui.text(POPUP_WIDTH); ui.key("enter");
	const text = rowsOf(ui.component.render(POPUP_WIDTH)).map((row) => row.trim()).join(" ");
	assert.match(text, /Lifecycle:/u);
	assert.match(text, /started work.*\(queued \d+:\d\d\)/u);
	assert.ok(text.includes(`waiting on runner · work ${child.work.workId.split(":")[1]}@1 «Check child 1»`));
});

test("task detail wraps full instruction, usage, lifecycle, revisions, child counts and result evidence", (t) => {
	const { host, teamId, runner, action, settle } = fixture();
	settle(runner, action(runner, 1, { action: "reply", result: { status: "succeeded", summary: "Release complete.", findings: ["Three fixes"], evidence: [{ source: "unit tests", locator: "suite", basis: "verified" }] } }));
	const works = host.runtime.listWorks(teamId);
	const root = works[0]!;
	const facts = host.runtime.panelFacts(teamId);
	facts.timeline = [{ at: 0, text: `lead requested work ${root.work.workId.split(":")[1]}@1 → runner` }, { at: 1000, text: `runner started work ${root.work.workId.split(":")[1]}@1 (queued 0:01)` }, { at: 2000, text: `lead revised work ${root.work.workId.split(":")[1]}@1: "Use the public field"` }];
	facts.timelineOmitted = 2;
	host.runtime.panelFacts = () => facts;
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right"); ui.text(); ui.key("enter");
	const text = ui.text(POPUP_WIDTH);
	assert.match(text, /Task: Implement the popup/u);
	assert.match(text, /Lifecycle:/u);
	assert.match(text, /earlier steps omitted/u);
	assert.match(text, /requested work.*«Implement the popup»/u);
	const unwrapped = rowsOf(ui.component.render(POPUP_WIDTH)).join(" ");
	assert.match(unwrapped, /started work.*queued\s+0:01/u);
	assert.match(unwrapped, /revised work.*Use the\s+public field/u);
	assert.match(text, /Sub-tasks: 0 · 0 done · 0 waiting/u);
	assert.match(text, /Result: Release complete\./u);
	assert.match(text, /Finding: Three fixes/u);
	assert.match(text, /Evidence: unit tests · suite · verified/u);
	assert.match(unwrapped, /in 0 · out 0 · cache\s+0/u);
	assert.match(text, /esc tasks/u);
	ui.key("escape");
	assert.match(ui.text(POPUP_WIDTH), /\[Tasks\]/u);
	assert.doesNotMatch(ui.text(POPUP_WIDTH), /Lifecycle:/u);
});

test("Timeline arrow scroll reaches every retained milestone and resolves work titles", (t) => {
	const { host, teamId } = fixture();
	const work = host.runtime.listWorks(teamId)[0]!;
	const facts = host.runtime.panelFacts(teamId);
	facts.timeline = Array.from({ length: 40 }, (_, index) => ({ at: index * 1000, text: `step ${index} · runner started work ${work.work.workId.split(":")[1]}@1` }));
	host.runtime.panelFacts = () => facts;
	const ui = overlay(host, { rows: 80 });
	t.after(() => ui.component.dispose());
	ui.key("left"); ui.key("left");
	const cursor = () => stripTerminalSequences(ui.component.render(POPUP_WIDTH).find((line) => line.startsWith("│ →"))!);
	assert.match(cursor(), /step 39.*«Implement the popup»/u);
	assert.equal(ui.component.render(POPUP_WIDTH).filter((line) => /step \d+/u.test(line)).length, 12);
	for (let index = 38; index >= 0; index--) { ui.key("up"); assert.match(cursor(), new RegExp(`step ${index} ·`, "u")); }
	for (let index = 1; index < 40; index++) { ui.key("down"); assert.match(cursor(), new RegExp(`step ${index} ·`, "u")); }
});

test("n delegates rename from Overview/live Teams/history Teams without mutating or confusing the selected Team", () => {
	const { host, teamId } = fixture();
	host.history.teams.push({ teamId: "old-uuid-title", title: "Historical title", version: 2, lifecycle: "closed", members: [], results: [], finalResultRefs: [], at: 1 });
	const overview = overlay(host);
	overview.component.handleInput("n");
	assert.deepEqual(overview.closed, [{ teamId, action: "title" }]);
	const teams = overlay(host);
	teams.key("escape"); teams.text(); teams.key("down"); teams.text(); teams.component.handleInput("n");
	assert.deepEqual(teams.closed, [{ teamId: "old-uuid-title", action: "title" }]);
	assert.equal(host.history.teams[0]!.title, "Historical title");
	const historyOverview = overlay(host);
	historyOverview.component.handleInput("]"); historyOverview.text(); historyOverview.component.handleInput("n");
	assert.deepEqual(historyOverview.closed, [{ teamId: "old-uuid-title", action: "title" }]);
});

test("Teams preserve eight-character UUID prefixes and show the start as MM-DD HH:MM", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
	const today = new Date(2026, 9, 5, 14, 6).getTime();
	const yesterday = new Date(2026, 9, 4, 14, 6).getTime();
	const base = { version: 2 as const, lifecycle: "closed" as const, members: ["lead", "qa"], results: [], finalResultRefs: [], rootCounts: { total: 3, accepted: 1, waived: 0 }, activeMs: 6_810_000 };
	host.history.teams.push({ ...base, teamId: "3ce7a106-4412-4683-a99f-1885528225e5", title: "Today release", startedAt: today, at: today + 1000 },
		{ ...base, teamId: "22ed3adb-4412-4683-a99f-1885528225e5", title: "Yesterday release", startedAt: yesterday, at: yesterday + 1000 });
	const ui = overlay(host, { now: () => today + 2000 });
	t.after(() => ui.component.dispose());
	const text = stripTerminalSequences(ui.text(POPUP_WIDTH));
	assert.match(text, /Today release\s+│\n│\s+3ce7a106 · CLOSED · 1:53:30 · 10-05 14:06 · roots 1\/3/u);
	assert.match(text, /Yesterday release\s+│\n│\s+22ed3adb · CLOSED · 1:53:30 · 10-04 14:06 · roots 1\/3/u);
	assert.doesNotMatch(text, /4412-4683/u);
});

test("73-column Tasks summary preserves the counts and the right-aligned view; Teams rows keep members and roots for long titles", (t) => {
	const { host, teamId } = fixture(2);
	host.runtime.renameTeam(teamId, "A long release title that fills the entire title column");
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right");
	let lines = ui.component.render(POPUP_WIDTH);
	const summary = rowsOf(lines).slice(2, rowsOf(lines).indexOf("", 2)).join(" ");
	assert.match(summary, /^3 deliverables · 2 sub-tasks · 1 running · 0 waived {2,}view: all \(f\)$/u);
	assert.doesNotMatch(summary, /…/u);
	ui.key("escape");
	lines = ui.component.render(POPUP_WIDTH);
	assert.match(stripTerminalSequences(lines.join("\n")), /▶ A long release title that fills the entire title column\s+│\n│\s+id1 · ACTIVE · .* · 4 members · roots 0\/3 +│/u);
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
});

test("task detail follows a revision while open and Tasks queue labels distinguish member busy from work ahead", (t) => {
	const { host, teamId } = fixture(2);
	const works = host.runtime.listWorks(teamId);
	const root = works[0]!;
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right"); ui.text();
	ui.key("down"); ui.key("down"); ui.text(); ui.key("right");
	let text = ui.text(POPUP_WIDTH);
	assert.match(text, /Check child 1.*queued · member busy/u);
	assert.match(text, /Check child 2.*queued \(1 ahead\)/u);
	ui.key("left"); ui.text(); ui.key("up"); ui.text(); ui.key("enter"); ui.text();
	const originalWorks = host.runtime.listWorks.bind(host.runtime);
	host.runtime.listWorks = (id) => originalWorks(id).map((work) => work.work.workId === root.work.workId ? { ...work, title: "Revised release", work: { ...work.work, revision: 2 } } : work);
	const originalWork = host.runtime.getWork.bind(host.runtime);
	host.runtime.getWork = (id, ref) => originalWork(id, ref.workId === root.work.workId ? root.work : ref);
	const originalStats = host.runtime.workStats.bind(host.runtime);
	host.runtime.workStats = (id, ref) => originalStats(id, ref.workId === root.work.workId ? root.work : ref);
	text = ui.text(POPUP_WIDTH);
	assert.match(text, /Revised release · work .*@2 \(revised 1×\)/u);
	assert.match(text, /Task: Implement the popup/u);
});

test("real lead revise_work while task detail is open renders the latest title/ref/instruction without throwing", (t) => {
	let id = 0;
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [], { createId: () => `r${++id}` });
	const { teamId } = host.runtime.prepare({ title: "Revision regression", members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "worker", roleDescription: "Work." }], lead: "lead", brief: { goal: "Revise queued work." }, timeoutSeconds: null, initialRequests: [{ to: "worker", title: "Original title", task: "Original instruction." }] });
	host.runtime.launch(teamId);
	const lead = host.runtime.takeNextActivation(teamId)!;
	assert.equal(host.runtime.inputReady(lead.binding, lead.scope.activationId, lead.deliveryId).ok, true);
	const root = host.runtime.listWorks(teamId)[0]!;
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right"); ui.text(POPUP_WIDTH); ui.key("enter");
	assert.match(ui.text(POPUP_WIDTH), /Original title · work .*@1/u);
	const reply = host.runtime.handleAction(lead.binding, lead.scope, 1, "revise-open-detail", { action: "control", command: "revise_work", workId: root.work.workId, expectedRevision: 1, title: "Revised title", task: "Use the public structured error field." }, "revise-open-detail");
	assert.equal(reply.ok, true, JSON.stringify(reply));
	const text = ui.text(POPUP_WIDTH);
	assert.match(text, /Revised title · work .*@2 \(revised 1×\)/u);
	assert.match(text, /Task: Use the public structured error field\./u);
	assert.match(rowsOf(ui.component.render(POPUP_WIDTH)).join(" "), /lead revised work.*Use the public structured error field/u);
});

test("Overview wraps long pause time, cache writes and Waiting with a hanging indent at 73 columns", (t) => {
	const { host, teamId } = fixture(6);
	const title = "Release of the standalone runtime and terminal interface";
	host.runtime.renameTeam(teamId, title);
	host.runtime.teamTime = () => ({ activeMs: 6_595_000, wallMs: 10_775_000, pausedMs: 4_180_000, startedAt: 0 });
	const originalTeams = host.runtime.listTeams.bind(host.runtime);
	host.runtime.listTeams = () => originalTeams().map((team) => ({ ...team, usage: { ...team.usage, input: 4_190_000, output: 352_000, cacheRead: 155_800_000, cacheWrite: 37_900_000 } }));
	const facts = host.runtime.panelFacts(teamId);
	facts.waitingFor = "Standalone quality assurance on the revised release candidate, waiting for developer confirmation";
	host.runtime.panelFacts = () => facts;
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	const lines = ui.component.render(POPUP_WIDTH);
	const rows = rowsOf(lines);
	assert.deepEqual(rows.slice(2, 4), [title, rows[3]!]);
	assert.match(rows[3]!, /^id1 · ACTIVE · \d\d-\d\d \d\d:\d\d → now$/u);
	const text = rows.map((row) => row.trim()).join(" ").replace(/\s+/gu, " ");
	assert.match(text, /Time +1:49:55 active · 2:59:35 wall \(paused 1:09:40\)/u);
	assert.match(text, /Tokens +in 4.19M · out 352k · cache 155.8M\/37.9M/u);
	assert.ok(text.includes(`Waiting ${facts.waitingFor}`));
	const waiting = rows.findIndex((row) => row.includes("Waiting  "));
	assert.ok(rows[waiting + 1]!.startsWith(" ".repeat(12)), "the continuation is indented under the value column");
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
});

test("Overview wraps a valid 60-character title with short ID and enriches running Waiting for with current work/title/time", (t) => {
	let id = 0;
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [], { createId: () => `run${++id}` });
	const title = `MiniCore release ${"x".repeat(43)}`;
	assert.equal(title.length, 60);
	const { teamId } = host.runtime.prepare({ title, members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "v060-qa", roleDescription: "Check." }], lead: "lead", brief: { goal: "Validate the final release candidate." }, timeoutSeconds: null,
		initialRequests: [{ to: "v060-qa", title: "Standalone QA r5", task: "Validate the full candidate." }] });
	host.runtime.launch(teamId);
	const lead = host.runtime.takeNextActivation(teamId)!;
	host.runtime.inputReady(lead.binding, lead.scope.activationId, lead.deliveryId);
	const ended = host.runtime.handleAction(lead.binding, lead.scope, 1, "idle", { action: "yield" }, "idle");
	assert.equal(ended.ok, true);
	host.runtime.nativeSettled(lead.binding, lead.scope.activationId, { status: "success", appliedToolCallId: "idle" });
	host.runtime.cleanupFinished(lead.binding, lead.scope.activationId, { ok: true });
	const runner = host.runtime.takeNextActivation(teamId)!;
	host.runtime.inputReady(runner.binding, runner.scope.activationId, runner.deliveryId);
	assert.equal(host.runtime.panelFacts(teamId).waitingFor, "v060-qa (running)");
	const stats = host.runtime.workStats(teamId, runner.scope.work!);
	host.runtime.workStats = () => ({ ...stats, activeMs: 252_000 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	const lines = ui.component.render(POPUP_WIDTH);
	const text = rowsOf(lines).map((row) => row.trim()).join(" ").replace(/\s+/gu, " ");
	assert.ok(text.includes(`${title} ${teamId} · ACTIVE`));
	assert.ok(text.includes(`Waiting v060-qa on work ${runner.scope.work!.workId.split(":")[1]}@1 «Standalone QA r5» (running 4:12)`));
	const facts = host.runtime.panelFacts(teamId);
	facts.waitingFor = "Lead failed: revive it or hand the lead over";
	host.runtime.panelFacts = () => facts;
	assert.match(ui.text(POPUP_WIDTH), /Lead failed: revive it or hand the lead over/u);
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
});

test("perf: flowStats and the Progress render stay fast for a Team with ~5000 works", (t) => {
	let id = 0;
	let time = 1_700_000_000_000;
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [], { createId: () => `p${++id}`, now: () => time += 10, limits: { teamWorks: 20000, memberUnresolvedWork: 6000, rootChildren: 6000, rootActivations: 6000 } });
	const { teamId } = host.runtime.prepare({ members: ["lead", "w1", "w2", "w3", "w4"].map((alias) => ({ alias, roleDescription: "Work." })), lead: "lead", brief: { goal: "Many works." }, timeoutSeconds: null, review: null,
		initialRequests: [{ to: "w1", task: "Root one" }, { to: "w2", task: "Root two" }] });
	const runtime = host.runtime;
	runtime.launch(teamId);
	const take = () => {
		const activation = runtime.takeNextActivation(teamId)!;
		runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId);
		return activation;
	};
	const act = (activation: RuntimeActivation, sequence: number, args: unknown) => {
		const reply = runtime.handleAction(activation.binding, activation.scope, sequence, `${activation.scope.activationId}:${sequence}`, args, `${activation.scope.activationId}:${sequence}`);
		assert.equal(reply.ok, true, JSON.stringify(reply));
	};
	const settle = (activation: RuntimeActivation, sequence: number) => {
		runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: `${activation.scope.activationId}:${sequence}` });
		runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
	};
	const boot = take();
	act(boot, 1, { action: "yield" });
	settle(boot, 1);
	// Two running roots own 2500 queued sub-tasks each; w3 and w4 then finish 1500 of them.
	for (const [root, worker] of [["w1", "w3"], ["w2", "w4"]] as const) {
		const activation = take();
		assert.equal(activation.binding.memberId, root);
		for (let index = 0; index < 2500; index++) act(activation, index + 1, { action: "request", to: worker, task: `Sub-task ${index}` });
	}
	for (let index = 0; index < 1500; index++) {
		const activation = take();
		act(activation, 1, activation.scope.kind === "events" ? { action: "yield" } : { action: "reply", result: { status: "succeeded", summary: "ok" } });
		settle(activation, 1);
	}
	assert.equal(runtime.listWorks(teamId).length, 5002);
	const stats = runtime.flowStats(teamId);
	assert.ok(stats.queued && stats.queued.count > 3400 && stats.startP90 !== undefined);
	const ui = overlay(host, { now: () => time });
	t.after(() => ui.component.dispose());
	ui.key("right");
	const measure = (run: () => void) => { const start = performance.now(); for (let index = 0; index < 5; index++) run(); return (performance.now() - start) / 5; };
	const statsMs = measure(() => runtime.flowStats(teamId));
	const renderMs = measure(() => ui.component.render(80));
	console.log(`perf (5002 works): flowStats ${statsMs.toFixed(2)} ms, Progress render ${renderMs.toFixed(2)} ms`);
	assert.ok(statsMs < 50, `flowStats ${statsMs} ms`);
	assert.ok(renderMs < 50, `Progress render ${renderMs} ms`);
});

test("Overview folds a long Goal, Outcome and Review to two lines with a hanging indent, … and a dim ›", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
	const sentence = (prefix: string, index: number) => `${prefix}-${index} explains what happened in this long sentence`;
	const goal = Array.from({ length: 10 }, (_, index) => sentence("goal", index)).join(". ");
	const reason = Array.from({ length: 10 }, (_, index) => sentence("reason", index)).join("; ");
	host.history.teams.push({ teamId: "kowx2u32", version: 2, lifecycle: "closed", outcome: "partial", reason, members: ["lead"], goal, results: [], finalResultRefs: [], startedAt: 1_700_000_000_000, at: 1_700_003_600_000, activeMs: 3_600_000,
		review: { by: "waiter", everyMinutes: 10 }, reviews: [reviewRecord("h1", 10, "on_track", { summary: `ON TRACK: ${"long assessment ".repeat(20)}` })] });
	const tagged = taggingTheme();
	const ui = overlay(host, { theme: tagged.theme });
	t.after(() => ui.component.dispose());
	for (const line of ui.component.render(POPUP_WIDTH)) assert.equal(visibleWidth(line), POPUP_WIDTH);
	const rows = rowsOf(ui.component.render(POPUP_WIDTH));
	assert.equal(rows[2], "goal-0 explains what happened in this long sentence.", "the title falls back to the goal's first sentence");
	assert.match(rows[3]!, /^kowx2u32 · CLOSED partial · \d\d-\d\d \d\d:\d\d → \d\d:\d\d$/u);
	const at = (label: string) => rows.findIndex((row) => row.startsWith(label));
	const [goalAt, outcomeAt, reviewAt] = [at("→ Goal      goal-0"), at("  Outcome   partial · reason-0"), at("  Review    10:00 waiter ON TRACK")];
	assert.ok(goalAt >= 0 && outcomeAt === goalAt + 2 && reviewAt === outcomeAt + 2, "each field is exactly two lines");
	for (const index of [goalAt + 1, outcomeAt + 1]) assert.match(rows[index]!, /^ {12}\S.*…\s+›$/u, "the continuation is indented under the value column and marks the cut");
	assert.match(rows[reviewAt]!, /…$/u);
	assert.match(rows[reviewAt + 1]!, /^ {12}1 review · 0 at risk\s+›$/u);
	assert.ok(tagged.calls.some((call) => call.color === "dim" && call.text === "›"));
	assert.match(rows[reviewAt + 3]!, /^ {2}Time {6}1:00:00$/u, "a blank row separates the fields from the short facts");
});

test("Overview Enter on Goal or Outcome opens a scrollable full text page; Esc returns to the same field; Enter on Review opens the review list", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
	const goal = Array.from({ length: 40 }, (_, index) => `goal-${index} explains what happened in this long sentence.`).join("\n");
	const reason = Array.from({ length: 10 }, (_, index) => `reason-${index} explains the partial close`).join("; ");
	host.history.teams.push({ teamId: "kowx2u32", version: 2, lifecycle: "closed", outcome: "partial", reason, members: ["lead"], goal, results: [], finalResultRefs: [], startedAt: 1_700_000_000_000, at: 1_700_003_700_000,
		review: { by: "waiter", everyMinutes: 10 }, reviews: [reviewRecord("h1", 10, "on_track")] });
	const ui = overlay(host, { rows: 24 });
	t.after(() => ui.component.dispose());
	const page = () => rowsOf(ui.component.render(POPUP_WIDTH)).join(" ").replace(/\s+/gu, " ");
	ui.text(); ui.key("enter");
	assert.match(page(), /Goal · Esc back goal-0 explains/u);
	assert.doesNotMatch(page(), /goal-39|›/u, "a short terminal shows the first page of a long goal");
	assert.match(rowsOf(ui.component.render(POPUP_WIDTH)).at(-2)!, /↑↓\/pgup\/dn scroll · esc overview/u);
	ui.key("end"); ui.text();
	assert.match(page(), /goal-39 explains/u, "the page scrolls to the end of the text");
	ui.key("escape");
	assert.match(rowsOf(ui.component.render(POPUP_WIDTH)).join("\n"), /^→ Goal /mu, "back on the Overview with the Goal field selected");
	ui.key("down"); ui.key("enter");
	assert.match(page(), /Outcome · Esc back partial · reason-0/u);
	assert.ok(page().includes("reason-9 explains the partial close"));
	ui.key("escape");
	assert.match(rowsOf(ui.component.render(POPUP_WIDTH)).join("\n"), /^→ Outcome /mu);
	ui.key("down"); ui.key("enter");
	assert.match(ui.text(POPUP_WIDTH), /Reviews · 1 · waiter every 10 min/u);
	ui.key("escape");
	assert.match(rowsOf(ui.component.render(POPUP_WIDTH)).join("\n"), /^→ Review /mu);
	ui.key("up"); ui.key("up"); ui.key("up");
	assert.match(rowsOf(ui.component.render(POPUP_WIDTH)).join("\n"), /^→ Goal /mu, "Up stops at the first field");
});

/** The fixture's three deliverables, with the waiter's accepted (Done), the runner's running (In progress) and the held one holding (Needs attention). */
function groupedTasks(children = 1) {
	const context = fixture(children);
	const original = context.host.runtime.listWorks.bind(context.host.runtime);
	context.host.runtime.listWorks = (id) => original(id).map((work) => !work.parent && work.assignee === "waiter" ? { ...work, state: "resolved" as const, review: "accepted" as const } : work);
	const ui = overlay(context.host);
	ui.key("right"); ui.key("right"); ui.text();
	return { ...context, ui };
}
const bodyOf = (ui: ReturnType<typeof overlay>) => rowsOf(ui.component.render(POPUP_WIDTH));

test("Tasks group deliverables under Needs attention, In progress and a folded Done; headers are not selectable and there is no legend", (t) => {
	const { ui } = groupedTasks();
	t.after(() => ui.component.dispose());
	let rows = bodyOf(ui);
	const at = (pattern: RegExp) => rows.findIndex((row) => pattern.test(row));
	assert.ok(at(/^ {2}⚠ Needs attention · 1$/u) < at(/⏸ Check requirements/u) && at(/⏸ Check requirements/u) < at(/^ {2}▶ In progress · 1$/u) && at(/^ {2}▶ In progress · 1$/u) < at(/▶ Implement the popup/u) && at(/▶ Implement the popup/u) < at(/^ {2}✓ Done · 1 +\[\+\]$/u));
	assert.doesNotMatch(rows.join("\n"), /Review the work/u, "Done starts folded");
	assert.doesNotMatch(rows.join("\n"), /◐ awaiting acceptance|▶ running ⧗ waiting/u, "icons are explained by the group headers, not a legend");
	assert.match(rows[at(/⏸ Check requirements/u)]!, /^→ {2}⏸ Check requirements/u, "the cursor starts on the first deliverable, below the group header");
	ui.key("up");
	assert.match(bodyOf(ui)[at(/⏸ Check requirements/u)]!, /^→ /u, "Up cannot select a header");
	ui.key("down");
	assert.match(bodyOf(ui).find((row) => row.startsWith("→"))!, /▶ Implement the popup/u, "Down skips the In progress header");
	ui.key("down");
	assert.match(bodyOf(ui).find((row) => row.startsWith("→"))!, /✓ Done · 1 +\[\+\]/u);
	ui.key("enter");
	rows = bodyOf(ui);
	assert.match(rows.join("\n"), /✓ Done · 1 +\[−\]/u);
	assert.match(rows.join("\n"), /✓ Review the work.*waiter.*accepted/u);
	ui.key("enter");
	assert.match(bodyOf(ui).join("\n"), /\[\+\]/u);
	assert.doesNotMatch(bodyOf(ui).join("\n"), /Review the work/u);
	ui.key("right");
	assert.match(bodyOf(ui).join("\n"), /\[−\]/u, "→ opens Done");
	ui.key("left");
	assert.match(bodyOf(ui).join("\n"), /\[\+\]/u, "← folds it again");
	for (const line of ui.component.render(POPUP_WIDTH)) assert.equal(visibleWidth(line), POPUP_WIDTH);
});

test("Tasks → expands one deliverable's sub-tasks, ← collapses them, only one deliverable is expanded at a time, and f filters to active work", (t) => {
	const { ui, runner, action } = groupedTasks(2);
	t.after(() => ui.component.dispose());
	const selected = () => bodyOf(ui).find((row) => row.startsWith("→"))!;
	assert.doesNotMatch(bodyOf(ui).join("\n"), /Check child/u, "sub-tasks are not listed until expanded");
	// The runner's deliverable gets a sub-task too, so two deliverables have children.
	ui.key("down"); ui.text();
	action(runner, 1, { action: "request", to: "waiter", task: "Runner side task" });
	assert.match(selected(), /Implement the popup.*0\/1 sub-tasks ›/u);
	ui.key("right"); ui.text();
	assert.match(selected(), /Implement the popup.*0\/1 sub-tasks ‹/u);
	assert.match(bodyOf(ui).join("\n"), /^ {5}○ Runner side task/mu, "the sub-task is indented under its deliverable");
	ui.key("down"); ui.key("down"); ui.text(); ui.key("enter"); ui.text(); ui.key("down"); ui.text();
	assert.match(selected(), /✓ Review the work.*0\/2 sub-tasks ›/u);
	ui.key("right"); ui.text();
	assert.match(selected(), /✓ Review the work.*0\/2 sub-tasks ‹/u, "the cursor follows its deliverable although the rows of the one expanded above it vanished");
	let rows = bodyOf(ui);
	assert.match(rows.join("\n"), /○ Check child 1/u);
	assert.match(rows.join("\n"), /○ Check child 2/u);
	assert.doesNotMatch(rows.join("\n"), /Runner side task/u, "expanding another deliverable collapses the first");
	ui.key("left"); ui.text();
	assert.doesNotMatch(bodyOf(ui).join("\n"), /Check child/u, "← collapses the expanded deliverable");
	assert.match(selected(), /✓ Review the work/u, "and leaves the cursor on it");
	// f cycles all → active → all; the Done group is the only thing hidden.
	assert.match(rows.join("\n"), /view: all \(f\)/u);
	ui.component.handleInput("f");
	rows = bodyOf(ui);
	assert.match(rows.join("\n"), /view: active \(f\)/u);
	assert.doesNotMatch(rows.join("\n"), /Done|Review the work/u);
	assert.match(rows.join("\n"), /Needs attention · 1/u);
	assert.match(rows.join("\n"), /In progress · 1/u);
	ui.component.handleInput("f");
	assert.match(bodyOf(ui).join("\n"), /Done · 1/u);
	assert.match(bodyOf(ui).join("\n"), /view: all \(f\)/u);
});

test("← with the expanded deliverable hidden in the folded Done group keeps the cursor where it is", (t) => {
	const { ui } = groupedTasks();
	t.after(() => ui.component.dispose());
	const selected = () => bodyOf(ui).find((row) => row.startsWith("→"))!;
	for (const key of ["down", "down", "enter", "down", "right", "up", "enter", "up"] as const) { ui.key(key); ui.text(); }
	assert.match(selected(), /▶ Implement the popup/u);
	assert.doesNotMatch(bodyOf(ui).join("\n"), /Review the work/u, "Done is folded again, hiding the expanded deliverable");
	ui.key("left");
	assert.match(selected(), /▶ Implement the popup/u, "the cursor does not jump to the first row");
});

test("opening a Team starts with Done folded and the all view, whatever the previous Team left expanded", (t) => {
	const { ui } = groupedTasks();
	t.after(() => ui.component.dispose());
	for (const key of ["down", "down", "enter"] as const) { ui.key(key); ui.text(); }
	ui.component.handleInput("f");
	assert.match(bodyOf(ui).join("\n"), /view: active \(f\)/u);
	ui.component.handleInput("f");
	assert.match(bodyOf(ui).join("\n"), /Review the work/u, "Done is open before leaving");
	ui.key("escape"); ui.text(); ui.key("enter"); ui.text(); ui.key("right"); ui.text(); ui.key("right");
	assert.doesNotMatch(bodyOf(ui).join("\n"), /Review the work/u);
	assert.match(bodyOf(ui).join("\n"), /Done · 1 +\[\+\]/u);
	ui.component.handleInput("f");
	ui.key("escape"); ui.text(); ui.key("enter"); ui.text(); ui.key("right"); ui.text(); ui.key("right");
	assert.match(bodyOf(ui).join("\n"), /view: all \(f\)/u);
});

test("the Tasks help is one whole row at 73 columns with the Tab hint on a second row, and details stay two lines for a long title", (t) => {
	const { ui, host } = groupedTasks();
	t.after(() => ui.component.dispose());
	const original = host.runtime.listWorks.bind(host.runtime);
	const longTitle = "Implement the popup with a very long title that cannot fit the details pane";
	host.runtime.listWorks = (id) => original(id).map((work) => work.title === "Implement the popup" ? { ...work, title: longTitle } : work);
	assert.deepEqual(helpOf(ui.component.render(POPUP_WIDTH)), ["↑↓ select · enter details · → expand · f filter · esc teams", "← collapse · tab views"]);
	ui.key("down");
	const rows = bodyOf(ui);
	const route = rows.findIndex((row) => / · lead → runner · work /u.test(row));
	assert.ok(route > 0, rows.join("\n"));
	assert.match(rows[route]!, /^Implement the popup with a very.*… · lead → runner · work \w+@1$/u, "the title is cut, the route and ref stay");
	assert.match(rows[route + 1]!, /^active /u, "the second line follows directly");
	assert.equal(rows[route + 2], "", "exactly two detail lines, then the blank row above the help");
});

test("Tasks selection details show the route, work ref with revisions and the first result sentence below the list", (t) => {
	const { ui, host, teamId } = groupedTasks();
	t.after(() => ui.component.dispose());
	const original = host.runtime.listWorks.bind(host.runtime);
	const root = original(teamId).find((work) => work.assignee === "runner" && !work.parent)!;
	host.runtime.listWorks = (id) => original(id).map((work) => work.work.workId === root.work.workId ? { ...work, work: { ...work.work, revision: 3 }, resultRef: "result:synthetic" } : work);
	const originalWork = host.runtime.getWork.bind(host.runtime);
	host.runtime.getWork = (id, ref) => originalWork(id, ref.workId === root.work.workId ? root.work : ref);
	const originalResult = host.runtime.getResult.bind(host.runtime);
	host.runtime.getResult = (id, ref) => ref === "result:synthetic" ? { id: ref, author: "runner", work: root.work, committedAt: 1, source: "explicit_reply", result: { status: "succeeded", summary: "LABEL=FINAL2 first sentence. Second sentence." } } : originalResult(id, ref);
	const originalStats = host.runtime.workStats.bind(host.runtime);
	host.runtime.workStats = (id, ref) => originalStats(id, ref.workId === root.work.workId ? root.work : ref);
	ui.key("down"); ui.text();
	const text = bodyOf(ui);
	const route = text.findIndex((row) => row.startsWith("Implement the popup · lead → runner · work "));
	assert.ok(route > 0 && text[route]!.endsWith("@3 (rev 2×)"), text.join("\n"));
	assert.match(text[route + 1]!, /^active \d+:\d\d · in 0 · out 0 · cache 0 · "LABEL=FINAL2 first sentence\."$/u);
	assert.ok(route > text.findIndex((row) => /▶ Implement the popup/u.test(row)), "the details sit below the list");
});

test("history Tasks list one line per retained result with short refs and no UUIDs, and Enter shows the full result", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
	const uuid = (index: number) => `${String(index).padStart(8, "0")}-1340-49bf-83b0-ad92d0bd76ae`;
	const results = Array.from({ length: 12 }, (_, index) => ({ id: `result:${uuid(100 + index)}`, author: index % 2 ? "mt0930-gate" : "mt0930-rpc", work: { workId: `work:${uuid(index)}`, revision: 1 + index % 2 }, committedAt: index,
		source: "explicit_reply" as const, result: { status: (["succeeded", "partial", "failed"] as const)[index % 3]!, summary: `BOOTSTRAP ${index} nonce=boot-${index}. Long second sentence with work:${uuid(index)} inside it that must not be shown.`, findings: [`finding ${index}`], evidence: [{ source: "unit", basis: "verified" as const }] } }));
	host.history.teams.push({ teamId: "kowx2u32", version: 2, lifecycle: "closed", members: ["lead"], goal: "Old", results, finalResultRefs: [], at: 1 });
	const tagged = taggingTheme();
	const ui = overlay(host, { theme: tagged.theme });
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right"); ui.text();
	const rows = rowsOf(ui.component.render(POPUP_WIDTH));
	const listed = rows.filter((row) => /^(→ |  )[✓⚠✗] 0000000\d@/u.test(row));
	assert.ok(listed.length >= 4, rows.join("\n"));
	assert.match(listed[0]!, /^→ ✓ 00000000@1 · mt0930-rpc · "BOOTSTRAP 0 nonce=boot-0\."$/u);
	assert.match(listed[1]!, /^ {2}⚠ 00000001@2 · mt0930-gate · "BOOTSTRAP 1 nonce=boot-1\."$/u);
	assert.match(listed[2]!, /^ {2}✗ 00000002@1 · mt0930-rpc/u);
	assert.doesNotMatch(rows.join("\n"), /-1340-49bf|work:|result:|Long second sentence|Work ledger/u);
	assert.match(rows.at(-4) ?? "", /↓ \d+ more/u);
	for (const [color, glyph] of [["success", "✓"], ["warning", "⚠"], ["error", "✗"]]) assert.ok(tagged.calls.some((call) => call.color === color && call.text === glyph), glyph);
	ui.key("down"); ui.key("enter");
	const detail = rowsOf(ui.component.render(POPUP_WIDTH)).join(" ").replace(/\s+/gu, " ");
	assert.match(detail, /00000001@2 · mt0930-gate · partial · result:00000101-1340-49bf-83b0-ad92d0bd76ae · Esc back/u);
	assert.match(detail, /Result: BOOTSTRAP 1 nonce=boot-1\. Long second sentence/u);
	assert.match(detail, /Finding: finding 1/u);
	assert.match(detail, /Evidence: unit · verified/u);
	ui.key("escape");
	assert.match(rowsOf(ui.component.render(POPUP_WIDTH)).join("\n"), /^ {2}⚠ 00000001@2/mu);
});

test("Progress marks the members hidden below and above the page", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
	host.runtime.prepare({ members: ["lead", ...Array.from({ length: 8 }, (_, index) => `w${index + 1}`)].map((alias) => ({ alias, roleDescription: "Work." })), lead: "lead", brief: { goal: "Nine members." }, timeoutSeconds: null });
	const ui = overlay(host, { rows: 46 });
	t.after(() => ui.component.dispose());
	ui.key("right");
	let rows = rowsOf(ui.component.render(POPUP_WIDTH));
	assert.ok(rows.some((row) => /^ {2}.* w7$|^ {2}.* w7 /u.test(row)) && !rows.some((row) => /\bw8\b/u.test(row)), "the ninth member is below the page");
	assert.equal(rows.filter((row) => /^ {2}↓ 1 more$/u.test(row)).length, 1);
	assert.ok(!rows.some((row) => /↑ \d+ more/u.test(row)));
	ui.key("end"); ui.text();
	rows = rowsOf(ui.component.render(POPUP_WIDTH));
	assert.ok(rows.some((row) => /→ .* w8\b/u.test(row)), "End reaches the last member");
	assert.equal(rows.filter((row) => /^ {2}↑ 1 more$/u.test(row)).length, 1);
	assert.ok(!rows.some((row) => /↓ \d+ more/u.test(row)));
	for (const line of ui.component.render(POPUP_WIDTH)) assert.equal(visibleWidth(line), POPUP_WIDTH);
	const four = fixture();
	const small = overlay(four.host);
	small.key("right");
	assert.doesNotMatch(small.text(POPUP_WIDTH), /\d+ more/u, "no markers when every member fits");
	small.component.dispose();
});

test("the Teams list scrolls by Team: a two-line row is never split at the page edge", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, []);
	for (let index = 0; index < 15; index++) host.history.teams.push({ teamId: `team${String(index).padStart(4, "0")}`, title: `Team number ${index}`, version: 2, lifecycle: "closed", outcome: "succeeded", members: ["lead"], results: [], finalResultRefs: [], at: 100 - index });
	const ui = overlay(host, { rows: 20 });
	t.after(() => ui.component.dispose());
	const lists = () => rowsOf(ui.component.render(POPUP_WIDTH)).filter((row) => /^(→ |  )✓ Team number|^ {6}team\d{4} · CLOSED ok/u.test(row));
	let rows = lists();
	assert.ok(rows.length > 0 && rows.length < 30 && rows.length % 2 === 0, rows.join("\n"));
	rows.forEach((row, index) => assert.match(row, index % 2 ? /^ {6}team\d{4} · CLOSED ok/u : /^(→ |  )✓ Team number \d+$/u));
	assert.match(rows[0]!, /^→ ✓ Team number 0$/u);
	ui.key("end"); ui.text();
	rows = lists();
	assert.equal(rows.length % 2, 0);
	assert.equal(rows.at(-2), "→ ✓ Team number 14");
	assert.equal(rows.at(-1), "      team0014 · CLOSED ok · — · — · 1 members · roots —");
	ui.key("home"); ui.text();
	assert.match(lists()[0]!, /^→ ✓ Team number 0$/u);
	for (const line of ui.component.render(POPUP_WIDTH)) assert.equal(visibleWidth(line), POPUP_WIDTH);
});

/** Journal records shaped like the real kowx2u32 Team: nine members, 35 roots (2 waived), a long CJK goal and a long reason. */
function syntheticJournal() {
	const teamId = "kowx2u32";
	const members = ["lead", "source", "relay", "verifier", "scheduler", "rpc", "reviewer", "writer", "gate"].map((name) => `v3b1005-${name}`);
	const goal = "\u5b8c\u6574\u6267\u884cOct5 v3\u957f\u7a0b\u6d4b\u8bd5\uff0c\u7ea6140\u4e2a\u666e\u901awork\u52a0\u771f\u5b9ereview\uff0c\u8986\u76d6system brief\u3001\u6807\u9898/8char ID\u3001allowlist\u53d1\u73b0\u5de5\u5177\u300172child\u5206\u6279\u4e0e\u65e764\u6a21\u578b\u6b65\u9aa4\u4e0a\u9650\u3002".repeat(2);
	const reason = "Team\u6309partial\u5173\u95ed\uff1aselected 12\u4e2a\u5173\u952e\u7ed3\u679c\u5305\u62ec\u5df2waive\u7684writer FINAL2\u4e0eFINAL_ACCEPTANCE\u3002".repeat(12);
	const uuid = (index: number) => `${String(index).padStart(8, "0")}-1340-49bf-83b0-ad92d0bd76ae`;
	const start = new Date(2026, 9, 5, 15, 48).getTime();
	const usage = { input: 2_380_000, output: 274_000, cacheRead: 31_860_000, cacheWrite: 0, turns: 100, cost: 0, contextTokens: 0 };
	const results = Array.from({ length: 35 }, (_, index) => ({ id: `result:${uuid(500 + index)}`, work: { workId: `work:${uuid(index)}`, revision: 1 }, author: members[1 + index % 8]!, committedAt: start + index, source: "explicit_reply" as const,
		result: { status: "succeeded" as const, summary: `LABEL=ROOT${index} verified with the retained evidence. CURRENT=work:${uuid(index)}@1. Second sentence of the result.` } }));
	const roots = results.map((record, index) => ({ work: record.work, state: "resolved" as const, resultRef: record.id, review: index < 33 ? { disposition: "accepted" as const } : { disposition: "waived" as const, reason: "NEEDS_CORRECTION" } }));
	const refs = results.slice(0, 12).map((record) => record.id);
	const entry = (data: Record<string, unknown>) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, teamId, ...data } });
	return [entry({ kind: "launched", at: start, roster: { lead: members[0], members }, goal }),
		...results.map((result, index) => entry({ kind: "result", at: start + 1 + index, result })),
		entry({ kind: "close_decision", at: start + 100, closeId: "close-1", outcome: "partial", resultRefs: refs, roots, reason }),
		entry({ kind: "terminal", at: start + 3_747_000, closeId: "close-1", flow: "workers avg 1.3 \u00b7 only lead 20%", activeMs: 3_747_000, memberStats: members.map((id) => ({ id, activeMs: 300_000, usage })),
			result: { version: 2, teamId, lifecycle: "closed", outcome: "partial", reason, finalResultRefs: refs, roots, members: members.map((id) => ({ id, lifecycle: "closed", resourceState: "released" })), usage, unresolvedIncidents: [] } })];
}

test("a history Team restored from a synthetic journal like kowx2u32 (many roots, long goal and reason) renders every view within 73 columns", (t) => {
	const host = new TeamSessionHost({ listSaved: async () => [] } as unknown as SessionBroker, () => undefined, syntheticJournal());
	assert.equal(host.history.skipped, 0);
	assert.equal(host.history.teams.length, 1);
	const entry = host.history.teams[0]!;
	assert.equal(entry.rootCounts?.total, 35);
	assert.equal(entry.results.length, 35);
	entry.reviews = [reviewRecord("h1", 60, "on_track", { by: "v3b1005-reviewer", summary: `ON TRACK: The deep-return source root ${"continues with long evidence ".repeat(12)}` })];
	entry.review = { by: "v3b1005-reviewer", everyMinutes: 4 };
	const ui = overlay(host, { rows: 46 });
	t.after(() => ui.component.dispose());
	const check = (name: string) => {
		const lines = ui.component.render(POPUP_WIDTH);
		assert.ok(lines.length <= Math.floor(46 * 0.88), `${name}: ${lines.length} lines`);
		lines.forEach((line, index) => assert.equal(visibleWidth(line), POPUP_WIDTH, `${name} line ${index}`));
		return rowsOf(lines);
	};
	// One Team opens on its Overview: header, folded fields, short facts.
	let rows = check("Overview");
	assert.match(rows[3]!, /^kowx2u32 · CLOSED partial · 10-05 15:48 → 16:\d\d$/u);
	const goalAt = rows.findIndex((row) => row.startsWith("→ Goal      "));
	assert.match(rows[goalAt + 1]!, /^ {12}\S.*…\s+›$/u);
	assert.match(rows[goalAt + 2]!, /^ {2}Outcome   partial · Team/u);
	assert.match(rows[goalAt + 3]!, /^ {12}\S.*…\s+›$/u);
	assert.match(rows.join("\n"), /^ {2}Review    1:00:00 v3b1005-reviewer ON TRACK · .*…$/mu);
	assert.match(rows.join("\n"), /^ {12}1 review · 0 at risk\s+›$/mu);
	assert.match(rows.join("\n"), /^ {2}Roots {5}33\/35 accepted · 2 waived$/mu);
	// Teams: two-line row with the partial icon.
	ui.key("escape");
	rows = check("Teams");
	assert.match(rows.join("\n"), /^→ ⚠ .*\n {6}kowx2u32 · CLOSED partial · 1:02:27 · 10-05 15:48 · roots 33\/35$/mu);
	ui.key("enter");
	// Progress: nine members, one hidden below; stats are retained, so every member has two lines.
	ui.key("right"); rows = check("Progress");
	assert.match(rows.join("\n"), /^ {2}↓ 1 more$/mu);
	// Tasks: one line per retained result, short refs, no UUIDs.
	ui.key("right"); rows = check("Tasks");
	assert.ok(rows.filter((row) => /^(→ |  )✓ \d{8}@1 · v3b1005-/u.test(row)).length >= 8);
	assert.doesNotMatch(rows.join("\n"), /-1340-49bf|work:|Second sentence/u);
	assert.match(rows.join("\n"), /↓ 27 more/u);
	ui.key("right"); check("Timeline");
	for (const width of [60, 100]) for (const line of ui.component.render(width)) assert.equal(visibleWidth(line), width);
});
