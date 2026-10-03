import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SessionBroker } from "../../tools/subagents/session-broker";
import { TeamSessionHost } from "../../tools/subagents/team-host";
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

test("five views show real running, waiting and held work, routes and attention", (t) => {
	const { host, now } = fixture();
	const ui = overlay(host, { now });
	t.after(() => ui.component.dispose());
	assert.match(ui.text(), /ACTIVE · needs attention · \d+:\d\d/u);
	assert.match(ui.text(), /Progress:\s+roots 0\/3 accepted · works 0\/4 done · 0 cancelled/u);
	assert.match(ui.text(), /Waiting for: Lead decision/u);
	assert.match(ui.text(), /Attention:\s+1 open holds/u);
	assert.match(ui.text(), /Budget:\s+activations/u);
	ui.key("tab");
	assert.match(ui.text(), /\[Progress\]/u);
	ui.key("tab");
	assert.match(ui.text(), /▶ runner\s+running work .*lead → runner → lead/u);
	assert.match(ui.text(), /⧗ waiter\s+waiting on 1 sub-task: runner/u);
	assert.match(ui.text(), /⏸ held\s+held · asks: "Which requirements\?"/u);
	ui.key("tab");
	assert.match(ui.text(), /roots 0\/3 accepted · works 0\/4/u);
	assert.match(ui.text(), /  ○ work:.*runner ← waiter.*Check child 1/u);
	ui.key("tab"); ui.text(); ui.key("home");
	assert.match(ui.text(), /0:00  launch/u);
	assert.match(ui.text(), /waiter requested work/u);
	ui.key("backTab");
	assert.match(ui.text(), /\[Tasks\]/u);
});

test("Members Enter shows full task, outbound works, and latest result with destination", (t) => {
	const { host, runner, action, settle } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("tab"); ui.key("tab"); ui.text(); ui.key("down"); ui.key("down"); ui.text(); ui.key("enter");
	assert.match(ui.text(), /Member waiter · Esc back/u);
	assert.match(ui.text(), /Keep every detail of this task\./u);
	assert.match(ui.text(), /→ runner · queued/u);
	ui.key("escape");
	settle(runner, action(runner, 1, { action: "reply", result: { status: "succeeded", summary: "Popup implemented." } }));
	ui.text(); ui.key("down"); ui.text(); ui.key("enter");
	assert.match(ui.text(), /Latest result: succeeded · /u);
	assert.match(ui.text(), /result → lead · succeeded · awaiting review/u);
	assert.match(ui.text(), /Popup implemented\./u);
});

test("Tasks fold more than five children, expand with Enter, and collapse again", (t) => {
	const { host } = fixture(6);
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("tab"); ui.key("tab"); ui.key("tab");
	assert.match(ui.text(), /✓ 6 sub-tasks \(runner 6\) · 0 done \[\+\]/u);
	assert.doesNotMatch(ui.text(), /Check child 6/u);
	ui.key("down"); ui.key("down"); ui.text(); ui.key("enter");
	assert.match(ui.text(), /\[−\]/u);
	ui.key("pageDown");
	assert.match(ui.text(), /Check child 6/u);
	ui.key("home"); ui.text(); ui.key("down"); ui.key("down"); ui.text(); ui.key("enter");
	assert.doesNotMatch(ui.text(), /Check child 6/u);
});

