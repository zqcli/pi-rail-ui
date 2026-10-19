import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
	parseRailContinueDuration, RailContinueScheduler, type RailContinueSchedulerOptions, type RailContinueTask,
} from "../../commands/rail-continue-scheduler";

function harness(t: TestContext, options: Partial<RailContinueSchedulerOptions> = {}) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
	let reason: string | undefined;
	let current = true;
	const checks: number[] = [];
	const attempts: Array<{ message: string; task: RailContinueTask }> = [];
	const errors: Array<{ error: unknown; task: RailContinueTask }> = [];
	const scheduler = new RailContinueScheduler({
		busyReason: () => { checks.push(Date.now()); return reason; },
		isCurrent: () => current,
		submit: (message, task) => { attempts.push({ message, task }); },
		onError: (error, task) => { errors.push({ error, task }); },
		...options,
	});
	t.after(() => scheduler.dispose());
	return {
		scheduler, checks, attempts, errors,
		setReason: (value: string | undefined) => { reason = value; },
		setCurrent: (value: boolean) => { current = value; },
	};
}

const onlyTask = (scheduler: RailContinueScheduler): RailContinueTask => {
	const tasks = scheduler.snapshot().tasks;
	assert.equal(tasks.length, 1);
	return tasks[0]!;
};

test("creation immediately counts down while busy, and becoming idle does not send early", (t) => {
	const h = harness(t);
	h.setReason("agent working");
	const task = h.scheduler.create(1_000, "保持 Case\n/literal-command");
	assert.equal(task.createdAt, 1_000);
	assert.equal(task.nextCheckAt, 2_000);
	assert.equal(task.resetCount, 0);
	assert.equal(h.checks.length, 0, "arming and snapshots never consult idleness");
	t.mock.timers.tick(400);
	h.setReason(undefined);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 2_000);
	t.mock.timers.tick(599);
	assert.equal(h.attempts.length, 0);
	assert.equal(h.checks.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(h.checks, [2_000]);
	assert.equal(h.attempts[0]?.message, "保持 Case\n/literal-command");
	assert.equal(h.scheduler.snapshot().tasks.length, 0);
	t.mock.timers.tick(10_000);
	assert.equal(h.attempts.length, 1, "a consumed task never becomes periodic");
});

test("each busy or queued deadline restarts one FULL interval, never a silence window", (t) => {
	const h = harness(t);
	h.scheduler.create(1_000, "continue");
	h.setReason("agent working");
	t.mock.timers.tick(1_000);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 3_000);
	assert.equal(onlyTask(h.scheduler).resetCount, 1);
	assert.equal(onlyTask(h.scheduler).lastCheckReason, "agent working");
	t.mock.timers.tick(100);
	h.setReason(undefined);
	for (let i = 0; i < 8; i++) {
		t.mock.timers.tick(100);
		h.scheduler.snapshot();
	}
	assert.equal(h.checks.length, 1);
	assert.equal(h.attempts.length, 0);
	h.setReason("pending messages");
	t.mock.timers.tick(100);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 4_000);
	assert.equal(onlyTask(h.scheduler).resetCount, 2);
	assert.equal(h.scheduler.snapshot().busyReason, "pending messages");
	h.setReason(undefined);
	t.mock.timers.tick(999);
	assert.equal(h.attempts.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.attempts.length, 1);
	assert.equal(h.scheduler.snapshot().busyReason, undefined);
});

