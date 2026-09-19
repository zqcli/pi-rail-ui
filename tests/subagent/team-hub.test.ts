import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamHub } from "../../tools/subagents/team-hub";
import { publicTeamReply } from "../../tools/subagents/team-extension";
import { TEAM_MAX_EVENTS, type TeamBinding, type TeamRequest, type TeamSnapshot } from "../../tools/subagents/team-protocol";

function fixture(count = 2, options: ConstructorParameters<typeof TeamHub>[0] = {}) {
	const hub = new TeamHub(options);
	const snapshot = hub.prepare({ coordinator: "A", workers: Array.from({ length: count }, (_, i) => `B${i + 1}`) });
	const [a] = hub.join(snapshot.id, ["A"]);
	const workers = hub.join(snapshot.id, snapshot.workers);
	const sequences = new Map<string, number>();
	const request = (binding: TeamBinding, fields: Omit<TeamRequest, "requestId" | "sequence">, signal?: AbortSignal) => {
		const sequence = (sequences.get(binding.memberId) ?? 0) + 1;
		sequences.set(binding.memberId, sequence);
		return hub.request(binding, { requestId: `${binding.memberId}-${sequence}`, sequence, ...fields }, signal);
	};
	return { hub, id: snapshot.id, a: a!, workers, b: workers[0]!, request };
}
const outcome = { status: "completed", output: "native result" } as const;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test("fractional-second deadlines round up to transport-safe integer milliseconds", async (t) => {
	const hub = new TeamHub({ now: () => 1_700_000_000_000 }); t.after(() => hub.dispose());
	const team = hub.prepare({ coordinator: "A", workers: ["B1"], timeoutSeconds: 60.1234 });
	assert.equal(team.deadline - team.createdAt, 60_124);
	const [a] = hub.join(team.id, ["A"]);
	hub.join(team.id, ["B1"]);
	const reply = await hub.request(a!, { requestId: "fractional", sequence: 1, action: "checkpoint", receive: true });
	assert.doesNotThrow(() => publicTeamReply(reply));
});

test("fixed roster validation and atomic joins; checkpoint waits for both sibling dispatches", async (t) => {
	const hub = new TeamHub(); t.after(() => hub.dispose());
	for (const workers of [[], ["A"], ["B", "B"], Array.from({ length: 9 }, (_, i) => `B${i}`)]) {
		assert.throws(() => hub.prepare({ coordinator: "A", workers }));
	}
	const team = hub.prepare({ coordinator: "A", workers: ["B1", "B2"] });
	assert.throws(() => hub.join(team.id, ["B1"]), /exact worker roster/);
	assert.throws(() => hub.join(team.id, ["B1", "unknown"]));
	assert.ok(hub.get(team.id).members.every((m) => m.state === "registered"));
	const [a] = hub.join(team.id, ["A"]);
	let admitted = false;
	const checkpoint = hub.request(a!, { requestId: "c", sequence: 1, action: "checkpoint" }).then((reply) => { admitted = true; return reply; });
	await tick(); assert.equal(admitted, false);
	hub.join(team.id, ["B2", "B1"]);
	assert.equal((await checkpoint).ok, true);
	assert.throws(() => hub.join(team.id, ["B1", "B2"]), /already joined/);
});

test("four permits allow B1 waiting for B8 to make progress; coordinator is independent", async (t) => {
	const { hub, a, workers, request, id } = fixture(8); t.after(() => hub.dispose());
	for (const b of workers.slice(0, 4)) assert.equal((await request(b, { action: "checkpoint" })).ok, true);
	assert.equal((await request(a, { action: "checkpoint" })).ok, true);
	const queued = workers.slice(4).map((b) => request(b, { action: "checkpoint" }));
	const waiting = request(workers[0]!, { action: "wait", wait: { kind: "member", member: "B8" } });
	assert.equal((await queued[0]!).ok, true);
	for (let index = 4; index < 7; index++) {
		hub.complete(workers[index]!, outcome);
		assert.equal((await queued[index - 3]!).ok, true);
	}
	hub.complete(workers[7]!, outcome);
	assert.equal((await waiting).snapshot?.members.find((m) => m.id === "B8")?.output, "native result");
	assert.ok(hub.get(id).members.filter((m) => m.role === "worker" && m.state === "running").length <= 4);
});

test("message before wait and atomic report+wait do not lose wakeups; sender is bound", async (t) => {
	const { hub, a, b, request } = fixture(); t.after(() => hub.dispose());
	assert.equal((await request(a, { action: "send", to: "B1", message: "early" })).ok, true);
	const early = await request(b, { action: "wait", wait: { kind: "message" } });
	assert.equal(early.events?.[0]?.message, "early");
	const wait = request(b, { action: "report", message: "blocked", wait: { kind: "message" } });
	assert.equal((await request(a, { action: "wait", wait: { kind: "message" } })).events?.[0]?.message, "blocked");
	await request(a, { action: "send", to: "B1", message: "continue" });
	assert.equal((await wait).events?.[0]?.message, "continue");
	const forged = { requestId: "forged", sequence: 100, action: "send", to: "A", message: "hello", sender: "A" } as const;
	assert.equal((await hub.request(b, forged)).ok, true);
	assert.equal((await request(a, { action: "wait", wait: { kind: "message" } })).events?.[0]?.from, "B1");
	assert.equal((await hub.request({ ...b, role: "coordinator" }, forged)).ok, false);
});

