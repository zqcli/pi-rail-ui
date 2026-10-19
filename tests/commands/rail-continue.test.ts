import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
	formatRailContinueCountdown,
	installRailContinue,
	onRailContinueChange,
	parseRailContinueCommand,
	parseRailContinueDuration,
	railContinueLabel,
	railContinueStatus,
} from "../../commands/rail-continue";

function harness(t: TestContext) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const notices: Array<[string, string]> = [];
	const statuses = new Map<string, string>();
	const sends: Array<[string, unknown]> = [];
	let idle = true;
	let pending = false;
	let idleChecks = 0;
	let waitCalls = 0;
	let id = "session-a";
	let stale = false;
	const manager: any = { getSessionId: () => id };
	const ctx: any = {
		mode: "tui", hasUI: true,
		get sessionManager() { if (stale) throw new Error("retired runtime"); return manager; },
		isIdle: () => { idleChecks++; return idle; },
		hasPendingMessages: () => pending,
		waitForIdle: () => { waitCalls++; throw new Error("arming must never wait for idle"); },
		ui: {
			notify: (text: string, level: string) => notices.push([text, level]),
			setStatus: (key: string, value?: string) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
			custom: async () => {},
		},
	};
	const pi: any = {
		on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendUserMessage: (message: string, options: unknown) => { sends.push([message, options]); },
	};
	installRailContinue(pi);
	const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	const command = (args: string) => commands.get("rail-continue").handler(args, ctx);
	t.after(async () => { await emit("session_shutdown"); });
	return {
		pi, ctx, manager, notices, statuses, sends, commands, handlers, emit, command,
		setIdle(value: boolean) { idle = value; }, setPending(value: boolean) { pending = value; },
		setId(value: string) { id = value; }, setStale(value: boolean) { stale = value; },
		get idleChecks() { return idleChecks; }, get waitCalls() { return waitCalls; },
	};
}

test("duration and command parser accept safe integer units and preserve literal multiline messages", () => {
	assert.equal(parseRailContinueDuration("2"), 120_000);
	assert.equal(parseRailContinueDuration("30s"), 30_000);
	assert.equal(parseRailContinueDuration("3M"), 180_000);
	assert.equal(parseRailContinueDuration("1h"), 3_600_000);
	assert.equal(parseRailContinueDuration("2147484s"), 2_147_484_000, "long waits are chunked, not arbitrarily capped");
	for (const value of ["", "0", "0s", "-1m", "+1s", "1.5h", "1ms", "1e3", "Infinity", "9007199254740992s"]) {
		assert.throws(() => parseRailContinueDuration(value), value);
	}
	assert.deepEqual(parseRailContinueCommand(""), { action: "open" });
	assert.deepEqual(parseRailContinueCommand(" STATUS \n"), { action: "status" });
	assert.deepEqual(parseRailContinueCommand("cancel ALL"), { action: "cancel", id: "all" });
	assert.deepEqual(parseRailContinueCommand("cancel Task-A"), { action: "cancel", id: "Task-A" });
	const message = "/DoNotExpand Mixed CASE 中文\n第二行\n  retain indent  ";
	assert.deepEqual(parseRailContinueCommand(`30s ${message}`), { action: "create", intervalMs: 30_000, message });
	for (const value of ["status extra", "cancel", "cancel a b", "5m", "5m  \n  ", "0s message"]) assert.throws(() => parseRailContinueCommand(value));
});