test("tasks keep independent intervals and stable IDs through other task cancellations", (t) => {
	const h = harness(t);
	const first = h.scheduler.create(1_000, "first");
	const second = h.scheduler.create(2_500, "second");
	assert.notEqual(first.id, second.id);
	h.setReason("working");
	t.mock.timers.tick(1_000);
	assert.deepEqual(h.scheduler.snapshot().tasks.map(({ id, nextCheckAt, resetCount }) => ({ id, nextCheckAt, resetCount })), [
		{ id: first.id, nextCheckAt: 3_000, resetCount: 1 },
		{ id: second.id, nextCheckAt: 3_500, resetCount: 0 },
	]);
	assert.equal(h.scheduler.cancel(first.id), true);
	const third = h.scheduler.create(4_000, "third");
	assert.equal(new Set([first.id, second.id, third.id]).size, 3);
	h.setReason(undefined);
	t.mock.timers.tick(1_499);
	assert.equal(h.attempts.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.attempts[0]?.task.id, second.id);
	assert.equal(onlyTask(h.scheduler).id, third.id);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 6_000);
});

test("a same-deadline batch submits at most one even when the public API leaves idleness unchanged", (t) => {
	const h = harness(t);
	const first = h.scheduler.create(1_000, "first");
	const second = h.scheduler.create(1_000, "second");
	const third = h.scheduler.create(1_000, "third");
	t.mock.timers.tick(1_000);
	assert.deepEqual(h.attempts.map(({ task }) => task.id), [first.id]);
	assert.deepEqual(h.checks, [2_000]);
	assert.deepEqual(h.scheduler.snapshot().tasks.map(({ id, nextCheckAt, resetCount }) => ({ id, nextCheckAt, resetCount })), [
		{ id: second.id, nextCheckAt: 3_000, resetCount: 1 },
		{ id: third.id, nextCheckAt: 3_000, resetCount: 1 },
	]);
	assert.match(onlyTaskReason(h.scheduler, second.id), /another task submitted/);
	t.mock.timers.tick(999);
	assert.equal(h.attempts.length, 1);
	t.mock.timers.tick(1);
	assert.equal(h.attempts.length, 2);
	assert.equal(onlyTask(h.scheduler).id, third.id);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 4_000);
	t.mock.timers.tick(1_000);
	assert.equal(h.attempts.length, 3);
	assert.equal(h.scheduler.snapshot().tasks.length, 0);
});

const onlyTaskReason = (scheduler: RailContinueScheduler, id: string): string =>
	scheduler.snapshot().tasks.find((task) => task.id === id)?.lastCheckReason ?? "";

test("late busy wake checks once and restarts from actual now, without catching up missed intervals", (t) => {
	const h = harness(t);
	h.scheduler.create(1_000, "continue");
	h.setReason("working");
	t.mock.timers.setTime(100_000);
	t.mock.timers.tick(0);
	assert.deepEqual(h.checks, [100_000]);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 101_000);
	assert.equal(onlyTask(h.scheduler).resetCount, 1);
	h.setReason(undefined);
	t.mock.timers.tick(999);
	assert.equal(h.attempts.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.attempts.length, 1);
});

test("late idle wake submits only the earliest task and gives other overdue tasks a full interval", (t) => {
	const h = harness(t);
	const later = h.scheduler.create(2_000, "later deadline inserted first");
	const earlier = h.scheduler.create(1_000, "earlier deadline inserted second");
	t.mock.timers.setTime(100_000);
	t.mock.timers.tick(0);
	assert.equal(h.attempts.length, 1);
	assert.equal(h.attempts[0]?.task.id, earlier.id);
	assert.equal(onlyTask(h.scheduler).id, later.id);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 102_000);
	assert.equal(onlyTask(h.scheduler).resetCount, 1);
	t.mock.timers.tick(1_999);
	assert.equal(h.attempts.length, 1);
	t.mock.timers.tick(1);
	assert.equal(h.attempts.length, 2);
});

test("a slow busy check restarts from actual current time after the check", (t) => {
	let clock = 1_000;
	let h: ReturnType<typeof harness>;
	h = harness(t, {
		now: () => clock,
		busyReason: () => { clock += 200; return "working"; },
	});
	h.scheduler.create(1_000, "continue");
	clock = 2_000;
	t.mock.timers.tick(1_000);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 3_200);
	assert.equal(onlyTask(h.scheduler).resetCount, 1);
});