test("request id retries are idempotent, conflicting duplicates and stale sequences fail", async (t) => {
	const { hub, a, b, request, id } = fixture(); t.after(() => hub.dispose());
	const send: TeamRequest = { requestId: "send", sequence: 1, action: "send", to: "A", message: "once" };
	assert.deepEqual(await hub.request(b, send), await hub.request(b, send));
	assert.equal(hub.get(id).events.filter((e) => e.message === "once").length, 1);
	assert.match((await hub.request(b, { ...send, message: "twice" })).error!, /Conflicting/);
	assert.match((await hub.request(b, { ...send, requestId: "new" })).error!, /Stale/);
	const wait: TeamRequest = { requestId: "wait", sequence: 2, action: "wait", wait: { kind: "message" } };
	const p1 = hub.request(b, wait); const p2 = hub.request(b, wait);
	await request(a, { action: "send", to: "B1", message: "wake" });
	assert.deepEqual(await p1, await p2);
});

test("inbox rejects overflow and oversized UTF-8; events and retry cache stay bounded", async (t) => {
	const { hub, a, b, request, id } = fixture(); t.after(() => hub.dispose());
	for (let i = 0; i < TEAM_MAX_EVENTS; i++) assert.equal((await request(b, { action: "send", to: "A", message: `m${i}` })).ok, true);
	assert.match((await request(b, { action: "send", to: "A", message: "overflow" })).error!, /overflow/);
	assert.equal(hub.get(id).events.length, TEAM_MAX_EVENTS);
	assert.equal((await request(a, { action: "wait", wait: { kind: "message" } })).events?.length, TEAM_MAX_EVENTS);
	assert.match((await request(b, { action: "send", to: "A", message: "中".repeat(3000) })).error!, /Invalid/);
	for (let i = 0; i < 150; i++) await request(b, { action: "checkpoint" });
	assert.match((await hub.request(b, { requestId: "B1-1", sequence: 1, action: "send", to: "A", message: "m0" })).error!, /Stale/);
});

test("afterSeq acknowledges old messages and frees a full mailbox before the next event", async (t) => {
	const { hub, a, b, request, id } = fixture(1); t.after(() => hub.dispose());
	for (let i = 0; i < TEAM_MAX_EVENTS; i++) await request(a, { action: "send", to: "B1", message: "old" });
	const wait = request(b, { action: "wait", wait: { kind: "message", afterSeq: hub.get(id).seq } });
	assert.equal((await request(a, { action: "send", to: "B1", message: "new" })).ok, true);
	assert.deepEqual((await wait).events?.map((e) => e.message), ["new"]);
});

test("journal callback can reply synchronously to an atomic report+wait", async (t) => {
	const { hub, a, b, request } = fixture(1); t.after(() => hub.dispose());
	let replied = false;
	const off = hub.subscribe((snapshot) => {
		if (!replied && snapshot.events.some((event) => event.message === "blocked")) {
			replied = true;
			void request(a, { action: "send", to: "B1", message: "immediate" });
		}
	});
	const reply = await request(b, { action: "report", message: "blocked", wait: { kind: "message" } });
	off();
	assert.equal(reply.events?.[0]?.message, "immediate");
});

test("manual pause survives dependency readiness; resume does not bypass unresolved dependencies", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(); t.after(() => hub.dispose());
	await request(b, { action: "checkpoint" });
	await request(a, { action: "control", to: "B1", command: "pause" });
	assert.equal(hub.get(id).members.find((m) => m.id === "B1")?.state, "pause_requested");
	let ready = false;
	const wait = request(b, { action: "wait", wait: { kind: "member", member: "B2" } }).then((reply) => { ready = true; return reply; });
	assert.equal(hub.get(id).members.find((m) => m.id === "B1")?.state, "paused");
	await request(a, { action: "control", to: "B1", command: "resume" });
	await tick(); assert.equal(ready, false);
	await request(a, { action: "control", to: "B1", command: "pause" });
	hub.complete(workers[1]!, { status: "failed", output: "", error: "native failure" });
	await tick(); assert.equal(ready, false);
	await request(a, { action: "control", to: "B1", command: "resume" });
	assert.equal((await wait).snapshot?.members.find((m) => m.id === "B2")?.error, "native failure");
});

test("redirect replaces wait but not manual pause; control scope and dependency cycles are enforced", async (t) => {
	const { hub, a, b, workers, request } = fixture(); t.after(() => hub.dispose());
	for (const wait of [{ kind: "member", member: "B1" }, { kind: "member", member: "missing" }, { kind: "workers" }, { kind: "member", member: "A" }] as const) {
		assert.equal((await request(b, { action: "wait", wait })).ok, false);
	}
	assert.equal((await request(b, { action: "control", to: "B2", command: "pause" })).ok, false);
	assert.equal((await request(a, { action: "control", to: "A", command: "pause" })).ok, false);
	assert.equal((await request(a, { action: "control", to: "other-team", command: "pause" })).ok, false);
	const pending = request(b, { action: "wait", wait: { kind: "member", member: "B2" } });
	assert.match((await request(workers[1]!, { action: "wait", wait: { kind: "member", member: "B1" } })).error!, /cycle/);
	await request(a, { action: "control", to: "B1", command: "pause" });
	await request(a, { action: "control", to: "B1", command: "redirect", message: "new direction" });
	let settled = false; void pending.then(() => { settled = true; });
	await tick(); assert.equal(settled, false);
	await request(a, { action: "control", to: "B1", command: "resume" });
	assert.equal((await pending).events?.[0]?.message, "new direction");
});

