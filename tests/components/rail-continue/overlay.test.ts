import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { RailContinueController, RailContinueSnapshot, RailContinueTask } from "../../../commands/rail-continue-scheduler";
import { RailContinueOverlayComponent, openRailContinueOverlay } from "../../../components/rail-continue";

const keys = { enter: "\r", escape: "\x1b", tab: "\t", backTab: "\x1b[Z", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F" };
const EPOCH = 1_700_000_000_000;
const task = (id: string, message = "Continue My WORK\n继续检查", offset = 60_000): RailContinueTask => ({ id, message, intervalMs: 60_000, createdAt: EPOCH, nextCheckAt: EPOCH + offset, resetCount: 0 });

function fixture(options: { tasks?: RailContinueTask[]; rows?: number; bindings?: Record<string, string>; colored?: boolean; busyReason?: string } = {}) {
	let now = EPOCH;
	let active = true;
	let renders = 0;
	let closes = 0;
	let removed = 0;
	let next = 0;
	const tasks = options.tasks ?? [task("cont-1"), task("cont-2", "Second Task")];
	const listeners = new Set<() => void>();
	const cancelled: string[] = [];
	const creates: Array<{ intervalMs: number; message: string }> = [];
	const bindings = { "tui.select.up": keys.up, "tui.select.down": keys.down, "tui.select.confirm": keys.enter, "tui.select.cancel": keys.escape, "tui.input.submit": keys.enter, ...options.bindings };
	const emit = () => { for (const listener of listeners) listener(); };
	const snapshot = (): RailContinueSnapshot => ({ tasks: tasks.map((entry) => ({ ...entry })), active, ...(options.busyReason ? { busyReason: options.busyReason } : {}) });
	const controller: RailContinueController = {
		snapshot,
		create(intervalMs, message) {
			creates.push({ intervalMs, message });
			const entry = { ...task(`created-${++next}`, message), createdAt: now, nextCheckAt: now + intervalMs, intervalMs };
			tasks.push(entry); emit(); return entry;
		},
		cancel(id) {
			cancelled.push(id);
			const index = tasks.findIndex((entry) => entry.id === id);
			if (index < 0) return false;
			tasks.splice(index, 1); emit(); return true;
		},
		cancelAll() { const count = tasks.length; tasks.splice(0); emit(); return count; },
		subscribe(listener) { listeners.add(listener); return () => { removed++; listeners.delete(listener); }; },
	};
	const theme = { fg: (_color: string, text: string) => options.colored ? `\x1b[32m${text}\x1b[39m` : text, bold: (text: string) => text };
	const tui = { terminal: { rows: options.rows ?? 30 }, requestRender: () => { renders++; } };
	const component = new RailContinueOverlayComponent(tui as any, theme as any, { matches: (data: string, action: string) => bindings[action as keyof typeof bindings] === data } as any, () => { closes++; }, controller, () => now);
	return { component, controller, tasks, tui, creates, cancelled, listeners, emit, setNow: (value: number) => { now = value; }, deactivate: () => { active = false; emit(); }, key: (key: keyof typeof keys) => component.handleInput(keys[key]), text: (width = 100) => stripTerminalSequences(component.render(width).join("\n")), renders: () => renders, closes: () => closes, removed: () => removed };
}

function editDraft(ui: ReturnType<typeof fixture>, duration: string, message: string) {
	ui.component.handleInput("n");
	ui.component["durationInput"].setValue(duration);
	ui.key("enter");
	ui.component.handleInput(`\x1b[200~${message}\x1b[201~`);
}

function arm(ui: ReturnType<typeof fixture>) { ui.key("tab"); ui.key("enter"); }

test("pending shows stable IDs, next CHECK, interval, resets/reason, preview and scrollable full detail", (t) => {
	const long = Array.from({ length: 60 }, (_, index) => `第${index}行 /LiteralCase-${index}`).join("\n");
	const entry = { ...task("cont-stable", long), resetCount: 2, lastCheckReason: "session busy" };
	const ui = fixture({ tasks: [entry], rows: 18 }); t.after(() => ui.component.dispose());
	const pending = ui.text(120);
	assert.match(pending, /cont-stable · CHECK 1:00 · every 1m · resets 2/u);
	assert.match(pending, /session busy · 第0行/u);
	assert.doesNotMatch(pending, /execution at|will execute/u);
	ui.key("enter");
	assert.match(ui.text(120), /Task cont-stable/u);
	assert.match(ui.text(120), /Next CHECK: 1:00/u);
	assert.match(ui.text(120), /not a guaranteed execution time/u);
	assert.match(ui.text(120), /Last check: session busy/u);
	ui.key("end");
	assert.match(ui.text(120), /第59行 \/LiteralCase-59/u);
	assert.doesNotMatch(ui.text(120), /Task cont-stable/u);
	ui.key("home");
	assert.match(ui.text(120), /Task cont-stable/u);
	ui.key("pageDown");
	const paged = ui.text(120);
	assert.notEqual(paged, pending);
	ui.key("pageUp");
	assert.match(ui.text(120), /Task cont-stable/u);
	ui.key("escape");
	assert.match(ui.text(120), /\[Pending 1\]/u);
	assert.equal(ui.closes(), 0);
});

test("safe deadlines beyond the JS calendar range keep the countdown without Invalid Date", (t) => {
	const entry = { ...task("far-future"), intervalMs: Number.MAX_SAFE_INTEGER - EPOCH, nextCheckAt: Number.MAX_SAFE_INTEGER };
	const ui = fixture({ tasks: [entry] }); t.after(() => ui.component.dispose());
	ui.key("enter");
	const detail = ui.text(160);
	assert.match(detail, /Next CHECK: \d+:\d\d · beyond calendar range/u);
	assert.doesNotMatch(detail, /Invalid Date/u);
	assert.match(detail, /Created:/u);
});

test("explicit Arm starts immediately while busy; Enter edits multiline Chinese and preserves message case/slash/whitespace", (t) => {
	const ui = fixture({ tasks: [], busyReason: "agent working" }); t.after(() => ui.component.dispose());
	ui.component.focused = true;
	assert.match(ui.text(), /Last check · agent working/u);
	const message = "  /LiteralCase\n继续处理 中文  \nThird LINE";
	editDraft(ui, "2s", message);
	assert.deepEqual(ui.creates, []);
	assert.equal(ui.component["messageEditor"].getExpandedText(), message);
	ui.key("enter");
	assert.equal(ui.component["messageEditor"].getExpandedText(), `${message}\n`);
	assert.deepEqual(ui.creates, []);
	ui.setNow(EPOCH + 1234);
	arm(ui);
	assert.deepEqual(ui.creates, [{ intervalMs: 2000, message: `${message}\n` }]);
	assert.equal(ui.tasks[0]!.nextCheckAt, EPOCH + 3234);
	assert.match(ui.text(), /Armed created-1 · next CHECK in 2s/u);
	assert.match(ui.text(), /→ created-1/u);
	assert.equal(ui.component["messageEditor"].getExpandedText(), "");
	ui.key("enter"); ui.key("enter");
	assert.equal(ui.creates.length, 1, "double Enter after Arm cannot create a duplicate");
});

test("invalid duration, empty message and create rejection retain editable drafts", (t) => {
	const ui = fixture({ tasks: [] }); t.after(() => ui.component.dispose());
	editDraft(ui, "0s", "继续 /CaseSensitive");
	arm(ui);
	assert.deepEqual(ui.creates, []);
	assert.equal(ui.component["durationInput"].getValue(), "0s");
	assert.equal(ui.component["messageEditor"].getExpandedText(), "继续 /CaseSensitive");
	assert.equal(ui.component["tab"], "create");
	assert.ok(ui.component["notice"]);
	ui.component["durationInput"].setValue("1");
	ui.component["messageEditor"].setText(" \n ");
	ui.key("enter");
	assert.match(ui.text(), /Message cannot be empty/u);
	assert.equal(ui.component["messageEditor"].getExpandedText(), " \n ");
	ui.component["messageEditor"].setText("Keep This\n中文");
	ui.controller.create = () => { throw new Error("Session ownership changed"); };
	ui.key("enter");
	assert.match(ui.text(), /Session ownership changed/u);
	assert.equal(ui.component["messageEditor"].getExpandedText(), "Keep This\n中文");
	ui.key("escape");
	assert.equal(ui.component["tab"], "pending");
	ui.component.handleInput("n");
	assert.equal(ui.component["messageEditor"].getExpandedText(), "Keep This\n中文");
});

test("cancellation confirms a stable ID and never retargets after reordering/removal", (t) => {
	const ui = fixture(); t.after(() => ui.component.dispose());
	ui.component.handleInput("d");
	assert.match(ui.text(), /Cancel task cont-1\?/u);
	assert.deepEqual(ui.cancelled, []);
	ui.tasks.reverse(); ui.emit();
	ui.component.handleInput("y");
	assert.deepEqual(ui.cancelled, ["cont-1"]);
	assert.deepEqual(ui.tasks.map((entry) => entry.id), ["cont-2"]);
	ui.component.handleInput("d");
	ui.tasks.splice(0, 1); ui.tasks.push(task("replacement")); ui.emit();
	ui.component.handleInput("y");
	assert.deepEqual(ui.cancelled, ["cont-1", "cont-2"]);
	assert.deepEqual(ui.tasks.map((entry) => entry.id), ["replacement"]);
	assert.match(ui.text(), /cont-2 is no longer pending/u);
	ui.component.handleInput("d"); ui.key("escape");
	assert.equal(ui.cancelled.length, 2);
	ui.key("enter"); ui.component.handleInput("d"); ui.component.handleInput("n");
	assert.equal(ui.cancelled.length, 2);
});

test("subscription updates preserve selected ID, close stale detail and expose new reset reason", (t) => {
	const ui = fixture(); t.after(() => ui.component.dispose());
	ui.key("down");
	assert.equal(ui.component["selectedId"], "cont-2");
	ui.tasks.reverse(); ui.tasks[0]!.resetCount = 3; ui.tasks[0]!.lastCheckReason = "queued messages"; ui.emit();
	assert.match(ui.text(), /→ cont-2/u);
	assert.match(ui.text(), /resets 3/u);
	assert.match(ui.text(), /queued messages/u);
	ui.key("enter");
	ui.tasks.splice(0, 1); ui.emit();
	assert.equal(ui.component["detailId"], undefined);
	assert.match(ui.text(), /→ cont-1/u);
});

test("countdown ticks only with tasks; dispose unsubscribes once and closing never cancels scheduler", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const ui = fixture({ tasks: [] });
	const start = ui.renders();
	t.mock.timers.tick(3000);
	assert.equal(ui.renders(), start);
	ui.tasks.push(task("timer")); ui.emit();
	const armed = ui.renders();
	ui.setNow(EPOCH + 1000); t.mock.timers.tick(1000);
	assert.equal(ui.renders(), armed + 1);
	assert.match(ui.text(), /CHECK 59s/u);
	ui.tasks.splice(0); ui.emit();
	const empty = ui.renders();
	t.mock.timers.tick(3000);
	assert.equal(ui.renders(), empty);
	ui.tasks.push(task("kept")); ui.emit();
	const listener = [...ui.listeners][0]!;
	ui.key("escape");
	assert.equal(ui.closes(), 1);
	assert.equal(ui.removed(), 1);
	assert.equal(ui.listeners.size, 0);
	assert.deepEqual(ui.cancelled, []);
	assert.deepEqual(ui.tasks.map((entry) => entry.id), ["kept"]);
	const closed = ui.renders();
	ui.component.dispose(); listener(); t.mock.timers.tick(5000);
	ui.component.handleInput("y");
	assert.equal(ui.removed(), 1);
	assert.equal(ui.renders(), closed);
});