test("a slow submission restarts other due tasks from actual current time after the attempt", (t) => {
	let clock = 1_000;
	const h = harness(t, { now: () => clock, submit: () => { clock += 200; } });
	h.scheduler.create(1_000, "first");
	h.scheduler.create(1_000, "second");
	clock = 2_000;
	t.mock.timers.tick(1_000);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 3_200);
	assert.equal(onlyTask(h.scheduler).resetCount, 1);
});

test("long intervals use safe timer chunks without checking busy or sending at a chunk boundary", (t) => {
	const h = harness(t);
	const maxTimer = 2 ** 31 - 1;
	const task = h.scheduler.create(maxTimer + 5_000, "long interval");
	assert.equal(task.nextCheckAt, 1_000 + maxTimer + 5_000);
	t.mock.timers.tick(maxTimer);
	assert.equal(h.checks.length, 0);
	assert.equal(h.attempts.length, 0);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, task.nextCheckAt);
	t.mock.timers.tick(4_999);
	assert.equal(h.checks.length, 0);
	h.setReason("queued work");
	t.mock.timers.tick(1);
	assert.equal(h.checks.length, 1);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, Date.now() + task.intervalMs);
	h.setReason(undefined);
	t.mock.timers.tick(maxTimer);
	assert.equal(h.checks.length, 1, "a restarted interval is chunked too");
	t.mock.timers.tick(5_000);
	assert.equal(h.attempts.length, 1);
});

test("canceling the nearest task re-arms for the next deadline; cancelAll stops all checks", (t) => {
	const h = harness(t);
	const first = h.scheduler.create(1_000, "first");
	const second = h.scheduler.create(2_000, "second");
	let changes = 0;
	const unsubscribe = h.scheduler.subscribe(() => changes++);
	assert.equal(h.scheduler.cancel("missing"), false);
	assert.equal(changes, 0);
	assert.equal(h.scheduler.cancel(first.id), true);
	assert.equal(changes, 1);
	t.mock.timers.tick(1_000);
	assert.equal(h.checks.length, 0);
	assert.equal(h.scheduler.cancelAll(), 1);
	assert.equal(h.scheduler.cancel(second.id), false);
	assert.equal(h.scheduler.cancelAll(), 0);
	assert.equal(changes, 2);
	t.mock.timers.tick(10_000);
	assert.equal(h.checks.length, 0);
	unsubscribe();
	h.scheduler.create(1_000, "new task");
	assert.equal(changes, 2);
});

test("creation and snapshot results are detached and cannot rewrite authorization", (t) => {
	const h = harness(t);
	const task = h.scheduler.create(1_000, "original");
	task.message = "modified";
	task.nextCheckAt = 1_000;
	const snapshot = h.scheduler.snapshot();
	snapshot.tasks[0]!.message = "also modified";
	snapshot.tasks[0]!.nextCheckAt = 1_000;
	snapshot.tasks.length = 0;
	assert.equal(onlyTask(h.scheduler).message, "original");
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 2_000);
	t.mock.timers.tick(999);
	assert.equal(h.attempts.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.attempts[0]?.message, "original");
});

test("dispose clears authorization before notifying, is idempotent and cannot be revived", (t) => {
	const h = harness(t);
	h.scheduler.create(1_000, "continue");
	let changes = 0;
	h.scheduler.subscribe(() => {
		changes++;
		assert.deepEqual(h.scheduler.snapshot(), { tasks: [], active: false });
		assert.throws(() => h.scheduler.create(1_000, "revive"), /no longer active/);
	});
	h.scheduler.dispose();
	h.scheduler.dispose();
	assert.equal(changes, 1);
	assert.equal(h.scheduler.cancelAll(), 0);
	assert.equal(h.scheduler.cancel("1"), false);
	h.scheduler.subscribe(() => changes++);
	t.mock.timers.tick(10_000);
	assert.equal(h.checks.length, 0);
	assert.equal(h.attempts.length, 0);
	assert.equal(changes, 1);
});