test("native complete is authoritative; coordinator receives sealed barrier; terminal cannot resurrect", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(); t.after(() => hub.dispose());
	await request(b, { action: "report", message: "I am done" });
	await request(b, { action: "finish" });
	assert.equal(hub.get(id).members.find((m) => m.id === "B1")?.state, "waiting");
	assert.throws(() => hub.complete(a, outcome), /barrier/);
	let finalized = false;
	const barrier = request(a, { action: "finish" }).then((reply) => { finalized = true; return reply; });
	hub.complete(b, outcome);
	await tick(); assert.equal(finalized, false);
	hub.complete(workers[1]!, { status: "failed", output: "partial", error: "failed natively" });
	const result = await barrier;
	assert.equal(result.snapshot?.phase, "finalizing");
	assert.equal(result.snapshot?.members.find((m) => m.id === "B2")?.output, "partial");
	assert.equal((await request(a, { action: "control", to: "B1", command: "resume" })).ok, false);
	assert.equal((await request(b, { action: "checkpoint" })).ok, false);
	hub.complete(b, { status: "failed", output: "overwrite" });
	assert.equal(hub.get(id).members.find((m) => m.id === "B1")?.output, "native result");
	hub.complete(a, { status: "completed", output: "final summary" });
	assert.equal(hub.get(id).phase, "completed");
	assert.equal(hub.signal(id).aborted, false);
});

test("native results wake coordinator inbox waits and survive ordinary inbox saturation", async (t) => {
	const { hub, a, b, workers, request } = fixture(); t.after(() => hub.dispose());
	const waiting = request(a, { action: "wait", wait: { kind: "message" } });
	hub.complete(b, outcome);
	assert.equal((await waiting).events?.[0]?.kind, "result");
	for (let i = 0; i < TEAM_MAX_EVENTS; i++) await request(workers[1]!, { action: "report", message: `report${i}` });
	hub.complete(workers[1]!, outcome);
	const inbox = await request(a, { action: "wait", wait: { kind: "message" } });
	assert.equal(inbox.events?.length, TEAM_MAX_EVENTS);
	const remaining = await request(a, { action: "wait", wait: { kind: "message" } });
	assert.equal(remaining.events?.length, 1);
	assert.equal(remaining.events?.[0]?.member, "B2");
});

test("coordinator controls remain available while its barrier is pending", async (t) => {
	const { hub, a, b, request } = fixture(1); t.after(() => hub.dispose());
	const barrier = hub.waitForWorkers(a);
	assert.equal((await request(a, { action: "control", command: "pause", to: "B1" })).ok, true);
	const checkpoint = request(b, { action: "checkpoint" });
	assert.equal((await request(a, { action: "control", command: "resume", to: "B1" })).ok, true);
	assert.equal((await checkpoint).ok, true);
	hub.complete(b, outcome);
	assert.equal((await barrier).phase, "finalizing");
});

test("waitForWorkers enters finalizing only with full results", async (t) => {
	const { hub, a, b, id } = fixture(1); t.after(() => hub.dispose());
	const barrier = hub.waitForWorkers(a);
	assert.notEqual(hub.get(id).phase, "finalizing");
	hub.complete(b, outcome);
	assert.equal((await barrier).phase, "finalizing");
	assert.equal((await hub.waitForWorkers(a)).members.find((m) => m.id === "B1")?.output, "native result");
});

for (const mode of ["cancel", "signal", "dispose", "coordinator-failure"] as const) {
	test(`${mode} settles waits and permit queues, aborts team signal and cannot resurrect`, async () => {
		const { hub, a, workers, request, id } = fixture(8);
		const controller = new AbortController();
		for (const b of workers.slice(0, 4)) await request(b, { action: "checkpoint" });
		const queue = workers.slice(4).map((b) => request(b, { action: "checkpoint" }));
		const wait = request(workers[0]!, { action: "wait", wait: { kind: "message" } }, controller.signal);
		const barrier = hub.waitForWorkers(a);
		const rejected = assert.rejects(barrier);
		if (mode === "cancel") hub.cancel(id, "stop");
		if (mode === "signal") controller.abort();
		if (mode === "dispose") hub.dispose();
		if (mode === "coordinator-failure") hub.complete(a, { status: "failed", output: "", error: "A failed" });
		assert.equal((await wait).ok, false);
		await Promise.all(queue); await rejected;
		assert.equal(hub.signal(id).aborted, true);
		assert.ok(hub.get(id).members.every((m) => ["failed", "cancelled"].includes(m.state)));
		hub.complete(workers[0]!, outcome);
		assert.equal(hub.get(id).members.find((m) => m.id === "B1")?.state, "cancelled");
		hub.dispose();
	});
}

test("injectable clock enforces admission and team deadlines without sleeping", async (t) => {
	let now = 1000;
	const hub = new TeamHub({ now: () => now, startupTimeoutMs: 10 }); t.after(() => hub.dispose());
	const first = hub.prepare({ coordinator: "A", workers: ["B"] });
	const [a] = hub.join(first.id, ["A"]);
	const pending = hub.request(a!, { requestId: "gate", sequence: 1, action: "checkpoint" });
	now += 10;
	assert.throws(() => hub.join(first.id, ["B"]), /terminal/);
	assert.match((await pending).error!, /admission/);
	const second = hub.prepare({ coordinator: "A", workers: ["B"], timeoutSeconds: 0.02 });
	const [a2] = hub.join(second.id, ["A"]); hub.join(second.id, ["B"]);
	const barrier = assert.rejects(hub.waitForWorkers(a2!), /deadline/);
	now += 20;
	assert.equal(hub.get(second.id).phase, "cancelled");
	await barrier;
});