test("inactive controller closes and cleans up; a stale requestRender cannot escape a timer callback", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const inactive = fixture();
	inactive.deactivate(); inactive.deactivate();
	assert.equal(inactive.closes(), 1);
	assert.equal(inactive.removed(), 1);
	const stale = fixture();
	stale.tui.requestRender = () => { throw new Error("old context"); };
	assert.doesNotThrow(() => t.mock.timers.tick(1000));
	assert.equal(stale.removed(), 1);
	assert.doesNotThrow(() => t.mock.timers.tick(5000));
	inactive.component.dispose(); stale.component.dispose();
});

test("configurable select keys work in pending/detail without stealing ordinary form text", (t) => {
	const ui = fixture({ bindings: { "tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "e", "tui.select.cancel": "q" } });
	t.after(() => ui.component.dispose());
	ui.component.handleInput("j"); ui.component.handleInput("e");
	assert.match(ui.text(), /Task cont-2/u);
	ui.component.handleInput("q"); ui.component.handleInput("n");
	ui.key("enter");
	for (const character of "equal quick 中文") ui.component.handleInput(character);
	assert.equal(ui.component["messageEditor"].getExpandedText(), "equal quick 中文");
	ui.key("escape"); ui.component.handleInput("q");
	assert.equal(ui.closes(), 1);
});

test("native Input/Editor focus and IME cursor survive tab, resize and narrow/short terminal clipping", (t) => {
	const ui = fixture({ tasks: [], colored: true }); t.after(() => ui.component.dispose());
	ui.component.focused = true;
	ui.component.handleInput("n");
	assert.equal(ui.component["durationInput"].focused, true);
	for (const width of [4, 8, 12, 35, 73]) assert.ok(ui.component.render(width).some((line) => line.includes(CURSOR_MARKER)), `duration cursor at ${width}`);
	ui.key("tab");
	assert.equal(ui.component["durationInput"].focused, false);
	assert.equal(ui.component["messageEditor"].focused, true);
	ui.component.handleInput(`\x1b[200~${"中文🧪 LONG message\n".repeat(40)}末尾\x1b[201~`);
	for (const rows of [8, 10, 12, 15, 22, 30, 60]) {
		ui.tui.terminal.rows = rows;
		for (const width of [8, 12, 20, 35, 60, 73, 120]) {
			const lines = ui.component.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${rows} rows x ${width} columns`);
			assert.ok(lines.length <= Math.min(Math.floor(rows * 0.88), rows - 2), `${rows} rows: ${lines.length}`);
			assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)), `IME cursor clipped at ${rows} x ${width}`);
		}
	}
	ui.component.focused = false;
	assert.equal(ui.component["messageEditor"].focused, false);
	assert.ok(ui.component.render(73).every((line) => !line.includes(CURSOR_MARKER)));
	ui.component.focused = true;
	ui.key("tab");
	assert.equal(ui.component["messageEditor"].focused, false);
	assert.ok(ui.component.render(73).every((line) => !line.includes(CURSOR_MARKER)));
	ui.key("backTab");
	assert.equal(ui.component["messageEditor"].focused, true);
	ui.component.dispose();
	assert.equal(ui.component["messageEditor"].focused, false);
});

test("all views remain within width 1–160 and dynamic height, with full Unicode detail accessible", (t) => {
	const ui = fixture({ tasks: [task("a-stable-long-id", "中文🧪".repeat(90)), task("another-id")], colored: true });
	t.after(() => ui.component.dispose());
	for (const view of ["pending", "detail", "confirm", "create"] as const) {
		if (view === "detail") ui.key("enter");
		if (view === "confirm") ui.component.handleInput("d");
		if (view === "create") { ui.key("escape"); ui.key("escape"); ui.component.handleInput("n"); }
		for (const rows of [6, 8, 12, 18, 40]) {
			ui.tui.terminal.rows = rows;
			for (const width of [1, 2, 3, 4, 8, 12, 35, 60, 73, 160]) {
				const lines = ui.component.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `${view} ${rows}x${width}`);
				assert.ok(lines.length <= Math.min(Math.floor(rows * 0.88), rows - 2), `${view} ${rows}x${width} height ${lines.length}`);
			}
		}
	}
});

test("open helper uses a centered native overlay and never opens an inactive controller", async () => {
	const ui = fixture({ tasks: [] });
	let options: any;
	let component: RailContinueOverlayComponent | undefined;
	let done: (() => void) | undefined;
	const ctx = { ui: { custom: async (factory: (...args: any[]) => RailContinueOverlayComponent, opts: unknown) => {
		options = opts;
		component = factory(ui.tui, { fg: (_: string, text: string) => text, bold: (text: string) => text }, { matches: () => false }, () => done?.());
	} } };
	try {
		await openRailContinueOverlay(ctx as any, ui.controller);
		assert.equal(options.overlay, true);
		assert.equal(options.overlayOptions.anchor, "center");
		assert.equal(options.overlayOptions.width, "92%");
		assert.equal(options.overlayOptions.maxHeight, "88%");
		assert.ok(component instanceof RailContinueOverlayComponent);
		ui.deactivate();
		options = undefined;
		await openRailContinueOverlay(ctx as any, ui.controller);
		assert.equal(options, undefined);
	} finally { component?.dispose(); ui.component.dispose(); }
});