test("lost session/runtime ownership invalidates all tasks and never resurrects after returning", (t) => {
	const h = harness(t);
	h.scheduler.create(1_000, "continue");
	h.setCurrent(false);
	t.mock.timers.tick(1_000);
	assert.equal(h.checks.length, 0);
	assert.equal(h.attempts.length, 0);
	assert.deepEqual(h.scheduler.snapshot(), { tasks: [], active: false });
	h.setCurrent(true);
	t.mock.timers.tick(1_000);
	assert.throws(() => h.scheduler.create(1_000, "old owner"), /no longer active/);
	assert.equal(h.attempts.length, 0);
});

test("snapshot itself invalidates a stale owner without waiting for its timer", (t) => {
	const h = harness(t);
	h.scheduler.create(1_000, "continue");
	h.setCurrent(false);
	assert.equal(h.scheduler.snapshot().active, false);
	t.mock.timers.tick(1_000);
	assert.equal(h.checks.length, 0);
	assert.equal(h.attempts.length, 0);
});

test("stale canceled or already-fired timer callbacks cannot consume a current task", (t) => {
	const h = harness(t);
	const callbacks: Array<() => void> = [];
	const originalSetTimeout = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
		callbacks.push(callback);
		return originalSetTimeout(callback, delay);
	});
	h.scheduler.create(1_000, "first");
	h.scheduler.create(2_000, "second");
	assert.equal(callbacks.length, 2);
	t.mock.timers.setTime(2_000);
	callbacks[0]!();
	assert.equal(h.attempts.length, 0, "rearming invalidates the old callback even if it escaped cancellation");
	callbacks[1]!();
	assert.equal(h.attempts.length, 1);
	callbacks[1]!();
	assert.equal(h.attempts.length, 1, "a completed callback cannot run a new batch");
	h.scheduler.dispose();
	callbacks.at(-1)!();
	assert.equal(h.attempts.length, 1);
});

test("the attempted task is consumed before submit, and callback-created tasks start their own intervals", (t) => {
	let h: ReturnType<typeof harness>;
	const seen: string[][] = [];
	let attempts = 0;
	h = harness(t, {
		submit: (_message, task) => {
			attempts++;
			seen.push(h.scheduler.snapshot().tasks.map((pending) => pending.id));
			assert.equal(h.scheduler.cancel(task.id), false);
			if (attempts === 1) h.scheduler.create(500, "new authorization");
		},
	});
	h.scheduler.create(1_000, "first");
	t.mock.timers.tick(1_000);
	assert.deepEqual(seen, [[]]);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 2_500);
	t.mock.timers.tick(499);
	assert.equal(attempts, 1);
	t.mock.timers.tick(1);
	assert.equal(attempts, 2);
	assert.equal(h.scheduler.snapshot().tasks.length, 0);
});

test("a throwing submission and throwing error reporter never retry or stop other due tasks", (t) => {
	let attempts = 0;
	let reports = 0;
	const h = harness(t, {
		submit: () => { attempts++; throw new Error("send failed synchronously"); },
		onError: () => { reports++; throw new Error("notification failed"); },
	});
	h.scheduler.create(1_000, "first");
	h.scheduler.create(1_000, "second");
	h.scheduler.subscribe(() => { throw new Error("render failed"); });
	t.mock.timers.tick(1_000);
	assert.equal(attempts, 1);
	assert.equal(reports, 1);
	assert.equal(onlyTask(h.scheduler).resetCount, 1);
	t.mock.timers.tick(1_000);
	assert.equal(attempts, 2);
	assert.equal(reports, 2);
	assert.equal(h.scheduler.snapshot().tasks.length, 0);
	t.mock.timers.tick(10_000);
	assert.equal(attempts, 2);
});