test("admission starts at first valid join, not prepare or a rejected join", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 1000;
	const hub = new TeamHub({ startupTimeoutMs: 30_000, now: () => now }); t.after(() => hub.dispose());
	const snapshot = hub.prepare({ coordinator: "A", workers: ["B1", "B2"] });
	assert.throws(() => hub.join(snapshot.id, ["B1"]));
	now += 60_000; t.mock.timers.tick(60_000);
	assert.equal(hub.get(snapshot.id).phase, "prepared");
	const [a] = hub.join(snapshot.id, ["A"]);
	const pending = hub.request(a!, { action: "checkpoint", requestId: "gate", sequence: 1 });
	now += 29_999; t.mock.timers.tick(29_999);
	assert.equal(hub.signal(snapshot.id).aborted, false);
	now++; t.mock.timers.tick(1);
	assert.match((await pending).error!, /admission/);
	assert.equal(hub.get(snapshot.id).phase, "cancelled");
});

test("late prepare admission may succeed in either sibling order; overall deadline still starts at prepare", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 1000;
	const hub = new TeamHub({ startupTimeoutMs: 10, now: () => now }); t.after(() => hub.dispose());
	const snapshot = hub.prepare({ coordinator: "A", workers: ["B"] });
	now += 100; t.mock.timers.tick(100);
	const [b] = hub.join(snapshot.id, ["B"]);
	const checkpoint = hub.request(b!, { action: "checkpoint", requestId: "gate", sequence: 1 });
	now += 9; t.mock.timers.tick(9);
	hub.join(snapshot.id, ["A"]);
	assert.equal((await checkpoint).ok, true);
	now += 100; t.mock.timers.tick(100);
	assert.equal(hub.get(snapshot.id).phase, "running");
	const unjoined = hub.prepare({ coordinator: "A", workers: ["B"], timeoutSeconds: 0.05 });
	now += 50; t.mock.timers.tick(50);
	assert.equal(hub.get(unjoined.id).phase, "cancelled");
	assert.match(String(hub.signal(unjoined.id).reason), /Team deadline/);
});

test("worker dependency wait wakes coordinator message wait; coordinator never wakes itself", async (t) => {
	const { hub, a, b, workers, request } = fixture(2); t.after(() => hub.dispose());
	let woke = false;
	const coordinatorWait = request(a, { action: "wait", wait: { kind: "message" } }).then((reply) => { woke = true; return reply; });
	await tick(); assert.equal(woke, false);
	const dependency = request(b, { action: "wait", wait: { kind: "member", member: "B2" } });
	const reply = await coordinatorWait;
	assert.equal(reply.events?.[0]?.member, "B1");
	assert.equal(reply.events?.[0]?.state, "waiting");
	assert.equal(reply.events?.[0]?.message, "waiting for member B2");
	hub.complete(workers[1]!, outcome); await dependency;
});

test("running coordinator sees message waits and pause confirmation without checkpoint churn", async (t) => {
	const { hub, a, b, request, id } = fixture(1); t.after(() => hub.dispose());
	await request(a, { action: "checkpoint" });
	await request(b, { action: "checkpoint" });
	assert.deepEqual((await request(a, { action: "checkpoint", receive: true })).events, []);
	const wait = request(b, { action: "wait", wait: { kind: "message" } });
	const notice = await request(a, { action: "checkpoint", receive: true });
	assert.equal(notice.events?.[0]?.message, "waiting for message");
	assert.equal(notice.events?.[0]?.state, "waiting");
	await request(a, { action: "send", to: "B1", message: "continue" }); await wait;
	await request(b, { action: "checkpoint" });
	await request(a, { action: "control", command: "pause", to: "B1" });
	assert.equal((await request(a, { action: "checkpoint", receive: true })).events?.[0]?.state, "pause_requested");
	const confirmation = request(a, { action: "wait", wait: { kind: "message" } });
	const paused = request(b, { action: "checkpoint" });
	assert.equal((await confirmation).events?.[0]?.state, "paused");
	assert.equal(hub.get(id).members.find((member) => member.id === "B1")?.state, "paused");
	await request(a, { action: "control", command: "resume", to: "B1" }); await paused;
	assert.deepEqual((await request(a, { action: "checkpoint", receive: true })).events, []);
	let woke = false;
	const quiet = request(a, { action: "wait", wait: { kind: "message" } }).then((reply) => { woke = true; return reply; });
	for (let i = 0; i < 5; i++) await request(b, { action: "checkpoint" });
	await tick(); assert.equal(woke, false);
	hub.cancel(id); await quiet;
});

