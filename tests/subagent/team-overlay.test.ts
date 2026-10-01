import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SessionBroker } from "../../tools/subagents/session-broker";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import { TeamOverlayComponent, buildTeamTaskRows, type TeamOverlayAction } from "../../tools/subagents/team-overlay";
import type { RuntimeActivation } from "../../tools/subagents/team-runtime";
import type { TeamWorkSummary } from "../../tools/subagents/team-protocol";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = { tab: "\t", backTab: "\x1b[Z", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", escape: "\x1b", pageUp: "\x1b[5~", pageDown: "\x1b[6~" };

function fixture(children = 1) {
	let id = 0;
	let time = 1_700_000_000_000;
	const host = new TeamSessionHost({} as SessionBroker, () => undefined, [], { createId: () => `id${++id}`, now: () => time += 1000 });
	const { teamId } = host.runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." },
		workers: ["runner", "waiter", "held"].map((alias) => ({ alias, roleDescription: "Work." })),
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

function overlay(host: TeamSessionHost, options: { rows?: number; now?: () => number } = {}) {
	let renders = 0;
	const closed: Array<TeamOverlayAction | undefined> = [];
	const tui = { requestRender: () => renders++, terminal: { rows: options.rows ?? 40 } };
	const component = new TeamOverlayComponent(tui as any, theme, { matches: () => false } as any, (action) => closed.push(action), host, options.now);
	return { component, closed, tui, renders: () => renders, text: (width = 120) => component.render(width).join("\n"), key: (key: keyof typeof keys) => component.handleInput(keys[key]) };
}

test("four views show real running, waiting and held work, routes and attention", (t) => {
	const { host, now } = fixture();
	const ui = overlay(host, { now });
	t.after(() => ui.component.dispose());
	assert.match(ui.text(), /ACTIVE · needs attention · elapsed \d+:\d\d/u);
	assert.match(ui.text(), /Progress: roots 0\/3 accepted · works 0\/4 done · 0 cancelled/u);
	assert.match(ui.text(), /Waiting for: Manager decision/u);
	assert.match(ui.text(), /Attention: 1 open holds/u);
	assert.match(ui.text(), /Budget: activations/u);
	ui.key("tab");
	assert.match(ui.text(), /▶ runner · running work .*lead → runner → lead/u);
	assert.match(ui.text(), /⧗ waiter · waiting on 1 sub-task: runner/u);
	assert.match(ui.text(), /⏸ held · held · asks: "Which requirements\?"/u);
	ui.key("tab");
	assert.match(ui.text(), /Tasks · roots 0\/3 accepted · works 0\/4 done/u);
	assert.match(ui.text(), /  ○ work:.*runner ← waiter.*Check child 1/u);
	ui.key("tab");
	assert.match(ui.text(), /0:00 launch/u);
	assert.match(ui.text(), /waiter requested work/u);
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
	assert.match(ui.text(), /result → lead · awaiting review/u);
	assert.match(ui.text(), /Popup implemented\./u);
});

test("Tasks fold more than five children, expand with Enter, and collapse again", (t) => {
	const { host } = fixture(6);
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("tab"); ui.key("tab");
	assert.match(ui.text(), /✓ 6 sub-tasks \(runner 6\) · 0 done \[\+\]/u);
	assert.doesNotMatch(ui.text(), /Check child 6/u);
	ui.key("down"); ui.key("down"); ui.text(); ui.key("enter");
	assert.match(ui.text(), /Check child 6/u);
	assert.match(ui.text(), /\[−\]/u);
	ui.key("enter");
	assert.doesNotMatch(ui.text(), /Check child 6/u);
});

test("task rows preserve nesting across parent revisions and use state/review icons", () => {
	const root: TeamWorkSummary = { work: { workId: "work:root", revision: 2 }, requester: "lead", assignee: "gate", state: "resolved", review: "accepted", taskPreview: "Root", resultRef: "result:one" };
	const children = ["resolved", "running", "blocked", "failed", "cancelled", "superseded", "queued"] as const;
	const works: TeamWorkSummary[] = [root, ...children.map((state, index) => ({ work: { workId: `work:c${index}`, revision: 1 }, parent: { ...root.work, revision: 1 }, requester: "gate", assignee: index % 2 ? "rpc" : "reviewer", state, taskPreview: `Child\n${index}` }))];
	const rows = buildTeamTaskRows(works, new Set([root.work.workId]), theme);
	assert.match(rows[0]!.text, /^✓ work:root@2.*resolved\/accepted · result:one$/u);
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
	host.runtime.messageManager(teamId, "New review instruction");
	await Promise.resolve();
	assert.ok(ui.renders() > before);
	const changed = ui.renders();
	activity!();
	assert.equal(ui.renders(), changed + 1);
	ui.component.dispose(); ui.component.dispose();
	assert.equal(removed, 1);
	host.runtime.messageManager(teamId, "After dispose"); activity!();
	await Promise.resolve();
	assert.equal(ui.renders(), changed + 1);
});

test("all views and details fit widths 60–200 and respect a short terminal", (t) => {
	const { host } = fixture(6);
	const ui = overlay(host, { rows: 18 });
	t.after(() => ui.component.dispose());
	for (let view = 0; view < 4; view++) {
		for (const width of [60, 100, 120, 200]) {
			const lines = ui.component.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.length <= Math.floor(18 * 0.88));
			assert.ok(lines.at(-1)?.startsWith("╰"));
		}
		ui.key("tab");
	}
	ui.key("tab"); ui.text(); ui.key("down"); ui.key("down"); ui.text(); ui.key("enter");
	assert.ok(ui.component.render(60).every((line) => visibleWidth(line) <= 60));
});

test("narrow member rows retain routes and time; long Unicode task previews retain result status", (t) => {
	const { host } = fixture();
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	ui.key("tab");
	assert.match(ui.text(60), /lead → held → lead · 0:00/u);
	const root: TeamWorkSummary = { work: { workId: "work:root", revision: 1 }, requester: "lead", assignee: "w1", state: "resolved", review: "accepted", taskPreview: "检查🧪".repeat(100), resultRef: "r1" };
	const colored = { ...theme, fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m` } as Theme;
	for (const width of [60, 120]) {
		const row = buildTeamTaskRows([root], new Set(), colored, width)[0]!;
		assert.ok(visibleWidth(row.text) <= width);
		assert.match(row.text, /resolved\/accepted · r1$/u);
	}
});

test("long Tasks lists keep selection visible; Timeline pages from newest to oldest", (t) => {
	const { host } = fixture(6);
	const ui = overlay(host, { rows: 14 });
	t.after(() => ui.component.dispose());
	ui.key("tab"); ui.key("tab"); ui.text();
	ui.key("down"); ui.key("down"); ui.text(); ui.key("enter"); ui.text();
	for (let index = 0; index < 10; index++) { ui.key("down"); ui.text(); }
	assert.match(ui.text(), /› ⏸ work:.*held ← lead/u);
	ui.key("tab");
	assert.match(ui.text(), /held ended work/u);
	assert.doesNotMatch(ui.text(), /0:00 launch/u);
	for (let index = 0; index < 10; index++) { ui.key("pageUp"); ui.text(); }
	assert.match(ui.text(), /0:00 launch/u);
	for (let index = 0; index < 10; index++) { ui.key("pageDown"); ui.text(); }
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
	const { host, teamId } = fixture();
	host.runtime.prepare({ manager: { alias: "other", roleDescription: "Manage." }, workers: [{ alias: "worker", roleDescription: "Work." }], brief: { goal: "Prepared" }, timeoutSeconds: null });
	host.history.teams.push({ teamId: "old", version: 2, lifecycle: "interrupted", manager: "lead", workers: ["worker"], results: [], finalResultRefs: [], at: 1 },
		{ teamId: "recent", version: 2, lifecycle: "closed", manager: "lead", workers: ["worker"], goal: "Historic goal", results: [], finalResultRefs: [], at: 2 });
	const ui = overlay(host);
	t.after(() => ui.component.dispose());
	assert.match(ui.text(), new RegExp(`Teams 1/4 · ${teamId}`, "u"));
	ui.key("right"); ui.key("right");
	assert.match(ui.text(), /Team recent · CLOSED · history \(read-only\)/u);
	ui.component.handleInput("c");
	assert.equal(ui.closed.length, 0);
	ui.component.handleInput("]");
	assert.match(ui.text(), /Team old · INTERRUPTED/u);
	ui.component.handleInput("["); ui.key("left"); ui.key("left");
	assert.match(ui.text(), new RegExp(`Team ${teamId} · ACTIVE`, "u"));
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