test("a failed idle check fails closed for a full interval and reports a detached task", (t) => {
	let fail = true;
	const h = harness(t, { busyReason: () => { if (fail) throw new Error("idle unavailable"); return undefined; } });
	h.scheduler.create(1_000, "continue");
	t.mock.timers.tick(1_000);
	assert.equal(h.errors.length, 1);
	assert.equal(h.attempts.length, 0);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 3_000);
	assert.equal(onlyTask(h.scheduler).lastCheckReason, "idle check failed");
	h.errors[0]!.task.message = "mutated report";
	fail = false;
	t.mock.timers.tick(999);
	assert.equal(h.attempts.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.attempts[0]?.message, "continue");
});

test("an ownership callback failure permanently fails closed rather than sending or retrying", (t) => {
	let fail = false;
	const h = harness(t, { isCurrent: () => { if (fail) throw new Error("session missing"); return true; } });
	h.scheduler.create(1_000, "continue");
	fail = true;
	t.mock.timers.tick(1_000);
	assert.equal(h.errors.length, 1);
	assert.equal(h.attempts.length, 0);
	assert.equal(h.scheduler.snapshot().active, false);
	fail = false;
	t.mock.timers.tick(10_000);
	assert.equal(h.attempts.length, 0);
});

test("cancellation inside an idle check wins before submission, without blocking another due task", (t) => {
	let h: ReturnType<typeof harness>;
	let canceledId = "";
	let checks = 0;
	h = harness(t, { busyReason: () => {
		checks++;
		if (checks === 1) h.scheduler.cancel(canceledId);
		return undefined;
	} });
	canceledId = h.scheduler.create(1_000, "canceled before submit").id;
	const second = h.scheduler.create(1_000, "still authorized");
	t.mock.timers.tick(1_000);
	assert.equal(h.attempts.length, 1);
	assert.equal(h.attempts[0]?.task.id, second.id);
	assert.equal(h.scheduler.snapshot().tasks.length, 0);
});

test("disposing inside an idle check prevents the checked task from sending", (t) => {
	let h: ReturnType<typeof harness>;
	h = harness(t, { busyReason: () => { h.scheduler.dispose(); return undefined; } });
	h.scheduler.create(1_000, "continue");
	t.mock.timers.tick(1_000);
	assert.equal(h.attempts.length, 0);
	assert.equal(h.scheduler.snapshot().active, false);
});

test("ownership is rechecked after an idle callback and cannot revive a disposed scheduler", (t) => {
	let h: ReturnType<typeof harness>;
	h = harness(t, { busyReason: () => { h.setCurrent(false); return undefined; } });
	h.scheduler.create(1_000, "continue");
	t.mock.timers.tick(1_000);
	assert.equal(h.attempts.length, 0);
	assert.equal(h.scheduler.snapshot().active, false);
});

test("an ownership callback that disposes reentrantly cannot authorize a send by returning true", (t) => {
	let disposeDuringCheck = false;
	let h: ReturnType<typeof harness>;
	h = harness(t, { isCurrent: () => {
		if (disposeDuringCheck) h.scheduler.dispose();
		return true;
	} });
	h.scheduler.create(1_000, "continue");
	disposeDuringCheck = true;
	t.mock.timers.tick(1_000);
	assert.equal(h.attempts.length, 0);
	assert.equal(h.scheduler.snapshot().active, false);
});

test("a submission that changes ownership invalidates other tasks in the same due batch", (t) => {
	let attempts = 0;
	let h: ReturnType<typeof harness>;
	h = harness(t, { submit: () => { attempts++; h.setCurrent(false); } });
	h.scheduler.create(1_000, "first");
	h.scheduler.create(1_000, "second");
	t.mock.timers.tick(1_000);
	assert.equal(attempts, 1);
	assert.deepEqual(h.scheduler.snapshot(), { tasks: [], active: false });
	h.setCurrent(true);
	t.mock.timers.tick(10_000);
	assert.equal(attempts, 1);
});