test("worker status coalesces in reserved slots without consuming message capacity or dropping results", async (t) => {
	const { hub, a, b, workers, request } = fixture(8); t.after(() => hub.dispose());
	for (const worker of workers.slice(0, 4)) await request(worker, { action: "checkpoint" });
	const paused: Promise<unknown>[] = [];
	for (const worker of workers.slice(0, 7)) {
		await request(a, { action: "control", command: "pause", to: worker.memberId });
		paused.push(request(worker, { action: "checkpoint" }));
		await request(a, { action: "control", command: "pause", to: worker.memberId });
	}
	// Seven reserved notifications must not reduce the 64-message allowance.
	for (let i = 0; i < 64; i++) assert.equal((await request(b, { action: "report", message: `report${i}` })).ok, true);
	assert.match((await request(b, { action: "report", message: "overflow" })).error!, /overflow/);
	hub.complete(workers[7]!, outcome);
	const first = await request(a, { action: "checkpoint", receive: true });
	const second = await request(a, { action: "checkpoint", receive: true });
	assert.ok(first.events!.length <= 64 && second.events!.length <= 64);
	const events = [...first.events!, ...second.events!];
	assert.equal(events.filter((event) => event.kind === "state").length, 7);
	assert.ok(events.filter((event) => event.kind === "state").every((event) => event.state === "paused"));
	assert.deepEqual(events.filter((event) => event.kind === "report").map((event) => event.message), Array.from({ length: 64 }, (_, i) => `report${i}`));
	assert.equal(events.filter((event) => event.kind === "result").length, 1);
	for (const worker of workers.slice(0, 7)) hub.complete(worker, outcome);
	await Promise.all(paused);
});

test("successful coordinator completion never sends cancellation to its unwinding host dispatch", async (t) => {
	const journal: TeamSnapshot[] = [];
	const { hub, a, b, id } = fixture(1, { onSnapshot: (snapshot) => { journal.push(snapshot); } });
	t.after(() => hub.dispose());
	const call = new AbortController();
	hub.signal(id).addEventListener("abort", () => call.abort());
	hub.complete(b, outcome);
	await hub.waitForWorkers(a);
	hub.complete(a, { status: "completed", output: "authoritative final answer" });
	assert.equal(call.signal.aborted, false);
	assert.equal(journal.at(-1)?.phase, "completed");
	hub.cancel(id); hub.complete(a, { status: "cancelled", output: "" }); hub.dispose();
	assert.equal(hub.get(id).members.find((member) => member.id === "A")?.output, "authoritative final answer");
	assert.equal(hub.get(id).phase, "completed");
	assert.equal(call.signal.aborted, false);
});

test("final completion journal failure still aborts instead of publishing success", async (t) => {
	const { hub, a, b, id } = fixture(1, { onSnapshot: (snapshot) => {
		if (snapshot.phase === "completed") throw new Error("final persistence failed");
	} });
	t.after(() => hub.dispose());
	hub.complete(b, outcome); await hub.waitForWorkers(a);
	assert.throws(() => hub.complete(a, outcome), /journal failed/);
	assert.equal(hub.get(id).phase, "failed");
	assert.equal(hub.signal(id).aborted, true);
	assert.match(String(hub.signal(id).reason), /final persistence failed/);
});

test("real scheduled admission timeout is testable with mock timers", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const hub = new TeamHub({ startupTimeoutMs: 25 }); t.after(() => hub.dispose());
	const team = hub.prepare({ coordinator: "A", workers: ["B"] });
	const [a] = hub.join(team.id, ["A"]);
	const waiting = hub.request(a!, { requestId: "wait", sequence: 1, action: "checkpoint" });
	t.mock.timers.tick(25);
	assert.match((await waiting).error!, /admission/);
});

for (const receive of [undefined, false] as const) {
	test(`checkpoint receive=${receive} leaves queued messages for an already-generated wait tool`, async (t) => {
		const { hub, a, b, request } = fixture(1); t.after(() => hub.dispose());
		for (const message of ["before first gate", "before running gate"]) {
			await request(a, { action: "send", to: "B1", message });
			const gate = await request(b, { action: "checkpoint", ...(receive === undefined ? {} : { receive }) });
			assert.deepEqual(gate, { ok: true });
			let settled = false;
			const waiting = request(b, { action: "wait", wait: { kind: "message" } }).then((reply) => { settled = true; return reply; });
			await tick();
			assert.equal(settled, true, "wait must consume the message without another sender event");
			assert.equal((await waiting).events?.[0]?.message, message);
			await request(b, { action: "checkpoint" });
		}
	});
}

test("first receiving context announces public roster once per member, not on permission-only gates", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	assert.deepEqual(await request(b, { action: "checkpoint", receive: false }), { ok: true });
	assert.deepEqual(await request(b, { action: "checkpoint" }), { ok: true });
	const first = await request(b, { action: "checkpoint", receive: true });
	assert.deepEqual(first.events, []);
	assert.equal(first.snapshot?.coordinator, "A");
	assert.deepEqual(first.snapshot?.workers, ["B1", "B2"]);
	assert.deepEqual(first.snapshot?.members.map((member) => [member.id, member.role]), [
		["A", "coordinator"], ["B1", "worker"], ["B2", "worker"],
	]);
	for (const binding of [a, ...workers]) assert.ok(!JSON.stringify(first).includes(binding.epoch));
	assert.doesNotMatch(JSON.stringify(first), /"epoch"|"binding"/);
	first.snapshot!.workers.push("fake");
	assert.deepEqual(hub.get(id).workers, ["B1", "B2"]);
	await request(a, { action: "send", to: "B1", message: "second context" });
	const second = await request(b, { action: "checkpoint", receive: true });
	assert.equal(second.snapshot, undefined);
	assert.equal(second.events?.[0]?.message, "second context");
	assert.ok((await request(a, { action: "checkpoint", receive: true })).snapshot);
});