test("task rows preserve nesting across parent revisions and use state/review icons", () => {
	const root: TeamWorkSummary = { work: { workId: "work:root", revision: 2 }, requester: "lead", assignee: "gate", state: "resolved", review: "accepted", taskPreview: "Root", resultRef: "result:one" };
	const children = ["resolved", "running", "blocked", "failed", "cancelled", "superseded", "queued"] as const;
	const works: TeamWorkSummary[] = [root, ...children.map((state, index) => ({ work: { workId: `work:c${index}`, revision: 1 }, parent: { ...root.work, revision: 1 }, requester: "gate", assignee: index % 2 ? "rpc" : "reviewer", state, taskPreview: `Child\n${index}` }))];
	const rows = buildTeamTaskRows(works, new Set([root.work.workId]), theme);
	assert.match(rows[0]!.text, /^✓ work:root@2.*resolved\/accepted\s+Root · result:one$/u);
	assert.match(rows[1]!.text, /7 sub-tasks \(reviewer 4 · rpc 3\) · 1 done/u);
	assert.deepEqual(rows.slice(2).map((row) => row.text.trim()[0]), ["✓", "▶", "⧗", "✗", "–", "–", "○"]);
	assert.ok(rows.slice(2).every((row) => row.text.startsWith("  ") && !row.text.includes("\n")));
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

test("narrow member rows retain routes and time; long Unicode task previews retain result status", (t) => {
	const { host } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("tab"); ui.key("tab");
	assert.match(ui.text(60), /lead → held → lead\s+0:00/u);
	const root: TeamWorkSummary = { work: { workId: "work:root", revision: 1 }, requester: "lead", assignee: "w1", state: "resolved", review: "accepted", taskPreview: "检查🧪".repeat(100), resultRef: "r1" };
	const colored = { ...theme, fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m` } as Theme;
	for (const width of [60, 120]) {
		const row = buildTeamTaskRows([root], new Set(), colored, width)[0]!;
		assert.ok(visibleWidth(row.text) <= width);
		assert.match(row.text, /resolved\/accepted\s+.* · r1$/u);
	}
});

test("long Tasks lists keep selection visible; Timeline pages from newest to oldest", (t) => {
	const { host } = fixture(6);
	const ui = overlay(host, { rows: 14 });
	t.after(() => ui.component.dispose());
	ui.key("tab"); ui.key("tab"); ui.key("tab"); ui.text();
	ui.key("down"); ui.key("down"); ui.text(); ui.key("enter"); ui.text();
	for (let index = 0; index < 10; index++) { ui.key("down"); ui.text(); }
	assert.match(ui.text(), /→ ⏸ work:.*held ← lead/u);
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
	ui.key("tab"); ui.key("tab"); ui.key("tab"); ui.key("tab");
	assert.match(ui.text(), /… 12 earlier milestones omitted …/u);
	const hold = host.runtime.listHolds(teamId)[0]!;
	host.runtime.releaseHold(teamId, hold.work, hold.incidentId, "Use the approved requirements");
	assert.match(ui.text(), /host released the hold on work/u);
});

test("Team selector defaults to active, orders recent history last, and prevents history actions", (t) => {
	const { host, teamId } = fixture();
	host.runtime.prepare({ members: [{ alias: "other", roleDescription: "Manage." }, { alias: "worker", roleDescription: "Work." }], lead: "other", brief: { goal: "Prepared" }, timeoutSeconds: null });
	host.history.teams.push({ teamId: "old", version: 2, lifecycle: "interrupted", lead: "lead", members: ["lead", "worker"], results: [], finalResultRefs: [], at: 1 },
		{ teamId: "recent", version: 2, lifecycle: "closed", lead: "lead", members: ["lead", "worker"], goal: "Historic goal", results: [], finalResultRefs: [], at: 2 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	assert.match(ui.text(), new RegExp(`‹ 1/4 › ${teamId}`, "u"));
	ui.component.handleInput("]"); ui.component.handleInput("]");
	assert.match(ui.text(), /Team recent · CLOSED · history \(read-only\)/u);
	ui.component.handleInput("c");
	assert.equal(ui.closed.length, 0);
	ui.component.handleInput("]");
	assert.match(ui.text(), /Team old · INTERRUPTED/u);
	ui.component.handleInput("["); ui.component.handleInput("["); ui.component.handleInput("[");
	assert.match(ui.text(), new RegExp(`‹ 1/4 › ${teamId}`, "u"));
	assert.match(ui.text(), /ACTIVE/u);
});

test("ended Teams stay visible and read-only", (t) => {
	const { host, teamId } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	host.runtime.cancelTeam(teamId, "Done testing");
	assert.match(ui.text(), /CANCELLED/u);
	assert.match(ui.text(), /read-only/u);
	ui.component.handleInput("c");
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
	assert.ok(lines.slice(1, -1).every((line) => stripTerminalSequences(line).startsWith("│ ")));
	assert.ok(tagged.calls.some(({ color, text }) => color === "accent" && text === "\x1b[1mRail Team\x1b[22m"));
	assert.ok(tagged.calls.some(({ color, text }) => color === "accent" && text === "[Overview]"));
	assert.ok(tagged.calls.some(({ color, text }) => color === "dim" && text === " Members "));
	assert.match(stripTerminalSequences(lines[2]!), /ACTIVE · needs attention · \d+:\d\d · roots 0\/3 accepted · works 0\/4 · 1 running · 1 held · 1 waiting/u);
	assert.equal(stripTerminalSequences(lines[3]!).trim(), "│" + " ".repeat(198) + "│");
	ui.key("right"); ui.key("right");
	const members = ui.text(100);
	assert.match(stripTerminalSequences(members), /│ → ○ lead/u);
	assert.ok(tagged.calls.some(({ color, text }) => color === "accent" && text === " → "));
	assert.ok(tagged.calls.some(({ color, text }) => color === "accent" && stripTerminalSequences(text).startsWith("○ lead")));
	for (const width of [60, 100, 200]) assert.ok(ui.component.render(width).every((line) => visibleWidth(line) === width));
});

test("summary omits zero activity counts and header selector shows only eight ID characters", (t) => {
	let id = 0;
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [], { createId: () => `long-team-id-${++id}` });
	for (let index = 0; index < 2; index++) host.runtime.prepare({ members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "worker", roleDescription: "Work." }], lead: "lead", brief: { goal: "Test" }, timeoutSeconds: null });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	const lines = ui.component.render(100);
	assert.match(lines[1]!, /Rail Team\s+\[Overview\]\s+Progress\s+Members\s+Tasks\s+Timeline/u);
	assert.match(lines[1]!, /‹ 1\/2 › long-tea│$/u);
	assert.match(lines[2]!, /PREPARED · ok · 0:00 · roots 0\/0 accepted · works 0\/0/u);
	assert.doesNotMatch(lines[2]!, /0 running|held|waiting/u);
});

test("Members align alias, state, route and right-aligned active time, with selected details", (t) => {
	const { host, runner, action, settle } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right");
	const lines = ui.component.render(100);
	const members = lines.filter((line) => /[○▶⧗⏸] (lead|runner|waiter|held)/u.test(line));
	assert.equal(members.length, 4);
	assert.deepEqual(members.map((line) => visibleWidth(line.slice(0, line.indexOf("0:00")))), [95, 95, 95, 95]);
	const workerLines = members.slice(1);
	assert.equal(new Set(workerLines.map((line) => line.indexOf("lead →"))).size, 1);
	assert.equal(new Set(workerLines.map((line) => line.indexOf("running work") >= 0 ? line.indexOf("running work") : line.indexOf("waiting on") >= 0 ? line.indexOf("waiting on") : line.indexOf("held ·"))).size, 1);
	ui.key("down");
	assert.match(ui.text(100), /│ runner\s+│/u);
	assert.match(ui.text(100), /Task: Implement the popup/u);
	assert.match(ui.text(100), /Route: lead → runner → lead/u);
	settle(runner, action(runner, 1, { action: "reply", result: { status: "succeeded", summary: "Done" } }));
	const latest = host.runtime.panelFacts(host.runtime.listTeams()[0]!.teamId).results.get("runner")!.latest;
	assert.ok(ui.text(100).includes(`result → lead · succeeded · awaiting review · ${latest.id}`));
});

test("Tasks align WorkRef, route and state before preview, with full selected details", (t) => {
	const { host, teamId } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right"); ui.key("right");
	const lines = ui.component.render(100);
	const rows = lines.filter((line) => /[▶⧗○⏸] work:/u.test(line));
	assert.equal(rows.length, 4);
	const routes = ["runner ← lead", "waiter ← lead", "runner ← waiter", "held ← lead"];
	const states = ["running", "blocked", "queued", "held"];
	assert.equal(new Set(rows.map((line, index) => line.indexOf(routes[index]!))).size, 1);
	assert.equal(new Set(rows.map((line, index) => line.indexOf(`  ${states[index]} `, line.indexOf(routes[index]!) + routes[index]!.length))).size, 1);
	assert.equal(new Set(rows.map((line) => line.indexOf("Implement") >= 0 ? line.indexOf("Implement") : line.indexOf("Review") >= 0 ? line.indexOf("Review") : line.indexOf("Check"))).size, 1);
	ui.key("down"); ui.key("down");
	const child = host.runtime.listWorks(teamId).find((work) => work.parent)!;
	assert.ok(ui.text(100).includes(`${child.work.workId}@${child.work.revision}`));
	assert.match(ui.text(100), /From: waiter → runner → waiter/u);
	assert.match(ui.text(100), /State: queued · resultRef: —/u);
	assert.match(ui.text(100), /Task: Check child 1/u);
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
	for (const label of ["Goal", "Progress", "Waiting for", "Attention", "Budget", "Recent"]) {
		const line = text.split("\n").find((line) => line.startsWith(`│ ${label}:`))!;
		assert.ok(line, label);
		assert.match(line.slice(2, 15), new RegExp(`^${label}: +$`, "u"));
	}
});

test("short terminals drop selected details before list rows in Members and Tasks", (t) => {
	const { host } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.key("right");
	assert.match(ui.text(100), /Task: Ship the local Team popup/u);
	ui.tui.terminal.rows = 18;
	assert.doesNotMatch(ui.text(100), /Task:|Route:|Latest result:/u);
	assert.equal(ui.component.render(100).filter((line) => /[○▶⧗⏸] (lead|runner|waiter|held)/u.test(line)).length, 4);
	ui.key("right");
	assert.doesNotMatch(ui.text(100), /Task:|From:|resultRef:/u);
	assert.equal(ui.component.render(100).filter((line) => /[▶⧗○⏸] work:/u.test(line)).length, 4);
	ui.tui.terminal.rows = 40;
	assert.match(ui.text(100), /Task: Implement the popup/u);
});

test("Timeline cursor uses aligned time, pages, Home/End, and follows only at newest", (t) => {
	const { host } = fixture();
	const facts = host.runtime.panelFacts(host.runtime.listTeams()[0]!.teamId);
	facts.timeline = Array.from({ length: 20 }, (_, index) => ({ at: index * 60_000, text: `milestone ${index}` }));
	facts.timelineOmitted = 3;
	host.runtime.panelFacts = () => facts;
	const ui = overlay(host, { rows: 21 }); // two help rows: 21 terminal rows keep an 8-row Timeline page
	t.after(() => ui.component.dispose());
	ui.key("left");
	const cursor = () => ui.component.render(100).find((line) => line.startsWith("│ →"))!;
	assert.match(cursor(), /19:00  milestone 19/u);
	facts.timeline.push({ at: 20 * 60_000, text: "milestone 20" });
	assert.match(cursor(), /20:00  milestone 20/u);
	ui.key("up");
	assert.match(cursor(), /19:00  milestone 19/u);
	facts.timeline.push({ at: 21 * 60_000, text: "milestone 21" });
	assert.match(cursor(), /19:00  milestone 19/u);
	ui.key("pageUp");
	assert.match(cursor(), /11:00  milestone 11/u);
	ui.key("home");
	assert.match(cursor(), /0:00  milestone 0/u);
	assert.match(ui.text(100), /… 3 earlier milestones omitted …/u);
	const first = cursor().indexOf("milestone");
	ui.key("down");
	assert.match(cursor(), /1:00  milestone 1/u);
	ui.key("pageDown");
	assert.match(cursor(), /9:00  milestone 9/u);
	ui.key("down");
	assert.equal(cursor().indexOf("milestone"), first);
	// Dropping older retained entries must not move a cursor to a different milestone.
	facts.timeline.splice(1, 2);
	facts.timelineOmitted += 2;
	assert.match(cursor(), /10:00  milestone 10/u);
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
	ui.key("right"); ui.key("right");
	assert.match(ui.text(), /\[Members\]/u);
	assert.match(ui.text(), /‹ 1\/2 ›/u);
	ui.component.handleInput("j");
	assert.match(ui.text(), /→ ▶ runner/u);
	ui.component.handleInput("e");
	assert.match(ui.text(), /Member runner · Esc back/u);
	ui.component.handleInput("q");
	assert.doesNotMatch(ui.text(), /Member runner · Esc back/u);
	ui.component.handleInput("j"); ui.text(); ui.component.handleInput("k");
	assert.match(ui.text(), /→ ○ lead/u);
	ui.key("left"); ui.key("left");
	assert.match(ui.text(), /\[Overview\]/u);
	ui.key("backTab");
	assert.match(ui.text(), /\[Timeline\]/u);
	ui.key("tab");
	assert.match(ui.text(), /\[Overview\]/u);
	ui.component.handleInput("]");
	assert.match(ui.text(), /‹ 2\/2 › history/u);
	assert.match(ui.text(), /\[Overview\]/u);
	ui.component.handleInput("[");
	assert.match(ui.text(), /‹ 1\/2 ›/u);
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
	ui.key("right"); ui.key("right");
	const text = ui.text();
	assert.match(text, /✗ runner\s+faulted · .*model_error: Provider failed/u);
	assert.match(text, /✓ waiter\s+closed/u);
	assert.doesNotMatch(text, /(runner|waiter)\s+idle/u);
});

test("Timeline pages use the available height instead of eight rows", (t) => {
	const { host } = fixture();
	const facts = host.runtime.panelFacts(host.runtime.listTeams()[0]!.teamId);
	facts.timeline = Array.from({ length: 40 }, (_, index) => ({ at: index * 1000, text: `milestone ${index}` }));
	host.runtime.panelFacts = () => facts;
	const ui = overlay(host, { rows: 40 });
	t.after(() => ui.component.dispose());
	ui.key("left");
	const shown = () => ui.component.render(100).filter((line) => /milestone \d+/u.test(line)).length;
	const page = shown();
	assert.ok(page > 8, `shown ${page}`);
	ui.key("pageUp");
	assert.match(ui.component.render(100).find((line) => line.startsWith("│ →"))!, new RegExp(`milestone ${39 - page}\\b`, "u"));
});

test("one Down press scrolls an overflowing Overview", (t) => {
	const { host } = fixture();
	const ui = overlay(host, { rows: 14 });
	t.after(() => ui.component.dispose());
	const first = () => ui.text().split("\n")[4]!;
	const before = first();
	ui.key("down");
	assert.notEqual(first(), before);
	ui.key("pageDown"); ui.key("pageDown"); ui.key("pageDown"); ui.text();
	const end = first();
	ui.key("down");
	assert.equal(first(), end);
	ui.key("up");
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

test("Progress shows the live snapshot, the schedule and reviews newest first with verdict colours", (t) => {
	const { host, teamId, now } = fixture();
	withReviews(host, teamId, [reviewRecord("a1", 5, "on_track"), reviewRecord("b2", 10, "at_risk"), reviewRecord("c3", 15, "off_track"), reviewRecord("d4", 20, undefined, { summary: "Plain note." })], now() + 150_000);
	const tagged = taggingTheme();
	const ui = overlay(host, { theme: tagged.theme, now });
	t.after(() => ui.component.dispose());
	ui.key("right");
	const text = stripTerminalSequences(ui.text(120));
	assert.match(text, /\[Progress\]/u);
	assert.match(text, /Elapsed \d+:\d\d · works 0\/4 finished · 1 running · 2 waiting · 1 held · 0 finished since last review/u);
	assert.match(text, /Review: waiter every 5 min · next in 3m/u);
	assert.doesNotMatch(text, /Budget\s+activations|█/u, "the Overview's budget bars are not repeated here");
	const rows = text.split("\n").filter((line) => /\d+:\d\d  waiter  /u.test(line)).map((line) => line.replace(/^│\s+(→\s)?/u, "").replace(/\s*│$/u, ""));
	assert.deepEqual(rows.map((row) => row.replace(/\s+/gu, " ")), ["20:00 waiter no verdict Plain note.", "15:00 waiter off track Review c3 summary.", "10:00 waiter at risk Review b2 summary.", "5:00 waiter on track Review a1 summary."]);
	for (const [color, label] of [["success", "on track"], ["warning", "at risk"], ["error", "off track"], ["muted", "no verdict"]]) {
		assert.ok(tagged.calls.some((call) => call.color === color && call.text.trim() === label), label);
	}
});

test("Progress selection shows details and Enter opens the full review", (t) => {
	const { host, teamId } = fixture();
	withReviews(host, teamId, [reviewRecord("a1", 5, "on_track"), reviewRecord("b2", 10, "at_risk", {
		summary: "AT RISK: Two works wait.\nSecond summary line.", findings: ["held work blocks the lead", "no result for runner"], limitations: ["no tool output inspected"] })]);
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right"); ui.text();
	assert.match(ui.text(100), /→\s+10:00  waiter  at risk\s+Two works wait\./u);
	assert.match(ui.text(100), /review:b2 · waiter · at risk/u);
	assert.match(ui.text(100), /Findings: held work blocks the lead · no result for runner/u);
	assert.match(ui.text(100), /Limitations: no tool output inspected/u);
	assert.match(ui.text(100), /Snapshot: 10:00 · 1 finished since last review/u);
	assert.match(ui.text(100), /Works: 0\/4 resolved · 1 running · 1 blocked · 1 held · 0 failed · 0 cancelled/u);
	ui.key("down");
	assert.match(ui.text(100), /review:a1 · waiter · on track/u);
	assert.match(ui.text(100), /Findings: none/u);
	ui.key("up"); ui.key("enter");
	const detail = ui.text(100);
	assert.match(detail, /Review review:b2 · Esc back/u);
	assert.match(detail, /By: waiter · at risk · work:rb2@1 succeeded · result:rb2/u);
	assert.match(detail, /Second summary line\./u);
	assert.match(detail, /- held work blocks the lead/u);
	assert.match(detail, /Budget: teamActivations 5\/100 · teamToolCalls 9\/unlimited/u);
	assert.doesNotMatch(detail, /Review: waiter every/u);
	ui.key("escape");
	assert.match(ui.text(100), /Review: waiter every 5 min/u);
	assert.match(ui.text(100), /→\s+10:00  waiter  at risk/u);
});

test("Progress without reviews says so, and Review: off when none is scheduled", (t) => {
	const { host, teamId } = fixture();
	host.runtime.setReview(teamId, null);
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	const text = ui.text(100);
	assert.match(text, /Review: off/u);
	assert.match(text, /No reviews yet/u);
	assert.doesNotMatch(text, /│ →/u);
	ui.key("enter"); ui.key("down");
	assert.doesNotMatch(ui.text(100), /Esc back/u);
});

test("closed Teams from history show their recorded reviews and schedule", (t) => {
	const { host } = fixture();
	host.history.teams.push({ teamId: "old", version: 2, lifecycle: "closed", lead: "lead", members: ["lead", "waiter"], results: [], finalResultRefs: [], at: 1,
		review: { by: "waiter", everyMinutes: 10 }, reviews: [reviewRecord("h1", 10, "on_track"), reviewRecord("h2", 20, "off_track")] },
		{ teamId: "bare", version: 2, lifecycle: "closed", lead: "lead", members: ["lead"], results: [], finalResultRefs: [], at: 0 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	ui.component.handleInput("]");
	let text = ui.text(100);
	assert.match(text, /‹ 2\/3 › old/u);
	assert.match(text, /Review: waiter every 10 min/u);
	assert.doesNotMatch(text, /next in|Elapsed|Budget {2}/u);
	assert.match(text, /→\s+20:00  waiter  off track\s+Review h2 summary\./u);
	assert.match(text, /10:00  waiter  on track/u);
	ui.key("enter");
	assert.match(ui.text(100), /Review review:h2 · Esc back/u);
	ui.key("escape");
	ui.component.handleInput("]");
	text = ui.text(100);
	assert.match(text, /Review: off/u);
	assert.match(text, /No reviews yet/u);
	ui.key("tab");
	assert.match(ui.text(100), /Team bare · CLOSED/u);
});

test("Progress fits widths 60/80/120 and short terminals", () => {
	const { host, teamId } = fixture();
	const long = "x".repeat(300);
	withReviews(host, teamId, Array.from({ length: 12 }, (_, index) => reviewRecord(String(index), index * 7, (["on_track", "at_risk", "off_track", undefined] as const)[index % 4], { by: index % 2 ? "a-very-long-reviewer-alias" : "waiter", summary: `AT RISK: ${long}`, findings: [long], limitations: [long] })), Date.now() + 60_000);
	for (const rows of [40, 18, 14]) {
		const ui = overlay(host, { rows });
		ui.key("right");
		for (const width of [60, 80, 120]) {
			for (let step = 0; step < 3; step++) {
				const lines = ui.component.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) === width), `${rows}x${width}`);
				assert.ok(lines.length <= Math.floor(rows * 0.88), `${rows}x${width}: ${lines.length}`);
				// At 60 columns the wrapped help rows take the room the snapshot block yields to the list.
				if (rows >= 18 && width >= 80) assert.match(lines.join("\n"), /Review: waiter every 5 min/u);
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
	assert.match(ui.text(), /roots 0\/3 accepted · works 0\/4/u);
});

/** The popup is 92% of the terminal: 73 columns at 80. */
const POPUP_WIDTH = 73;
/** The text of each popup row, without the frame and its leading space. */
const rowsOf = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).slice(2, -1).trimEnd());
/** The row starting with `label` and the rows that continue it: indented under a label, or up to the next blank row for an unlabeled wrap. */
const rowBlock = (lines: string[], label: string, indented = true) => {
	const rows = rowsOf(lines);
	const start = rows.findIndex((row) => row.startsWith(label));
	assert.ok(start >= 0, label);
	const rest = rows.slice(start + 1);
	const end = rest.findIndex((row) => indented ? !/^ {8}\S/u.test(row) : row === "");
	return rows.slice(start, start + 1 + (end < 0 ? rest.length : end)).map((row) => row.trim()).join(" ");
};
/** The help rows: everything between the last blank row and the bottom border, without the lead-decision notice above them. */
const helpOf = (lines: string[]) => {
	const rows = rowsOf(lines).slice(0, -1);
	return rows.slice(rows.lastIndexOf("") + 1).filter((row) => !row.startsWith("Waiting for:"));
};

test("Overview shows the full Team ID, and every popup action key is named on its own help row that fits the 73-column popup", (t) => {
	const { host, teamId } = fixture();
	host.runtime.prepare({ members: [{ alias: "a", roleDescription: "A." }, { alias: "b", roleDescription: "B." }], lead: "a", brief: { goal: "Second Team." }, timeoutSeconds: null });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	const lines = ui.component.render(POPUP_WIDTH);
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
	assert.match(stripTerminalSequences(lines.join("\n")), new RegExp(`Team:\\s+${teamId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
	assert.deepEqual(helpOf(lines), ["↑↓ scroll · ←→/tab views · [ ] teams · esc close", "c cancel · r resume hold · g grant · m message · v revive · l new lead"],
		"navigation and the actions each on one line, none cut");
	assert.equal("c cancel · r resume hold · g grant · m message · v revive · l new lead".length, 70);
	// Wider hints wrap instead of being cut, and stay dim.
	const tagged = taggingTheme();
	for (const [tab, navigation] of [[2, "↑↓ select · enter details · ←→/tab views · [ ] teams · esc close"], [4, "↑↓ cursor · pgup/dn page · home/end · ←→/tab views · [ ] teams · esc close"]] as const) {
		const popup = overlay(host, { theme: tagged.theme });
		for (let index = 0; index < tab; index++) popup.component.handleInput("\t");
		tagged.calls.length = 0;
		const rendered = popup.component.render(POPUP_WIDTH);
		const help = helpOf(rendered);
		assert.equal(help.slice(0, -1).join(" "), navigation, `tab ${tab}: the navigation hint is whole`);
		assert.equal(help.at(-1), "c cancel · r resume hold · g grant · m message · v revive · l new lead");
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

const FLOW_STATS: TeamFlowStats = {
	slotLimit: 4, activeMs: 42 * 60_000, workersAvg: 1.6, workersRecent: 2.3, allSlotsShare: 0.06, leadBusyShare: 0.41, onlyLeadShare: 0.18,
	startP50: 0, startP90: 72_000, queued: { count: 2, oldestMs: 180_000, reason: "slots full" }, waitP50: 40_000, waitP90: 360_000,
	waited: [{ member: "fix-test", count: 9, ms: 42 * 60_000 }, { member: "fix-scroll", count: 4, ms: 10 * 60_000 }], acceptP50: 50_000, acceptP90: 180_000,
	pendingEvents: 2, tokensPerWork: 1_100_000, context: { member: "reviewer", tokens: 151_000 }, warn: { lead: false, queue: false, waits: false, cost: false },
};

test("Progress shows the Budget line only from 80%, the five flow rows and the legend, wrapped without truncation in the 73-column popup", (t) => {
	const { host, teamId } = fixture();
	host.runtime.flowStats = () => FLOW_STATS;
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	let lines = ui.component.render(POPUP_WIDTH);
	assert.doesNotMatch(lines.join("\n"), /Budget/u, "nothing below 80%");
	const rows = rowsOf(lines);
	const single = (label: string) => assert.ok(!/^ {8}\S/u.test(rows[rows.findIndex((row) => row.startsWith(label)) + 1]!), `${label} fits one line`);
	assert.equal(rowBlock(lines, "Flow "), "Flow    workers avg 1.6 (last 10m 2.3) · all 4 slots busy 6%");
	assert.equal(rowBlock(lines, "Lead "), "Lead    busy 41% · only lead 18% · accept p50 50s · p90 3.0m · 2 pending");
	assert.equal(rowBlock(lines, "Queue "), "Queue   start p50 0s · p90 1.2m · 2 queued, oldest 3.0m (slots full)");
	assert.equal(rowBlock(lines, "Waits "), "Waits   p50 40s · p90 6.0m · most: fix-test 9× 42m · fix-scroll 4× 10m");
	assert.equal(rowBlock(lines, "Cost "), "Cost    1.1M tokens/finished work · largest context reviewer 151k");
	assert.equal(rowBlock(lines, "Warn:", false), "Warn: only lead >25% · start p90 >2m, oldest >5m · top waited >50% · context >200k", "the legend wraps whole");
	for (const label of ["Flow ", "Queue ", "Waits ", "Cost "]) single(label);
	const order = ["Flow ", "Lead ", "Queue ", "Waits ", "Cost ", "Warn:"].map((label) => rows.findIndex((row) => row.startsWith(label)));
	assert.deepEqual([...order].sort((x, y) => x - y), order, "in the requested order");
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
	// Worst-case values wrap cleanly: every value is still there and nothing is cut.
	host.runtime.flowStats = () => ({ ...FLOW_STATS, workersAvg: 3.9, workersRecent: 3.9, allSlotsShare: 1, leadBusyShare: 1, onlyLeadShare: 1, acceptP50: 125 * 60_000, acceptP90: 125 * 60_000, pendingEvents: 100,
		queued: { count: 100, oldestMs: 125 * 60_000, reason: "member busy" }, startP50: 59_000, startP90: 9.9 * 60_000, waitP50: 59_000, waitP90: 125 * 60_000,
		waited: [{ member: "fix-test", count: 99, ms: 125 * 60_000 }, { member: "fix-scroll", count: 99, ms: 125 * 60_000 }, { member: "third", count: 1, ms: 1 }], tokensPerWork: 999_999_999 });
	lines = ui.component.render(POPUP_WIDTH);
	for (const line of lines) assert.equal(visibleWidth(line), POPUP_WIDTH);
	assert.doesNotMatch(lines.join("\n"), /…/u);
	assert.equal(rowBlock(lines, "Flow "), "Flow    workers avg 3.9 (last 10m 3.9) · all 4 slots busy 100%");
	assert.equal(rowBlock(lines, "Lead "), "Lead    busy 100% · only lead 100% · accept p50 125m · p90 125m · 100 pending");
	assert.equal(rowBlock(lines, "Queue "), "Queue   start p50 59s · p90 9.9m · 100 queued, oldest 125m (member busy)");
	assert.equal(rowBlock(lines, "Waits "), "Waits   p50 59s · p90 125m · most: fix-test 99× 125m · fix-scroll 99× 125m");
	assert.equal(rowBlock(lines, "Cost "), "Cost    1000M tokens/finished work · largest context reviewer 151k");
	assert.ok(rowsOf(lines).some((row) => /^ {8}\S/u.test(row)), "a row too wide for the popup continues under its text");
	const budget = host.runtime.inspectBudget(teamId);
	Object.assign(budget.used, { teamModelRequests: 85, teamActivations: 70 });
	Object.assign(budget.limits, { teamModelRequests: 100, teamActivations: 100, teamToolCalls: 1_000_000_000 });
	host.runtime.inspectBudget = () => budget;
	const text = stripTerminalSequences(ui.text(POPUP_WIDTH));
	assert.match(text, /^│ Budget 85% \(model requests\)/mu, "the highest counter only");
	assert.doesNotMatch(text, /Budget {2}|░/u);
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
		return tagged.calls.filter((call) => call.color === "warning" && /^(Flow|Queue|Waits|Lead|Cost) /u.test(call.text)).map((call) => call.text.slice(0, 5).trim());
	};
	assert.deepEqual(colored(FLOW_STATS), []);
	assert.deepEqual(colored({ ...FLOW_STATS, warn: { lead: true, queue: true, waits: true, cost: true } }), ["Lead", "Queue", "Waits", "Cost"], "the Flow row has no threshold");
	assert.deepEqual(colored({ ...FLOW_STATS, warn: { ...FLOW_STATS.warn, lead: true } }), ["Lead"], "the Lead row carries the only-lead warning");
	assert.deepEqual(colored({ ...FLOW_STATS, warn: { ...FLOW_STATS.warn, waits: true } }), ["Waits"]);
	assert.ok(tagged.calls.some((call) => call.color === "dim" && call.text.startsWith("Warn:")), "the legend is dim");
});

test("without data (a Team not launched yet) the flow rows show —", (t) => {
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [], { createId: () => "x" });
	host.runtime.prepare({ members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w", roleDescription: "Work." }], lead: "lead", brief: { goal: "Idle." }, timeoutSeconds: null });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("right");
	const text = stripTerminalSequences(ui.text(120));
	assert.match(text, /Flow {4}workers avg — \(last 10m —\) · all 4 slots busy —/u);
	assert.match(text, /Lead {4}busy — · only lead — · accept p50 — · p90 — · 0 pending/u);
	assert.match(text, /Queue {3}start p50 — · p90 — · none queued/u);
	assert.match(text, /Waits {3}p50 — · p90 — · most: —/u);
	assert.match(text, /Cost {4}— tokens\/finished work · largest context —/u);
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
	assert.match(text, /with-flo/u);
	assert.match(text, /Flow {4}workers avg 1\.2 · only lead 25% · start delay p90 19s · waits p90 4\.5m · most waited: rpc 26×/u);
	assert.doesNotMatch(text, /Queue {3}|Warn:/u);
	ui.component.handleInput("]");
	text = stripTerminalSequences(ui.text(120));
	assert.match(text, /no-flow/u);
	assert.doesNotMatch(text, /Flow {4}/u);
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