test("a reentrant mutation listener can cancel another due task before its processing", (t) => {
	const h = harness(t);
	const first = h.scheduler.create(1_000, "first");
	const second = h.scheduler.create(1_000, "second");
	h.setReason("working");
	h.scheduler.subscribe(() => {
		if (h.scheduler.snapshot().tasks.some((task) => task.id === first.id && task.resetCount === 1)) {
			h.scheduler.cancel(second.id);
			h.setReason(undefined);
		}
	});
	t.mock.timers.tick(1_000);
	assert.equal(h.attempts.length, 0);
	assert.deepEqual(h.checks, [2_000]);
	assert.equal(onlyTask(h.scheduler).id, first.id);
	assert.equal(onlyTask(h.scheduler).nextCheckAt, 3_000);
	t.mock.timers.tick(999);
	assert.equal(h.attempts.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.attempts[0]?.task.id, first.id);
});

test("a submission listener can cancel the rest of a due batch without stale resets", (t) => {
	const h = harness(t);
	h.scheduler.create(1_000, "first");
	h.scheduler.create(1_000, "second");
	h.scheduler.subscribe(() => { if (h.attempts.length) h.scheduler.cancelAll(); });
	t.mock.timers.tick(1_000);
	assert.equal(h.attempts.length, 1);
	assert.equal(h.scheduler.snapshot().tasks.length, 0);
	t.mock.timers.tick(10_000);
	assert.equal(h.attempts.length, 1);
});

test("unsubscribe during notification and throwing listeners cannot perturb other subscribers", (t) => {
	const h = harness(t);
	let called = 0;
	let unsubscribe = () => {};
	h.scheduler.subscribe(() => { unsubscribe(); throw new Error("render failed"); });
	unsubscribe = h.scheduler.subscribe(() => called++);
	h.scheduler.create(1_000, "continue");
	assert.equal(called, 0);
	t.mock.timers.tick(1_000);
	assert.equal(h.attempts.length, 1);
	assert.equal(called, 0);
});

test("the shared duration parser accepts whole units, defaults to minutes and preserves long intervals", () => {
	for (const [text, expected] of [
		["1", 60_000], ["2s", 2_000], ["3m", 180_000], ["4h", 14_400_000],
		[" 005M ", 300_000], ["2147484s", 2_147_484_000],
	] as const) assert.equal(parseRailContinueDuration(text), expected, text);
	for (const text of ["", "0", "000s", "-1m", "+1m", "1.5h", "1e3", "1ms", "1 s", "1\ns", "Infinity", "NaN", "9007199254740992s", "9007199254740991m"]) {
		assert.throws(() => parseRailContinueDuration(text), /Duration/, text);
	}
});

test("invalid durations and messages fail without creating tasks or scheduling callbacks", (t) => {
	const h = harness(t);
	for (const duration of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => h.scheduler.create(duration, "continue"), /positive safe integer/);
	}
	for (const message of ["", " \n\t "]) assert.throws(() => h.scheduler.create(1_000, message), /must not be empty/);
	assert.throws(() => h.scheduler.create(Number.MAX_SAFE_INTEGER, "overflow"), /supported time range/);
	assert.equal(h.scheduler.snapshot().tasks.length, 0);
	t.mock.timers.tick(10_000);
	assert.equal(h.checks.length, 0);
	const accepted = "  /Literal Case\n中文消息\n  ";
	assert.equal(h.scheduler.create(1_000, accepted).message, accepted);
});

test("a busy restart at arithmetic exhaustion removes the task instead of creating an immediate timer loop", (t) => {
	let now = Number.MAX_SAFE_INTEGER - 1_000;
	const h = harness(t, { now: () => now, busyReason: () => "working" });
	h.scheduler.create(1_000, "continue");
	now += 1_000;
	t.mock.timers.tick(1_000);
	assert.equal(h.scheduler.snapshot().tasks.length, 0);
	assert.equal(h.attempts.length, 0);
	assert.equal(h.errors.length, 1);
	assert.match(String(h.errors[0]?.error), /supported time range/);
	t.mock.timers.tick(10_000);
	assert.equal(h.errors.length, 1);
});