test("receiving checkpoint retains its flag while pending full roster admission", async (t) => {
	const hub = new TeamHub(); t.after(() => hub.dispose());
	const snapshot = hub.prepare({ coordinator: "A", workers: ["B"] });
	const [b] = hub.join(snapshot.id, ["B"]);
	const checkpoint = hub.request(b!, { requestId: "context", sequence: 1, action: "checkpoint", receive: true });
	const [a] = hub.join(snapshot.id, ["A"]);
	const reply = await checkpoint;
	assert.equal(reply.snapshot?.phase, "running");
	assert.equal(reply.snapshot?.members.length, 2);
	assert.ok(!JSON.stringify(reply).includes(a!.epoch));
	assert.equal((await hub.request(b!, { requestId: "next-context", sequence: 2, action: "checkpoint", receive: true })).snapshot, undefined);
});

test("receive participates in dedup and is rejected on non-checkpoint actions", async (t) => {
	const { hub, a, b, request } = fixture(1); t.after(() => hub.dispose());
	await request(a, { action: "send", to: "B1", message: "once" });
	const checkpoint: TeamRequest = { requestId: "context", sequence: 1, action: "checkpoint", receive: true };
	const first = await hub.request(b, checkpoint);
	assert.equal(first.events?.[0]?.message, "once");
	assert.deepEqual(await hub.request(b, checkpoint), first);
	assert.match((await hub.request(b, { ...checkpoint, receive: false })).error!, /Conflicting duplicate/);
	assert.equal((await hub.request(b, { requestId: "invalid", sequence: 2, action: "wait", wait: { kind: "message" }, receive: true })).ok, false);
	assert.equal((await hub.request(b, { ...checkpoint, requestId: "next", sequence: 2 })).snapshot, undefined);
});

test("paused permission gate preserves redirect until the following wait", async (t) => {
	const { hub, a, b, request } = fixture(1); t.after(() => hub.dispose());
	await request(b, { action: "checkpoint", receive: true });
	await request(a, { action: "control", command: "pause", to: "B1" });
	const gate = request(b, { action: "checkpoint", receive: false });
	await request(a, { action: "control", command: "redirect", to: "B1", message: "redirect before wait" });
	await request(a, { action: "control", command: "resume", to: "B1" });
	assert.deepEqual(await gate, { ok: true });
	let settled = false;
	const waiting = request(b, { action: "wait", wait: { kind: "message" } }).then((reply) => { settled = true; return reply; });
	await tick(); assert.equal(settled, true);
	assert.equal((await waiting).events?.[0]?.message, "redirect before wait");
});

test("running checkpoint consumes peer messages and redirects without permit churn or redundant journals", async (t) => {
	const journal: TeamSnapshot[] = [];
	const { hub, a, b, workers, request, id } = fixture(5, { onSnapshot: (snapshot) => { journal.push(snapshot); } });
	t.after(() => hub.dispose());
	for (const worker of workers.slice(0, 4)) await request(worker, { action: "checkpoint" });
	let queuedGranted = false;
	const queued = request(workers[4]!, { action: "checkpoint" }).then(() => { queuedGranted = true; });
	await request(workers[1]!, { action: "send", to: "B1", message: "peer instruction" });
	await request(a, { action: "control", to: "B1", command: "redirect", message: "new direction" });
	const seq = hub.get(id).seq;
	const count = journal.length;
	const checkpoint: TeamRequest = { action: "checkpoint", receive: true, sequence: 100, requestId: "running-gate" };
	const reply = await hub.request(b, checkpoint);
	assert.deepEqual(reply.events?.map((event) => event.message), ["peer instruction", "new direction"]);
	assert.deepEqual(await hub.request(b, checkpoint), reply);
	for (let i = 101; i < 120; i++) {
		assert.deepEqual((await hub.request(b, { ...checkpoint, sequence: i, requestId: `gate-${i}` })).events, []);
	}
	assert.equal(hub.get(id).seq, seq);
	assert.equal(journal.length, count);
	assert.equal(queuedGranted, false);
	assert.equal(hub.get(id).members.find((member) => member.id === "B1")?.state, "running");
	hub.cancel(id); await queued;
});

test("checkpoint admission also returns early inbox messages; reserved results drain in bounded batches", async (t) => {
	const { hub, a, b, workers, request } = fixture(8); t.after(() => hub.dispose());
	await request(a, { action: "send", to: "B1", message: "before first turn" });
	assert.equal((await request(b, { action: "checkpoint", receive: true })).events?.[0]?.message, "before first turn");
	for (let i = 0; i < TEAM_MAX_EVENTS; i++) await request(b, { action: "report", message: `report${i}` });
	for (const worker of workers) hub.complete(worker, outcome);
	assert.deepEqual(await request(a, { action: "checkpoint", receive: false }), { ok: true });
	assert.deepEqual(await request(a, { action: "checkpoint" }), { ok: true });
	const first = await request(a, { action: "checkpoint", receive: true });
	const second = await request(a, { action: "checkpoint", receive: true });
	assert.equal(first.events?.length, 64);
	assert.equal(second.events?.length, 8);
	assert.ok(second.events?.every((event) => event.kind === "result"));
	assert.deepEqual((await request(a, { action: "checkpoint", receive: true })).events, []);
});