test("arming while busy starts immediately; normal events do not poll/reset; becoming idle never sends early", async (t) => {
	const h = harness(t);
	await h.emit("session_start");
	h.setIdle(false);
	await h.command("10s 继续检查 MixedCase");
	assert.equal(h.waitCalls, 0);
	assert.equal(h.idleChecks, 0);
	assert.equal(railContinueLabel(h.manager), "CONT-1-1m");
	t.mock.timers.tick(3000);
	for (const event of ["input", "before_agent_start", "agent_start", "message_start", "message_end", "turn_start", "turn_end", "agent_end", "agent_settled"]) {
		await h.emit(event, { message: { role: "assistant", stopReason: "stop" } });
	}
	assert.equal(h.idleChecks, 0);
	assert.equal(railContinueLabel(h.manager), "CONT-1-1m");
	h.setIdle(true);
	await h.emit("agent_end");
	t.mock.timers.tick(6999);
	assert.equal(h.sends.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(h.sends, [["继续检查 MixedCase", { expandPromptTemplates: false }]]);
	assert.equal(h.idleChecks, 1);
	assert.equal(railContinueLabel(h.manager), undefined);
	assert.equal(h.statuses.has("rail-continue"), false);
	t.mock.timers.tick(100_000);
	assert.equal(h.sends.length, 1, "a consumed task never sends periodically");
});

test("busy and queued deadline checks restart a full interval and expose reset reasons", async (t) => {
	const h = harness(t);
	await h.emit("session_start");
	h.setIdle(false);
	await h.command("5s delayed");
	t.mock.timers.tick(5000);
	assert.equal(h.sends.length, 0);
	assert.match(railContinueStatus(h.manager), /resets 1 \(session busy\)/);
	assert.equal(railContinueLabel(h.manager), "CONT-1-1m");
	h.setIdle(true);
	h.setPending(true);
	t.mock.timers.tick(5000);
	assert.match(railContinueStatus(h.manager), /resets 2 \(pending messages\)/);
	h.setPending(false);
	t.mock.timers.tick(4999);
	assert.equal(h.sends.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.sends.length, 1);
});

test("multiple tasks are independent; same-deadline submissions never burst; cancel IDs remain stable", async (t) => {
	const h = harness(t);
	await h.emit("session_start");
	await h.command("2s first");
	await h.command("2s second");
	await h.command("3s third");
	assert.match(railContinueStatus(h.manager), /1 · CHECK.*\n  first/);
	assert.match(railContinueStatus(h.manager), /2 · CHECK.*\n  second/);
	await h.command("cancel 3");
	t.mock.timers.tick(2000);
	assert.deepEqual(h.sends.map(([message]) => message), ["first"]);
	assert.match(railContinueStatus(h.manager), /2 · CHECK.*resets 1 \(another task submitted/);
	await h.command("status");
	assert.match(h.notices.at(-1)![0], /Next CHECK is not a guaranteed send time/);
	await h.command("cancel 2");
	t.mock.timers.tick(100_000);
	assert.equal(h.sends.length, 1);
	await h.command("1s next");
	assert.match(railContinueStatus(h.manager), /4 · CHECK/);
	await h.command("cancel all");
	assert.equal(railContinueLabel(h.manager), undefined);
});

test("one public synchronous send failure consumes the task without retry or queued deliverAs", async (t) => {
	const h = harness(t);
	h.pi.sendUserMessage = (message: string, options: unknown) => { h.sends.push([message, options]); throw new Error("failed preflight"); };
	await h.emit("session_start");
	await h.command("1s /Literal\n中文");
	t.mock.timers.tick(1000);
	assert.deepEqual(h.sends, [["/Literal\n中文", { expandPromptTemplates: false }]]);
	assert.equal(railContinueLabel(h.manager), undefined);
	assert.match(h.notices.at(-1)![0], /task consumed\/canceled; no automatic send retry.*failed preflight/);
	t.mock.timers.tick(100_000);
	assert.equal(h.sends.length, 1);
});

test("failed idle checks report a pending full-interval retry, never a consumed submission", async (t) => {
	const h = harness(t);
	await h.emit("session_start");
	await h.command("2s still pending");
	const original = h.ctx.isIdle;
	h.ctx.isIdle = () => { throw new Error("idle probe failed"); };
	t.mock.timers.tick(2000);
	assert.equal(h.sends.length, 0);
	assert.match(h.notices.at(-1)![0], /check failed; task remains pending.*idle probe failed/);
	assert.equal(railContinueLabel(h.manager), "CONT-1-1m");
	h.ctx.isIdle = original;
	t.mock.timers.tick(2000);
	assert.equal(h.sends.length, 1);
});

for (const event of ["session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "session_tree"]) {
	test(`${event} invalidates timers; session_start and explicit rearming never restore authorization`, async (t) => {
		const h = harness(t);
		await h.emit("session_start");
		await h.command("1s old authorization");
		await h.emit(event, { reason: "reload" });
		assert.equal(railContinueLabel(h.manager), undefined);
		t.mock.timers.tick(10_000);
		assert.equal(h.sends.length, 0);
		await h.emit("session_start", { reason: "reload" });
		assert.equal(railContinueLabel(h.manager), undefined);
		await h.command("1s new authorization");
		t.mock.timers.tick(1000);
		assert.equal(h.sends[0]?.[0], "new authorization");
	});
}

test("session ID mutation or stale guarded context cannot deliver old work", async (t) => {
	const h = harness(t);
	await h.emit("session_start");
	await h.command("1s wrong session");
	h.setId("session-b");
	t.mock.timers.tick(1000);
	assert.equal(h.sends.length, 0);
	await h.command("1s retired context");
	h.setStale(true);
	t.mock.timers.tick(1000);
	assert.equal(h.sends.length, 0);
	h.setStale(false);
});

test("countdown notifications refresh default footer, stop at zero and unsubscribe cleanly", async (t) => {
	const h = harness(t);
	await h.emit("session_start");
	let changes = 0;
	const unsubscribe = onRailContinueChange(h.manager, () => { changes++; });
	await h.command("3s countdown");
	assert.equal(h.statuses.get("rail-continue"), "CONT-1-1m");
	const afterCreate = changes;
	t.mock.timers.tick(1000);
	assert.ok(changes > afterCreate);
	assert.equal(h.statuses.get("rail-continue"), "CONT-1-1m");
	unsubscribe();
	const afterUnsubscribe = changes;
	t.mock.timers.tick(2000);
	assert.equal(changes, afterUnsubscribe);
	assert.equal(h.statuses.has("rail-continue"), false);
	const afterConsume = changes;
	t.mock.timers.tick(10_000);
	assert.equal(changes, afterConsume);
});

test("panel opening/closing does not cancel tasks; non-TUI panel use gives useful status without custom UI", async (t) => {
	const h = harness(t);
	await h.emit("session_start");
	await h.command("5s remains armed");
	let opens = 0;
	h.ctx.ui.custom = async () => { opens++; t.mock.timers.tick(1000); };
	await h.command("");
	assert.equal(opens, 1);
	assert.equal(railContinueLabel(h.manager), "CONT-1-1m");
	h.ctx.mode = "rpc";
	await h.command("");
	assert.equal(opens, 1);
	assert.match(h.notices.at(-1)![0], /1 pending.*\n[\s\S]*task panel requires interactive TUI/);
	t.mock.timers.tick(4000);
	assert.equal(h.sends.length, 1);
});

test("invalid commands and unsafe deadlines leave existing tasks untouched; completions include management", async (t) => {
	const h = harness(t);
	await h.emit("session_start");
	await h.command("10s existing");
	for (const value of ["0s bad", "10s \n ", "9007199254740s out of range"]) await h.command(value);
	assert.equal(railContinueLabel(h.manager), "CONT-1-1m");
	assert.ok(h.notices.slice(-3).every((notice) => notice[1] === "warning"));
	assert.deepEqual(h.commands.get("rail-continue").getArgumentCompletions("cancel").map((item: any) => item.value), ["cancel all"]);
	assert.equal(formatRailContinueCountdown(0, 1000), "0s");
	assert.equal(formatRailContinueCountdown(61_000, 0), "1m01s");
	assert.equal(formatRailContinueCountdown(3_661_000, 0), "1h01m");
});

test("footer label uses the nearest check rounded up to whole minutes; detailed status retains seconds", async (t) => {
	const h = harness(t);
	await h.emit("session_start");
	await h.command("9m first");
	assert.equal(railContinueLabel(h.manager), "CONT-1-9m");
	t.mock.timers.tick(59_999);
	assert.equal(railContinueLabel(h.manager), "CONT-1-9m");
	t.mock.timers.tick(1);
	assert.equal(railContinueLabel(h.manager), "CONT-1-8m");
	t.mock.timers.tick(1000);
	assert.match(railContinueStatus(h.manager), /CHECK 7m59s/);
	assert.equal(railContinueLabel(h.manager), "CONT-1-8m");
	await h.command("1h second");
	assert.equal(railContinueLabel(h.manager), "CONT-2-8m");
	await h.command("cancel 1");
	assert.equal(railContinueLabel(h.manager), "CONT-1-60m");
});