test("Team snapshots cap UTF-8 outcomes without modifying native output, including JSON escaping overhead", async (t) => {
	const { hub, a, workers, request, id } = fixture(8); t.after(() => hub.dispose());
	const native = { status: "failed", output: "中🙂".repeat(20_000), error: "错🙂".repeat(20_000) } as const;
	// A bounded event count alone is insufficient when JSON expands control characters sixfold.
	for (let i = 0; i < 64; i++) await request(workers[0]!, { action: "report", message: "\u0000".repeat(8192) });
	for (const worker of workers) hub.complete(worker, native);
	const snapshot = hub.get(id);
	for (const member of snapshot.members.filter((member) => member.role === "worker")) {
		assert.ok(Buffer.byteLength(member.output!) <= 16 * 1024);
		assert.ok(Buffer.byteLength(member.error!) <= 8 * 1024);
		assert.match(member.output!, /\[truncated\]$/);
		assert.match(member.error!, /\[truncated\]$/);
		assert.doesNotMatch(member.output!, /\uFFFD/);
		assert.doesNotMatch(member.error!, /\uFFFD/);
	}
	assert.equal(native.output, "中🙂".repeat(20_000));
	assert.equal(native.error, "错🙂".repeat(20_000));
	let received = 0;
	while (received < 72) {
		const reply = await request(a, { action: "wait", wait: { kind: "message" } });
		assert.ok(reply.events!.length > 0 && reply.events!.length <= 64);
		assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 1024 * 1024);
		received += reply.events!.length;
	}
	assert.equal(received, 72);
	await hub.waitForWorkers(a);
	hub.complete(a, { status: "completed", output: "\u0000".repeat(100_000), error: "\u0000".repeat(100_000) });
	const coordinator = hub.get(id).members.find((member) => member.id === "A")!;
	assert.ok(Buffer.byteLength(JSON.stringify(coordinator.output)) <= 16 * 1024 + 2);
	assert.ok(Buffer.byteLength(JSON.stringify(coordinator.error)) <= 8 * 1024 + 2);
	assert.ok(Buffer.byteLength(JSON.stringify(hub.get(id))) < 1024 * 1024);
});

for (const mode of ["grant", "barrier", "cancel"] as const) {
	test(`journal exception during ${mode} fails closed and settles pending work without recursive persistence`, async (t) => {
		let fail = false;
		let failures = 0;
		const { hub, a, b, request, id } = fixture(1, { onSnapshot: () => {
			if (fail) { failures++; throw new Error("disk full"); }
		} });
		t.after(() => hub.dispose());
		const barrier = hub.waitForWorkers(a);
		const rejected = assert.rejects(barrier, /journal failed.*disk full/);
		let pending: Promise<unknown>;
		if (mode === "grant") {
			fail = true;
			pending = request(b, { action: "checkpoint" }).then((reply) => { assert.equal(reply.ok, false); assert.match(reply.error!, /journal failed/); });
		} else if (mode === "barrier") {
			fail = true;
			assert.throws(() => hub.complete(b, outcome), /journal failed/);
			pending = Promise.resolve();
		} else {
			pending = request(b, { action: "wait", wait: { kind: "message" } }).then((reply) => { assert.equal(reply.ok, false); });
			fail = true;
			assert.doesNotThrow(() => hub.cancel(id));
		}
		await pending; await rejected;
		assert.equal(failures, 1);
		assert.equal(hub.signal(id).aborted, true);
		assert.equal(hub.get(id).phase, "failed");
		hub.complete(b, outcome); hub.complete(a, outcome);
		assert.equal(hub.get(id).phase, "failed");
		assert.notEqual(hub.get(id).members.find((member) => member.id === "A")?.state, "completed");
		assert.equal((await request(b, { action: "checkpoint" })).ok, false);
	});
}

test("prepare journal failure is surfaced and accidental async rejection is observed", async (t) => {
	for (const callback of [() => { throw new Error("disk full"); }, async () => { throw new Error("async disk full"); }]) {
		const hub = new TeamHub({ onSnapshot: callback }); t.after(() => hub.dispose());
		assert.throws(() => hub.prepare({ coordinator: "A", workers: ["B"] }), /journal failed/);
		await tick();
		const [snapshot] = hub.list();
		assert.equal(snapshot?.phase, "failed");
		assert.equal(hub.signal(snapshot!.id).aborted, true);
	}
});

test("non-durable async observer failure stays isolated", async (t) => {
	const { hub, b, request, id } = fixture(1); t.after(() => hub.dispose());
	const off = hub.subscribe(async () => { throw new Error("observer failed"); });
	assert.equal((await request(b, { action: "checkpoint" })).ok, true);
	await tick(); off();
	assert.equal(hub.get(id).phase, "running");
	assert.equal(hub.signal(id).aborted, false);
});

test("admission journal failure releases the previously blocked checkpoint", async (t) => {
	let fail = false;
	const hub = new TeamHub({ onSnapshot: () => { if (fail) throw new Error("admission persist failed"); } });
	t.after(() => hub.dispose());
	const snapshot = hub.prepare({ coordinator: "A", workers: ["B"] });
	const [a] = hub.join(snapshot.id, ["A"]);
	const pending = hub.request(a!, { requestId: "checkpoint", sequence: 1, action: "checkpoint" });
	fail = true;
	assert.throws(() => hub.join(snapshot.id, ["B"]), /journal failed/);
	assert.equal((await pending).ok, false);
	assert.equal(hub.get(snapshot.id).phase, "failed");
});

test("journal reentry cannot leak a successful reply before persistence throws", async (t) => {
	let reenter: (() => void) | undefined;
	const { hub, a, b, request, id } = fixture(1, { onSnapshot: () => { reenter?.(); } });
	t.after(() => hub.dispose());
	let nested: Promise<unknown> | undefined;
	reenter = () => {
		reenter = undefined;
		nested = request(b, { action: "checkpoint" }).then((reply) => assert.equal(reply.ok, false));
		throw new Error("journal failure after nested grant");
	};
	assert.equal((await request(a, { action: "send", to: "B1", message: "trigger" })).ok, false);
	await nested;
	assert.equal(hub.get(id).phase, "failed");
});

test("alias rules match host and team/history session capacity is explicitly bounded", (t) => {
	const hub = new TeamHub(); t.after(() => hub.dispose());
	for (const alias of ["has space", "中文", "-leading", "a/b", "a\nb"]) {
		assert.throws(() => hub.prepare({ coordinator: alias, workers: ["B"] }), /alias/);
		assert.throws(() => hub.prepare({ coordinator: "A", workers: [alias] }), /alias/);
	}
	for (let i = 0; i < 32; i++) hub.cancel(hub.prepare({ coordinator: "A", workers: ["B"] }).id);
	assert.equal(hub.list().length, 32);
	assert.throws(() => hub.prepare({ coordinator: "A", workers: ["B"] }), /capacity/);
	const restored = new TeamHub(); t.after(() => restored.dispose());
	restored.restore(hub.list());
	assert.equal(restored.list().length, 32);
	assert.throws(() => restored.prepare({ coordinator: "A", workers: ["B"] }), /capacity/);
	assert.throws(() => restored.restore([{ ...hub.list()[0]!, id: "extra" }]), /capacity/);
});

test("restore validates unknown input atomically and bounds known fields without retaining arbitrary properties", (t) => {
	const source = new TeamHub(); t.after(() => source.dispose());
	const snapshot = source.prepare({ coordinator: "A", workers: ["B"] });
	const hub = new TeamHub(); t.after(() => hub.dispose());
	const invalid: unknown[] = [null, {}, { ...snapshot, workers: ["bad alias"] }, { ...snapshot, workers: ["A"] },
		{ ...snapshot, phase: "fake" }, { ...snapshot, deadline: NaN }, { ...snapshot, seq: -1 },
		{ ...snapshot, members: [snapshot.members[0], snapshot.members[0]] },
		{ ...snapshot, phase: "completed" }, { ...snapshot, events: [{ seq: 1, kind: "fake" }] },
		{ ...snapshot, seq: 1, events: [{ seq: 1, kind: "message", from: "outsider" }] },
		{ ...snapshot, members: snapshot.members.map((member) => ({ ...member, output: {} })) }];
	for (const value of invalid) {
		assert.throws(() => hub.restore([snapshot, value] as TeamSnapshot[]));
		assert.equal(hub.list().length, 0);
	}
	assert.throws(() => hub.restore(null as unknown as TeamSnapshot[]));
	assert.throws(() => hub.restore(Array.from({ length: 33 }, (_, i) => ({ ...snapshot, id: `id${i}` }))), /capacity/);
	const restored = { ...snapshot, secret: "not persisted", members: snapshot.members.map((member) => ({
		...member, output: "🙂".repeat(100_000), binding: "not persisted",
	})) };
	hub.restore([restored]);
	const history = hub.get(snapshot.id);
	assert.equal(history.phase, "interrupted");
	assert.ok(history.members.every((member) => Buffer.byteLength(member.output!) <= 16 * 1024));
	assert.doesNotMatch(JSON.stringify(history), /not persisted/);
});

test("cancel while native cleanup is pending cannot deliver a successful coordinator barrier", async (t) => {
	const { hub, a, workers, id } = fixture(2); t.after(() => hub.dispose());
	const barrier = assert.rejects(hub.waitForWorkers(a), /cleanup pending/);
	hub.cancel(id, "cleanup pending");
	for (const worker of workers) hub.complete(worker, outcome);
	hub.complete(a, outcome);
	await barrier;
	assert.equal(hub.get(id).phase, "cancelled");
	assert.ok(hub.get(id).members.every((member) => member.state === "cancelled"));
	await assert.rejects(hub.waitForWorkers(a), /terminal/);
});

test("restore is read-only interrupted history; snapshots and journal observers are isolated", async (t) => {
	const journal: TeamSnapshot[] = [];
	const { hub, a, b, request, id } = fixture(1, { onSnapshot: (snapshot) => journal.push(snapshot) });
	t.after(() => hub.dispose());
	let calls = 0;
	const unsubscribe = hub.subscribe((snapshot) => { calls++; snapshot.phase = "failed"; throw new Error("observer error"); });
	await request(b, { action: "send", to: "A", message: "journal" });
	unsubscribe();
	const count = calls;
	await request(a, { action: "wait", wait: { kind: "message" } });
	assert.equal(calls, count);
	assert.equal(hub.get(id).phase, "running");
	const snapshot = hub.get(id); snapshot.workers.push("fake");
	assert.deepEqual(hub.get(id).workers, ["B1"]);
	assert.ok(journal.some((s) => s.events.some((e) => e.message === "journal")));
	assert.ok(journal.every((s) => !JSON.stringify(s).includes(b.epoch)));
	const restored = new TeamHub(); t.after(() => restored.dispose());
	restored.restore([hub.get(id)]);
	assert.equal(restored.get(id).phase, "interrupted");
	assert.throws(() => restored.join(id, ["A"]), /interrupted/);
	assert.equal((await restored.request(b, { requestId: "old", sequence: 100, action: "checkpoint" })).ok, false);
	assert.throws(() => restored.complete(b, outcome), /stale/);
	const history = restored.get(id); restored.cancel(id); assert.deepEqual(restored.get(id), history);
	assert.equal(restored.list().length, 1);
});
