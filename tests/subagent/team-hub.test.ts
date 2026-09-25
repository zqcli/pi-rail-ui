import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamHub } from "../../tools/subagents/team-hub";
import { publicTeamReply, TEAM_DELIVERY_TYPE, TEAM_FRAME_BYTES } from "../../tools/subagents/team-extension";
import {
	isTeamAssignment, isTeamBrief, isTeamRequest, isTeamTaskResult,
	TEAM_MAX_EVENTS, TEAM_MAX_MESSAGE_BYTES, type TeamAssignment, type TeamBinding, type TeamBrief, type TeamRequest, type TeamSnapshot, type TeamTaskResult,
} from "../../tools/subagents/team-protocol";

function fixture(count = 2, options: ConstructorParameters<typeof TeamHub>[0] = {}) {
	const hub = new TeamHub(options);
	const snapshot = hub.prepare({ coordinator: "A", workers: Array.from({ length: count }, (_, i) => `B${i + 1}`) });
	const [a] = hub.join(snapshot.id, ["A"]);
	const workers = hub.join(snapshot.id, snapshot.workers);
	const sequences = new Map<string, number>();
	const request = async (binding: TeamBinding, fields: Omit<TeamRequest, "requestId" | "sequence">, signal?: AbortSignal) => {
		const sequence = (sequences.get(binding.memberId) ?? 0) + 1;
		sequences.set(binding.memberId, sequence);
		const requestId = `${binding.memberId}-${sequence}`;
		const reply = await hub.request(binding, { requestId, sequence, ...fields }, signal);
		assert.equal(reply.from, "@hub");
		assert.equal(reply.to, binding.memberId);
		assert.equal(reply.requestId, requestId);
		return reply;
	};
	return { hub, id: snapshot.id, a: a!, workers, b: workers[0]!, request };
}
const outcome = { status: "completed", output: "native result" } as const;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
// Control/wait replies carry a compact current status, not the history or full outcomes.
const states = (snapshot: TeamSnapshot | undefined) => snapshot?.members.map((member) => [member.id, member.state, member.waitingFor]);

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

for (const recipient of ["explicit", "omitted", "normalized-null"] as const) {
	test(`report recipient ${recipient} delivers atomically to coordinator and waits for its reply`, async (t) => {
		const { hub, a, b, request } = fixture(); t.after(() => hub.dispose());
		// Child normalization removes null; the Hub wire contract remains optional string.
		const to = recipient === "explicit" ? a.memberId : recipient === "normalized-null" ? null : undefined;
		const report = { action: "report", message: "blocked", wait: { kind: "message" }, ...(to == null ? {} : { to }) } as const;
		assert.equal(Object.hasOwn(report, "to"), recipient === "explicit");
		let replied = false;
		const off = hub.subscribe((snapshot) => {
			if (!replied && snapshot.events.some((event) => event.kind === "report" && event.message === "blocked")) {
				replied = true;
				void request(a, { action: "send", to: b.memberId, message: "continue" });
			}
		});
		const result = await request(b, report);
		off();
		assert.equal(result.ok, true);
		assert.equal(result.events?.[0]?.message, "continue");
		const inbox = await request(a, { action: "checkpoint", receive: true });
		const delivered = inbox.events?.filter((event) => event.kind === "report");
		assert.equal(delivered?.length, 1);
		assert.equal(delivered?.[0]?.to, a.memberId);
		assert.equal(delivered?.[0]?.from, b.memberId);
	});
}

for (const recipient of ["peer", "self", "unknown", "foreign-coordinator", "foreign-team-id", "whitespace", "case", "empty"] as const) {
	for (const withWait of [false, true]) {
		test(`report recipient ${recipient}, wait=${withWait}: reject without delivery, state changes or permit release`, async (t) => {
			const { hub, a, b, workers, request, id } = fixture(5); t.after(() => hub.dispose());
			const other = hub.prepare({ coordinator: "OtherA", workers: ["OtherB"] });
			const to = { peer: "B2", self: "B1", unknown: "missing", "foreign-coordinator": other.coordinator,
				"foreign-team-id": other.id, whitespace: " A ", case: "a", empty: "" }[recipient];
			for (const worker of workers.slice(0, 4)) await request(worker, { action: "checkpoint" });
			let admitted = false;
			const queue = request(workers[4]!, { action: "checkpoint" }).then((reply) => { admitted = true; return reply; });
			let coordinatorReady = false;
			const coordinatorWait = request(a, { action: "wait", wait: { kind: "message" } }).then((reply) => { coordinatorReady = true; return reply; });
			const before = hub.get(id);
			const otherBefore = hub.get(other.id);
			let settled = false;
			const invalid = request(b, { action: "report", to, message: "must not deliver", ...(withWait ? { wait: { kind: "message" as const } } : {}) })
				.then((reply) => { settled = true; return reply; });
			await tick();
			assert.equal(settled, true, "invalid report+wait must return an error, not park");
			const rejected = await invalid;
			assert.equal(rejected.ok, false);
			assert.match(rejected.error!, /report.*only.*coordinator.*A.*send/i);
			assert.deepEqual(hub.get(id), before, "no report/state event or waitingFor mutation");
			assert.deepEqual(hub.get(other.id), otherBefore);
			assert.equal(coordinatorReady, false, "invalid report must not wake A");
			assert.equal(admitted, false, "invalid report must retain B1's execution permit");
			// A corrected fresh request remains usable and is the first operation to release B1's permit.
			const corrected = request(b, { action: "report", to: a.memberId, message: "corrected", wait: { kind: "message" } });
			assert.equal((await queue).ok, true);
			assert.equal((await coordinatorWait).events?.find((event) => event.kind === "report")?.message, "corrected");
			await request(a, { action: "send", to: b.memberId, message: "continue" });
			assert.equal((await corrected).events?.[0]?.message, "continue");
		});
	}
}

test("report recipient errors retain request dedup and sequence rules while permitting correction", async (t) => {
	const { hub, a, b, id } = fixture(); t.after(() => hub.dispose());
	const invalid: TeamRequest = { requestId: "wrong-recipient", sequence: 1, action: "report", to: "B2", message: "report" };
	const before = hub.get(id);
	const rejected = await hub.request(b, invalid);
	assert.equal(rejected.ok, false);
	assert.deepEqual(await hub.request(b, invalid), rejected);
	assert.match((await hub.request(b, { ...invalid, to: a.memberId })).error!, /Conflicting duplicate/);
	assert.match((await hub.request(b, { ...invalid, requestId: "stale", to: a.memberId })).error!, /Stale/);
	assert.deepEqual(hub.get(id), before);
	assert.equal((await hub.request(b, { ...invalid, requestId: "corrected", sequence: 2, to: a.memberId })).ok, true);
});

test("explicit report recipient preserves manual pause and inbox overflow semantics", async (t) => {
	const { hub, a, b, request, id } = fixture(); t.after(() => hub.dispose());
	await request(b, { action: "checkpoint" });
	await request(a, { action: "control", command: "pause", to: b.memberId });
	const before = hub.get(id);
	assert.equal((await request(b, { action: "report", to: "B2", message: "invalid" })).ok, false);
	assert.deepEqual(hub.get(id), before);
	let settled = false;
	const pending = request(b, { action: "report", to: a.memberId, message: "blocked", wait: { kind: "message" } }).then((reply) => { settled = true; return reply; });
	await request(a, { action: "send", to: b.memberId, message: "continue" });
	await tick(); assert.equal(settled, false);
	assert.equal(hub.get(id).members.find((member) => member.id === b.memberId)?.state, "paused");
	await request(a, { action: "control", command: "resume", to: b.memberId });
	assert.equal((await pending).ok, true);
	for (let i = 1; i < TEAM_MAX_EVENTS; i++) assert.equal((await request(b, { action: "report", to: a.memberId, message: `report${i}` })).ok, true);
	const full = hub.get(id);
	assert.match((await request(b, { action: "report", to: a.memberId, message: "overflow", wait: { kind: "message" } })).error!, /overflow/);
	assert.deepEqual(hub.get(id), full);
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

test("control snapshots distinguish pause_requested from confirmed paused and reflect resume admission", async (t) => {
	const { hub, a, b, request, id } = fixture(1); t.after(() => hub.dispose());
	await request(b, { action: "checkpoint" });
	const requested = await request(a, { action: "control", to: b.memberId, command: "pause" });
	assert.equal(requested.snapshot?.members.find((member) => member.id === b.memberId)?.state, "pause_requested");
	assert.deepEqual(requested.snapshot?.events, [], "control status replies do not repeat the event history");
	assert.equal(hub.get(id).events.find((event) => event.seq === requested.receipt?.seq)?.message, "pause");
	assert.deepEqual(states(requested.snapshot), states(hub.get(id)));
	const checkpoint = request(b, { action: "checkpoint" });
	const confirmed = await request(a, { action: "control", to: b.memberId, command: "pause" });
	assert.equal(confirmed.snapshot?.members.find((member) => member.id === b.memberId)?.state, "paused");
	const resumed = await request(a, { action: "control", to: b.memberId, command: "resume" });
	assert.equal((await checkpoint).ok, true);
	assert.equal(resumed.snapshot?.members.find((member) => member.id === b.memberId)?.state, "running");
	assert.deepEqual(states(resumed.snapshot), states(hub.get(id)));
	for (const reply of [requested, confirmed, resumed]) assert.doesNotThrow(() => publicTeamReply(reply));
});

test("control snapshots preserve unresolved dependencies and redirect never clears manual pause", async (t) => {
	const { hub, a, b, request, id } = fixture(); t.after(() => hub.dispose());
	let ready = false;
	const dependency = request(b, { action: "wait", wait: { kind: "member", member: "B2" } }).then((reply) => { ready = true; return reply; });
	await request(a, { action: "control", to: b.memberId, command: "pause" });
	const resumed = await request(a, { action: "control", to: b.memberId, command: "resume" });
	const waiting = resumed.snapshot?.members.find((member) => member.id === b.memberId);
	assert.equal(waiting?.state, "waiting");
	assert.equal(waiting?.waitingFor, "B2");
	await tick(); assert.equal(ready, false);
	await request(a, { action: "control", to: b.memberId, command: "pause" });
	const redirected = await request(a, { action: "control", to: b.memberId, command: "redirect", message: "new direction" });
	const paused = redirected.snapshot?.members.find((member) => member.id === b.memberId);
	assert.equal(paused?.state, "paused");
	assert.equal(paused?.waitingFor, "message");
	assert.equal(paused?.instructionRevision, 1);
	assert.equal(hub.get(id).events.at(-1)?.message, "redirect");
	assert.ok(hub.get(id).events.some((event) => event.kind === "message" && event.message === "new direction"));
	assert.deepEqual(states(redirected.snapshot), states(hub.get(id)));
	await tick(); assert.equal(ready, false);
	await request(a, { action: "control", to: b.memberId, command: "resume" });
	assert.deepEqual((await dependency).events, [], "redirect wakes the parked tool without consuming its context-slot direction");
	const received = await request(b, { action: "checkpoint", receive: true });
	assert.equal(received.events?.[0]?.message, "new direction");
	for (const reply of [resumed, redirected]) assert.doesNotThrow(() => publicTeamReply(reply));
});

test("control snapshots are detached from Hub state and the cached duplicate reply", async (t) => {
	const { hub, a, b, workers, id } = fixture(); t.after(() => hub.dispose());
	const command: TeamRequest = { requestId: "pause-snapshot", sequence: 1, action: "control", to: b.memberId, command: "pause" };
	const reply = await hub.request(a, command);
	assert.ok(reply.snapshot);
	const before = hub.get(id);
	for (const binding of [a, ...workers]) assert.ok(!JSON.stringify(reply).includes(binding.epoch));
	reply.snapshot.members[0]!.state = "failed";
	reply.snapshot.workers.push("fake");
	reply.snapshot.events.push({ seq: 999, kind: "message", message: "mutated" });
	assert.deepEqual(hub.get(id), before);
	const cached = (await hub.request(a, command)).snapshot;
	assert.deepEqual(states(cached), states(before));
	assert.deepEqual(cached?.workers, before.workers);
	assert.deepEqual(cached?.events, []);
});

test("rejected controls have no snapshot or state/message side effects", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(); t.after(() => hub.dispose());
	hub.complete(workers[1]!, outcome);
	const invalid: Array<{ binding: TeamBinding; fields: Omit<TeamRequest, "requestId" | "sequence"> }> = [
		{ binding: b, fields: { action: "control", to: b.memberId, command: "pause" } },
		{ binding: a, fields: { action: "control", to: "unknown", command: "pause" } },
		{ binding: a, fields: { action: "control", to: a.memberId, command: "pause" } },
		{ binding: a, fields: { action: "control", to: "B2", command: "resume" } },
		{ binding: a, fields: { action: "control", to: b.memberId } },
		{ binding: a, fields: { action: "control", to: b.memberId, command: "redirect" } },
	];
	for (const { binding, fields } of invalid) {
		const before = hub.get(id);
		const reply = await request(binding, fields);
		assert.equal(reply.ok, false);
		assert.equal(reply.snapshot, undefined);
		assert.deepEqual(hub.get(id), before);
		assert.doesNotThrow(() => publicTeamReply(reply));
	}
	for (let i = 0; i < TEAM_MAX_EVENTS; i++) await request(a, { action: "send", to: b.memberId, message: "full" });
	const before = hub.get(id);
	const redirected = await request(a, { action: "control", to: b.memberId, command: "redirect", message: "reserved direction" });
	assert.equal(redirected.ok, true, "the direction slot remains available when the ordinary inbox is full");
	assert.equal(redirected.receipt?.status, "applied");
	assert.equal(hub.get(id).members.find((member) => member.id === b.memberId)?.instructionRevision, 1);
	const afterRedirect = hub.get(id);
	assert.notDeepEqual(afterRedirect, before);
	const overflow = await request(a, { action: "send", to: b.memberId, message: "ordinary overflow" });
	assert.equal(overflow.ok, false);
	assert.match(overflow.error!, /overflow/);
	assert.deepEqual(hub.get(id), afterRedirect);
});

test("control snapshots remain publicTeamReply-compatible with a full roster and bounded large results", async (t) => {
	const { hub, a, b, workers, request } = fixture(8); t.after(() => hub.dispose());
	for (let i = 0; i < TEAM_MAX_EVENTS; i++) await request(b, { action: "report", message: "中".repeat(2700) });
	for (const worker of workers.slice(1)) hub.complete(worker, { status: "failed", output: "🙂".repeat(10_000), error: "错".repeat(10_000) });
	for (const command of ["pause", "redirect", "resume"] as const) {
		const reply = await request(a, { action: "control", to: b.memberId, command, ...(command === "redirect" ? { message: "direction" } : {}) });
		assert.equal(reply.ok, true);
		assert.equal(reply.snapshot?.members.length, 9);
		assert.ok(reply.snapshot!.events.length <= TEAM_MAX_EVENTS);
		assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 1024 * 1024);
		assert.doesNotThrow(() => publicTeamReply(JSON.parse(JSON.stringify(reply))));
	}
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
	assert.deepEqual((await pending).events, [], "redirect wakes the parked wait but remains reserved for context delivery");
	const received = await request(b, { action: "checkpoint", receive: true });
	assert.equal(received.events?.[0]?.message, "new direction");
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
			assert.equal(gate.ok, true);
			assert.deepEqual(gate.events, undefined);
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
	assert.equal((await request(b, { action: "checkpoint", receive: false })).ok, true);
	assert.equal((await request(b, { action: "checkpoint" })).ok, true);
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

test("paused permission gate does not consume redirect; receiving context gets the reserved direction", async (t) => {
	const { hub, a, b, request } = fixture(1); t.after(() => hub.dispose());
	await request(b, { action: "checkpoint", receive: true });
	await request(a, { action: "control", command: "pause", to: "B1" });
	const gate = request(b, { action: "checkpoint", receive: false });
	await request(a, { action: "control", command: "redirect", to: "B1", message: "redirect before wait" });
	await request(a, { action: "control", command: "resume", to: "B1" });
	assert.equal((await gate).ok, true);
	const received = await request(b, { action: "checkpoint", receive: true });
	assert.equal(received.revision, 1);
	assert.equal(received.events?.[0]?.message, "redirect before wait");
});

test("running checkpoint consumes peer messages and redirects without permit churn or journal writes", async (t) => {
	const journal: TeamSnapshot[] = [];
	const observed: TeamSnapshot[] = [];
	const { hub, a, b, workers, request, id } = fixture(5, { onSnapshot: (snapshot) => { journal.push(snapshot); } });
	t.after(() => hub.dispose());
	t.after(hub.subscribe((snapshot) => { observed.push(snapshot); }));
	for (const worker of workers.slice(0, 4)) await request(worker, { action: "checkpoint" });
	let queuedGranted = false;
	const queued = request(workers[4]!, { action: "checkpoint" }).then(() => { queuedGranted = true; });
	await request(workers[1]!, { action: "send", to: "B1", message: "peer instruction" });
	await request(a, { action: "control", to: "B1", command: "redirect", message: "new direction" });
	const seq = hub.get(id).seq;
	const count = journal.length;
	const live = observed.length;
	const checkpoint: TeamRequest = { action: "checkpoint", receive: true, sequence: 100, requestId: "running-gate" };
	const reply = await hub.request(b, checkpoint);
	assert.deepEqual(reply.events?.map((event) => event.message), ["peer instruction", "new direction"]);
	assert.deepEqual(await hub.request(b, checkpoint), reply);
	for (let i = 101; i < 120; i++) {
		assert.deepEqual((await hub.request(b, { ...checkpoint, sequence: i, requestId: `gate-${i}` })).events, []);
	}
	assert.equal(hub.get(id).seq, seq);
	assert.equal(journal.length, count, "only milestones are journaled; revision observation is live state");
	assert.equal(observed.length, live + 1, "live observers see the observed revision once");
	assert.equal(observed.at(-1)?.members.find((member) => member.id === "B1")?.observedRevision, 1);
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
	assert.equal((await request(a, { action: "checkpoint", receive: false })).ok, true);
	assert.equal((await request(a, { action: "checkpoint" })).ok, true);
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
			// Permit grants are live state, not journal milestones; the next outcome is.
			assert.equal((await request(b, { action: "checkpoint" })).ok, true);
			assert.equal(failures, 0);
			assert.throws(() => hub.complete(b, outcome), /journal failed/);
			pending = Promise.resolve();
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
	const { hub, b, workers, request, id } = fixture(2, { onSnapshot: () => { reenter?.(); } });
	t.after(() => hub.dispose());
	let nested: Promise<unknown> | undefined;
	reenter = () => {
		reenter = undefined;
		nested = request(workers[1]!, { action: "checkpoint" }).then((reply) => assert.equal(reply.ok, false));
		throw new Error("journal failure after nested grant");
	};
	assert.throws(() => hub.complete(b, outcome), /journal failed/);
	await nested;
	assert.equal(hub.get(id).phase, "failed");
});

test("alias rules match host; capacity evicts oldest finished history and bounds only active teams", (t) => {
	let now = 1000;
	const hub = new TeamHub({ now: () => now }); t.after(() => hub.dispose());
	for (const alias of ["has space", "中文", "-leading", "a/b", "a\nb"]) {
		assert.throws(() => hub.prepare({ coordinator: alias, workers: ["B"] }), /alias/);
		assert.throws(() => hub.prepare({ coordinator: "A", workers: [alias] }), /alias/);
	}
	const ids: string[] = [];
	for (let i = 0; i < 32; i++) { now++; ids.push(hub.prepare({ coordinator: "A", workers: ["B"] }).id); hub.cancel(ids.at(-1)!); }
	assert.equal(hub.list().length, 32);
	now++;
	const next = hub.prepare({ coordinator: "A", workers: ["B"] });
	assert.equal(hub.list().length, 32);
	assert.throws(() => hub.get(ids[0]!), /Unknown team/, "the oldest finished team is evicted");
	assert.equal(hub.get(ids[1]!).phase, "cancelled");
	const restored = new TeamHub(); t.after(() => restored.dispose());
	assert.deepEqual(restored.restore(hub.list()), { restored: 32, skipped: 0 });
	assert.equal(restored.list().length, 32);
	assert.equal(restored.get(next.id).phase, "interrupted");
	assert.deepEqual(restored.restore([{ ...hub.get(ids[1]!), id: "extra", seq: 0, events: [] }]), { restored: 0, skipped: 1 },
		"history beyond capacity is skipped, not an error");
	assert.doesNotThrow(() => restored.prepare({ coordinator: "A", workers: ["B"] }));
	const active = new TeamHub(); t.after(() => active.dispose());
	for (let i = 0; i < 32; i++) active.prepare({ coordinator: "A", workers: ["B"] });
	assert.throws(() => active.prepare({ coordinator: "A", workers: ["B"] }), /32 active teams/);
});

test("restore skips invalid entries individually and bounds known fields without retaining arbitrary properties", (t) => {
	const source = new TeamHub(); t.after(() => source.dispose());
	const snapshot = source.prepare({ coordinator: "A", workers: ["B"] });
	const invalid: unknown[] = [null, {}, { ...snapshot, workers: ["bad alias"] }, { ...snapshot, workers: ["A"] },
		{ ...snapshot, phase: "fake" }, { ...snapshot, deadline: NaN }, { ...snapshot, seq: -1 },
		{ ...snapshot, members: [snapshot.members[0], snapshot.members[0]] },
		{ ...snapshot, phase: "completed" }, { ...snapshot, events: [{ seq: 1, kind: "fake" }] },
		{ ...snapshot, seq: 1, events: [{ seq: 1, kind: "message", from: "outsider" }] },
		{ ...snapshot, members: snapshot.members.map((member) => ({ ...member, output: {} })) }];
	for (const value of invalid) {
		const hub = new TeamHub(); t.after(() => hub.dispose());
		const other = { ...snapshot, id: "valid-neighbour" };
		assert.deepEqual(hub.restore([other, value] as TeamSnapshot[]), { restored: 1, skipped: 1 });
		assert.deepEqual(hub.list().map((team) => team.id), ["valid-neighbour"], "one damaged entry cannot hide valid history");
	}
	const hub = new TeamHub(); t.after(() => hub.dispose());
	assert.throws(() => hub.restore(null as unknown as TeamSnapshot[]));
	const many = Array.from({ length: 40 }, (_, i) => ({ ...snapshot, id: `id${i}`, createdAt: i, deadline: i + 1000 }));
	assert.deepEqual(hub.restore(many), { restored: 32, skipped: 8 });
	assert.ok(hub.list().every((team) => Number(team.id.slice(2)) >= 8), "the newest history is kept");
	const fresh = new TeamHub(); t.after(() => fresh.dispose());
	const restored = { ...snapshot, secret: "not persisted", members: snapshot.members.map((member) => ({
		...member, output: "🙂".repeat(100_000), binding: "not persisted",
	})) };
	fresh.restore([restored]);
	const history = fresh.get(snapshot.id);
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

test("restore is read-only interrupted history; only newly interrupted teams are journaled again", async (t) => {
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
	assert.ok(journal.every((s) => s.events.every((e) => e.message !== "journal")), "a message is not a journal milestone");
	assert.ok(journal.every((s) => !JSON.stringify(s).includes(b.epoch)));
	const reloaded: TeamSnapshot[] = [];
	const restored = new TeamHub({ onSnapshot: (value) => reloaded.push(value) }); t.after(() => restored.dispose());
	restored.restore([hub.get(id)]);
	assert.equal(restored.get(id).phase, "interrupted");
	assert.deepEqual(reloaded.map((value) => value.phase), ["interrupted"]);
	const again = new TeamHub({ onSnapshot: (value) => reloaded.push(value) }); t.after(() => again.dispose());
	again.restore([restored.get(id)]);
	assert.equal(reloaded.length, 1, "terminal history is never re-appended on later reloads");
	assert.throws(() => restored.join(id, ["A"]), /interrupted/);
	assert.equal((await restored.request(b, { requestId: "old", sequence: 100, action: "checkpoint" })).ok, false);
	assert.throws(() => restored.complete(b, outcome), /stale/);
	const history = restored.get(id); restored.cancel(id); assert.deepEqual(restored.get(id), history);
	assert.equal(restored.list().length, 1);
});

test("shared Team validators enforce bounded UTF-8 fields, arrays, and known shapes", () => {
	const result = { status: "partial", summary: "Checked the relevant path", findings: ["One finding"],
		evidence: [{ source: "test", locator: "tests/example.test.ts:4", basis: "verified" }], limitations: [], artifacts: ["report.md"] } as const;
	assert.equal(isTeamTaskResult(result), true);
	assert.equal(isTeamTaskResult({ ...result, extra: true }), false);
	assert.equal(isTeamTaskResult({ status: "succeeded", summary: "🙂".repeat(2049) }), false);
	assert.equal(isTeamTaskResult({ status: "succeeded", summary: "ok", findings: Array(33).fill("finding") }), false);
	assert.equal(isTeamTaskResult({ status: "succeeded", summary: "ok", evidence: [{ source: "x", basis: "observed", secret: "x" }] }), false);
	assert.equal(isTeamTaskResult({ status: "succeeded", summary: "s".repeat(8192), findings: ["f".repeat(4500)] }), false,
		"task result JSON is bounded in aggregate, not only per field");

	const brief = { goal: "Review the change", acceptanceCriteria: ["Check regressions"], constraints: ["Read only"],
		authorizations: [{ member: "B1", allowed: ["read files"], forbidden: ["write files"] }] } as const;
	assert.equal(isTeamBrief(brief), true);
	assert.equal(isTeamBrief({ ...brief, unknown: "field" }), false);
	assert.equal(isTeamBrief({ goal: "goal", constraints: ["🙂".repeat(2049)] }), false);
	assert.equal(isTeamBrief({ goal: "goal", authorizations: Array(10).fill({ member: "B1", allowed: ["read"] }) }), false);
	assert.equal(isTeamBrief({ goal: "g".repeat(8192), target: "t".repeat(8192),
		acceptanceCriteria: ["a".repeat(8192)], constraints: ["c".repeat(8192)] }), false,
		"shared brief is bounded in aggregate, not only per field");

	const assignment = { memberId: "B1", task: "Inspect the tests", cwd: "D:/repo", model: "provider/model", fastMode: true, searchMode: "live" } as const;
	assert.equal(isTeamAssignment(assignment), true);
	assert.equal(isTeamAssignment({ ...assignment, extra: true }), false);
	assert.equal(isTeamAssignment({ ...assignment, fastMode: "yes" }), false);
	assert.equal(isTeamAssignment({ ...assignment, task: "🙂".repeat(2049) }), false);
	assert.equal(isTeamAssignment({ memberId: "B1", task: "t".repeat(8192), cwd: "c".repeat(8192) }), false,
		"assignment JSON is bounded in aggregate, not only per field");

	assert.equal(isTeamRequest({ requestId: "r", sequence: 1, action: "wait", wait: { kind: "message", from: "B2" } }), true);
	assert.equal(isTeamRequest({ requestId: "r", sequence: 1, action: "wait", wait: { kind: "member", member: "B2", from: "B2" } }), false);
	assert.equal(isTeamRequest({ requestId: "r", sequence: 1, action: "checkpoint", revision: -1 }), false);
	assert.equal(isTeamRequest({ requestId: "r", sequence: 1, action: "finish", message: "done", result }), false);
	const negativeClock = new TeamHub({ now: () => -0.5 });
	assert.throws(() => negativeClock.prepare({ coordinator: "A", workers: ["B"] }), /clock/);
	assert.deepEqual(negativeClock.list(), []);
	negativeClock.dispose();
});

test("prepare copies an authorized brief; join atomically stores copied assignments before admission", (t) => {
	const journal: TeamSnapshot[] = [];
	const hub = new TeamHub({ onSnapshot: (snapshot) => journal.push(snapshot) }); t.after(() => hub.dispose());
	const brief: TeamBrief = { goal: "Coordinate a review", constraints: ["Read only"], authorizations: [{ member: "B1", allowed: ["read files"] }] };
	const team = hub.prepare({ coordinator: "A", workers: ["B1", "B2"], brief });
	brief.goal = "caller mutation";
	brief.constraints![0] = "changed";
	assert.deepEqual(hub.get(team.id).brief, { goal: "Coordinate a review", constraints: ["Read only"], authorizations: [{ member: "B1", allowed: ["read files"] }] });
	assert.throws(() => hub.prepare({ coordinator: "C", workers: ["D"], brief: { goal: "x", authorizations: [{ member: "outsider", allowed: ["read"] }] } }), /authorization/);
	assert.equal(hub.list().length, 1, "invalid brief does not create a team");

	const before = hub.get(team.id);
	assert.throws(() => hub.join(team.id, ["A"], [{ memberId: "B1", task: "wrong cohort" }]), /match.*roster/);
	assert.throws(() => hub.join(team.id, ["A"], [{ memberId: "A", task: "valid", unknown: true } as unknown as TeamAssignment]), /valid assignment/);
	assert.deepEqual(hub.get(team.id), before, "invalid assignment cohorts do not bind members or start admission");
	const coordinatorAssignment: TeamAssignment = { memberId: "A", task: "Coordinate", cwd: "D:/repo", model: "m1" };
	const workerAssignments: TeamAssignment[] = [
		{ memberId: "B1", task: "Review tests", fastMode: true, searchMode: "live" },
		{ memberId: "B2", task: "Review code", fastMode: false, searchMode: "off" },
	];
	hub.join(team.id, ["A"], [coordinatorAssignment]);
	coordinatorAssignment.task = "mutated";
	hub.join(team.id, ["B2", "B1"], workerAssignments);
	workerAssignments[0]!.task = "mutated";
	const stored = hub.get(team.id);
	assert.equal(stored.members.find((member) => member.id === "A")?.assignment?.task, "Coordinate");
	assert.equal(stored.members.find((member) => member.id === "B1")?.assignment?.task, "Review tests");
	assert.equal(stored.members.find((member) => member.id === "B1")?.assignment?.fastMode, true);
	assert.ok(journal.some((snapshot) => snapshot.members.find((member) => member.id === "A")?.state === "starting"
		&& snapshot.members.find((member) => member.id === "A")?.assignment?.task === "Coordinate"));
	const restored = new TeamHub(); t.after(() => restored.dispose());
	restored.restore([stored]);
	assert.deepEqual(restored.get(team.id).brief, stored.brief);
	assert.deepEqual(restored.get(team.id).members.map((member) => member.assignment), stored.members.map((member) => member.assignment));
});

test("request replies are routed; messages and controls return accurate receipts; generated events are public v2", async (t) => {
	const hub = new TeamHub({ now: () => 1234.5 }); t.after(() => hub.dispose());
	const snapshot = hub.prepare({ coordinator: "A", workers: ["B1"] });
	const [a] = hub.join(snapshot.id, ["A"]);
	const [b] = hub.join(snapshot.id, ["B1"]);
	const sent = await hub.request(a!, { requestId: "send-1", sequence: 1, action: "send", to: "B1", message: "hello" });
	assert.deepEqual([sent.from, sent.to, sent.requestId], ["@hub", "A", "send-1"]);
	assert.equal(sent.receipt?.status, "queued");
	assert.equal(sent.receipt?.recipient, "B1");
	assert.equal(sent.receipt?.seq, sent.receipt?.messageId ? Number(sent.receipt.messageId.split(":").at(-1)) : undefined);
	const reported = await hub.request(b!, { requestId: "report-1", sequence: 1, action: "report", message: "progress" });
	assert.equal(reported.receipt?.status, "queued");
	assert.equal(reported.receipt?.recipient, "A");
	const control = await hub.request(a!, { requestId: "pause-1", sequence: 2, action: "control", command: "pause", to: "B1" });
	assert.equal(control.receipt?.status, "applied");
	assert.equal(control.receipt?.recipient, "B1");
	assert.equal(control.receipt?.seq, hub.get(snapshot.id).events.at(-1)?.seq);
	const before = hub.get(snapshot.id);
	const selfSend = await hub.request(a!, { requestId: "self-send", sequence: 3, action: "send", to: "A", message: "invalid" });
	assert.equal(selfSend.ok, false);
	assert.deepEqual([selfSend.from, selfSend.to, selfSend.requestId], ["@hub", "A", "self-send"]);
	assert.match(selfSend.error!, /self/);
	assert.deepEqual(hub.get(snapshot.id), before);
	const selfReport = await hub.request(a!, { requestId: "self-report", sequence: 4, action: "report", to: "A", message: "invalid" });
	assert.equal(selfReport.ok, false);
	assert.match(selfReport.error!, /self/);
	assert.deepEqual(hub.get(snapshot.id), before);
	hub.complete(b!, { status: "failed", output: "", error: "native failure" });
	hub.cancel(snapshot.id, "stop");
	const events = hub.get(snapshot.id).events;
	assert.ok(events.length > 0);
	for (const event of events) {
		assert.equal(event.version, 2);
		assert.equal(event.messageId, `${snapshot.id}:${event.seq}`);
		assert.equal(event.timestamp, 1234.5);
		if (["message", "report", "control"].includes(event.kind)) {
			assert.ok(["A", "B1"].includes(event.from!));
			assert.ok(["A", "B1"].includes(event.to!));
		} else {
			assert.equal(event.from, "@hub");
			assert.equal(event.to, "A");
		}
	}
});

test("coordinator terminal results use @hub routing to the parent", (t) => {
	const hub = new TeamHub(); t.after(() => hub.dispose());
	const team = hub.prepare({ coordinator: "A", workers: ["B"] });
	const [a] = hub.join(team.id, ["A"]);
	const [b] = hub.join(team.id, ["B"]);
	hub.complete(b!, { status: "failed", output: "", error: "worker failed" });
	hub.complete(a!, { status: "failed", output: "", error: "coordinator failed" });
	const result = hub.get(team.id).events.find((event) => event.kind === "result" && event.member === "A");
	assert.equal(result?.from, "@hub");
	assert.equal(result?.to, "@parent");
});

test("wait.from consumes only matching message events and acknowledges afterSeq within that sender stream", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	const old = await request(a, { action: "send", to: "B1", message: "old from A" });
	await request(workers[1]!, { action: "send", to: "B1", message: "keep from B2" });
	const before = hub.get(id);
	const unknown = await request(b, { action: "wait", wait: { kind: "message", from: "missing" } });
	assert.equal(unknown.ok, false);
	assert.match(unknown.error!, /sender/);
	const self = await request(b, { action: "wait", wait: { kind: "message", from: "B1" } });
	assert.equal(self.ok, false);
	assert.match(self.error!, /own|self/i);
	assert.deepEqual(hub.get(id), before);
	const nonMessage = await request(b, { action: "wait", wait: { kind: "member", member: "B2", from: "A" } });
	assert.equal(nonMessage.ok, false);
	assert.deepEqual(hub.get(id), before);
	let settled = false;
	const filtered = request(b, { action: "wait", wait: { kind: "message", from: "A", afterSeq: old.receipt!.seq! } })
		.then((reply) => { settled = true; return reply; });
	await tick();
	assert.equal(settled, false, "unmatched B2 messages do not wake a filtered wait");
	await request(a, { action: "send", to: "B1", message: "new from A" });
	const matched = await filtered;
	assert.deepEqual(matched.events?.map((event) => [event.kind, event.from, event.message]), [["message", "A", "new from A"]]);
	const unmatched = await request(b, { action: "wait", wait: { kind: "message" } });
	assert.deepEqual(unmatched.events?.map((event) => event.message), ["keep from B2"]);
});

test("wait.from wakes on a matching report and leaves other senders' messages queued", async (t) => {
	const { hub, a, b, workers, request } = fixture(2); t.after(() => hub.dispose());
	await request(workers[1]!, { action: "send", to: "A", message: "from B2" });
	let settled = false;
	const waiting = request(a, { action: "wait", wait: { kind: "message", from: "B1" } })
		.then((reply) => { settled = true; return reply; });
	await tick();
	assert.equal(settled, false);
	await request(b, { action: "report", message: "progress report" });
	const reply = await waiting;
	assert.deepEqual(reply.events?.map((event) => [event.kind, event.from, event.message]), [["report", "B1", "progress report"]]);
	const unmatched = await request(a, { action: "wait", wait: { kind: "message" } });
	assert.deepEqual(unmatched.events?.map((event) => [event.from, event.message]), [["B2", "from B2"]]);
});

test("a reserved latest redirect survives inbox byte caps, afterSeq ack, filtered waits, history eviction, and multiple redirects", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	for (let index = 0; index < TEAM_MAX_EVENTS; index++) {
		assert.equal((await request(a, { action: "send", to: "B1", message: "\u0000".repeat(TEAM_MAX_MESSAGE_BYTES) })).ok, true);
	}
	await request(a, { action: "control", to: "B1", command: "redirect", message: "first direction" });
	await request(a, { action: "control", to: "B1", command: "redirect", message: "latest direction" });
	const latestSeq = hub.get(id).seq;
	// Evict the redirect from bounded public history; the private latest-direction slot remains authoritative.
	for (let index = 0; index < TEAM_MAX_EVENTS; index++) {
		await request(workers[1]!, { action: "send", to: "A", message: `history filler ${index}` });
	}
	assert.ok(!hub.get(id).events.some((event) => event.message === "latest direction"));
	let ackSettled = false;
	const acknowledgeOld = request(b, { action: "wait", wait: { kind: "message", afterSeq: latestSeq } })
		.then((reply) => { ackSettled = true; return reply; });
	await tick();
	assert.equal(ackSettled, false, "afterSeq acknowledges ordinary inbox events, not the reserved redirect slot");
	await request(workers[1]!, { action: "send", to: "B1", message: "wake after acknowledgement" });
	assert.deepEqual((await acknowledgeOld).events?.map((event) => event.message), ["wake after acknowledgement"]);
	let settled = false;
	const filtered = request(b, { action: "wait", wait: { kind: "message", from: "B2", afterSeq: latestSeq } })
		.then((reply) => { settled = true; return reply; });
	await tick();
	assert.equal(settled, false, "pending redirect does not satisfy an unrelated filtered wait");
	await request(workers[1]!, { action: "send", to: "B1", message: "wake from B2" });
	const waitReply = await filtered;
	assert.deepEqual(waitReply.events?.map((event) => event.message), ["wake from B2"]);
	const context = await request(b, { action: "checkpoint", receive: true });
	assert.equal(context.revision, 2);
	assert.equal(context.events?.filter((event) => event.message === "latest direction").length, 1);
	assert.equal(context.events?.some((event) => event.message === "first direction"), false, "newer redirect supersedes the older pending direction");
	assert.equal(context.events?.[0]?.message, "latest direction", "reserved direction is returned in sequence order");
	assert.deepEqual(context.events?.map((event) => event.seq), [...(context.events?.map((event) => event.seq) ?? [])].sort((left, right) => left - right));
	const afterDelivery = await request(b, { action: "checkpoint", receive: true });
	assert.equal(afterDelivery.revision, 2);
	assert.equal(afterDelivery.events?.some((event) => event.message === "latest direction"), false, "a delivered direction is not duplicated");
});

test("receiving checkpoint reserves one event slot and byte budget for a redirect after a full escaped inbox", async (t) => {
	const { hub, a, b, request, id } = fixture(1); t.after(() => hub.dispose());
	const largeMessage = "\u0000".repeat(TEAM_MAX_MESSAGE_BYTES);
	for (let index = 0; index < TEAM_MAX_EVENTS; index++) {
		await request(a, { action: "send", to: "B1", message: largeMessage });
	}
	await request(a, { action: "control", to: "B1", command: "redirect", message: largeMessage });
	const reply = await request(b, { action: "checkpoint", receive: true });
	assert.equal(reply.revision, 1);
	assert.equal(reply.events?.at(-1)?.message, largeMessage);
	assert.ok(reply.events!.length < TEAM_MAX_EVENTS, "regular inbox consumption reserves a slot for direction");
	const eventBytes = Buffer.byteLength(JSON.stringify(reply.events));
	assert.ok(eventBytes > 256 * 1024, "the reserved redirect is included even when it exceeds the ordinary batch cap");
	assert.ok(eventBytes <= 256 * 1024 + 56 * 1024);
	assert.equal(hub.get(id).members.find((member) => member.id === "B1")?.observedRevision, 1);
});

test("replyTo and supersedes validate before delivery and retain correlation metadata", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	const original = await request(a, { action: "send", to: "B1", message: "question" });
	const own = await request(b, { action: "send", to: "A", message: "first answer" });
	const other = await request(workers[1]!, { action: "send", to: "A", message: "other answer" });
	const reply = await request(b, { action: "send", to: "A", message: "corrected answer",
		replyTo: original.receipt!.messageId!, supersedes: own.receipt!.messageId! });
	const correlated = hub.get(id).events.find((event) => event.messageId === reply.receipt?.messageId);
	assert.equal(correlated?.replyTo, original.receipt?.messageId);
	assert.equal(correlated?.supersedes, own.receipt?.messageId);
	const restored = new TeamHub(); t.after(() => restored.dispose());
	restored.restore([hub.get(id)]);
	assert.equal(restored.get(id).events.find((event) => event.messageId === reply.receipt?.messageId)?.replyTo, original.receipt?.messageId);
	assert.equal(restored.get(id).events.find((event) => event.messageId === reply.receipt?.messageId)?.supersedes, own.receipt?.messageId);
	const before = hub.get(id);
	const foreign = await request(b, { action: "send", to: "A", message: "invalid",
		replyTo: "foreign-team-id:1" });
	assert.equal(foreign.ok, false);
	assert.match(foreign.error!, /replyTo.*known message/);
	assert.deepEqual(hub.get(id), before);
	const wrongAuthor = await request(b, { action: "send", to: "A", message: "invalid", supersedes: other.receipt!.messageId! });
	assert.equal(wrongAuthor.ok, false);
	assert.match(wrongAuthor.error!, /own prior message/);
	assert.deepEqual(hub.get(id), before);
	const unknown = await request(b, { action: "send", to: "A", message: "invalid", replyTo: `${id}:999999` });
	assert.equal(unknown.ok, false);
	assert.deepEqual(hub.get(id), before);
});


test("worker finish stores a nonterminal structured candidate; report remains progress", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	await request(b, { action: "report", message: "still working" });
	assert.equal(hub.get(id).members.find((member) => member.id === "B1")?.result, undefined);
	const finish = await request(b, { action: "finish", message: "Reviewed the tests" });
	assert.equal(finish.ok, true);
	let member = hub.get(id).members.find((candidate) => candidate.id === "B1")!;
	assert.equal(member.state, "waiting");
	assert.deepEqual(member.result, { status: "succeeded", summary: "Reviewed the tests" });
	const candidate: TeamTaskResult = { status: "blocked", summary: "Needs a parent decision", findings: ["Missing access"] };
	assert.equal((await request(workers[1]!, { action: "finish", result: candidate })).ok, true);
	member = hub.get(id).members.find((candidateMember) => candidateMember.id === "B2")!;
	assert.equal(member.state, "waiting");
	assert.deepEqual(member.result, candidate);
	const before = hub.get(id);
	const invalid = await request(workers[1]!, { action: "finish", message: "both", result: candidate });
	assert.equal(invalid.ok, false);
	assert.deepEqual(hub.get(id), before);
	hub.complete(b, outcome);
	assert.deepEqual(hub.get(id).members.find((candidateMember) => candidateMember.id === "B1")?.result,
		{ status: "succeeded", summary: "Reviewed the tests" });
	const restored = new TeamHub(); t.after(() => restored.dispose());
	restored.restore([hub.get(id)]);
	assert.deepEqual(restored.get(id).members.find((candidateMember) => candidateMember.id === "B2")?.result, candidate);
	assert.ok(a);
});

test("finish shorthand is size-checked atomically; replacement candidates are live state and reach the journal with the outcome", async (t) => {
	const history: TeamSnapshot[] = [];
	const observed: TeamSnapshot[] = [];
	const { hub, id, b, a, request } = fixture(1, { onSnapshot: (snapshot) => history.push(snapshot) });
	t.after(() => hub.dispose());
	t.after(hub.subscribe((snapshot) => { observed.push(snapshot); }));
	const before = hub.get(id);
	const rejected = await request(b, { action: "finish", message: "\u0000".repeat(TEAM_MAX_MESSAGE_BYTES) });
	assert.equal(rejected.ok, false);
	assert.match(rejected.error!, /serialized limit/);
	assert.deepEqual(hub.get(id), before, "invalid shorthand cannot store an untransferable result or release its permit");
	assert.equal((await request(b, { action: "finish", message: "first candidate" })).ok, true);
	const seq = hub.get(id).seq;
	const count = history.length;
	const live = observed.length;
	assert.equal((await request(b, { action: "finish", message: "corrected candidate" })).ok, true);
	assert.equal(hub.get(id).seq, seq, "candidate replacement need not invent a state event");
	assert.equal(history.length, count, "a candidate is not a journal milestone");
	assert.equal(observed.length, live + 1);
	assert.equal(observed.at(-1)?.members.find((member) => member.id === "B1")?.result?.summary, "corrected candidate");
	assert.equal((await request(a, { action: "control", to: "B1", command: "redirect", message: "new assignment" })).ok, true);
	assert.equal(hub.get(id).members.find((member) => member.id === "B1")?.result, undefined, "a redirected member must not reuse an old deliverable candidate");
	assert.equal((await request(b, { action: "checkpoint", receive: true })).revision, 1);
	assert.equal((await request(b, { action: "finish", message: "final candidate" })).ok, true);
	hub.complete(b, outcome);
	assert.equal(history.at(-1)?.members.find((member) => member.id === "B1")?.result?.summary, "final candidate",
		"the outcome milestone journals the final candidate");
});

test("redirect revisions invalidate stale and parked checkpoints without cancelling the team", async (t) => {
	const journal: TeamSnapshot[] = [];
	const { hub, a, b, request, id } = fixture(1, { onSnapshot: (snapshot) => journal.push(snapshot) }); t.after(() => hub.dispose());
	assert.equal((await request(b, { action: "checkpoint", receive: true })).revision, 0);
	await request(a, { action: "control", to: "B1", command: "pause" });
	const parked = request(b, { action: "checkpoint", revision: 0 });
	await tick();
	const redirect = await request(a, { action: "control", to: "B1", command: "redirect", message: "new direction" });
	assert.equal(redirect.receipt?.status, "applied");
	let member = hub.get(id).members.find((candidate) => candidate.id === "B1")!;
	assert.equal(member.instructionRevision, 1);
	assert.equal(member.observedRevision, 0);
	await request(a, { action: "control", to: "B1", command: "resume" });
	const parkedReply = await parked;
	assert.equal(parkedReply.ok, false);
	assert.equal(parkedReply.code, "stale_instruction");
	assert.equal(parkedReply.revision, 1);
	assert.equal(hub.signal(id).aborted, false);
	const stale = await request(b, { action: "checkpoint", revision: 0 });
	assert.equal(stale.ok, false);
	assert.equal(stale.code, "stale_instruction");
	assert.equal(stale.revision, 1);
	assert.equal(hub.signal(id).aborted, false);
	assert.throws(() => hub.complete(b, outcome), /latest redirected instruction/);
	const received = await request(b, { action: "checkpoint", receive: true });
	assert.equal(received.revision, 1);
	assert.equal(received.events?.some((event) => event.message === "new direction"), true);
	member = hub.get(id).members.find((candidate) => candidate.id === "B1")!;
	assert.equal(member.observedRevision, 1);
	hub.complete(b, outcome);
	assert.equal(hub.get(id).members.find((candidate) => candidate.id === "B1")?.state, "completed");
	assert.equal(journal.at(-1)?.members.find((candidate) => candidate.id === "B1")?.observedRevision, 1);
});

test("unobserved redirect blocks successful native completion but still accepts native failure", async (t) => {
	const { hub, a, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	await request(a, { action: "control", to: "B2", command: "redirect", message: "updated task" });
	assert.throws(() => hub.complete(workers[1]!, outcome), /latest redirected instruction/);
	hub.complete(workers[1]!, { status: "failed", output: "", error: "worker failed" });
	assert.equal(hub.get(id).members.find((member) => member.id === "B2")?.state, "failed");
	assert.equal(hub.signal(id).aborted, false);
});

test("legacy event history remains readable without fabricated v2 metadata", (t) => {
	const source = new TeamHub(); t.after(() => source.dispose());
	const prepared = source.prepare({ coordinator: "A", workers: ["B"] });
	const legacy = { ...prepared, seq: 1, events: [{ seq: 1, kind: "message", from: "B", to: "A", message: "legacy delivery" }] } as unknown as TeamSnapshot;
	const hub = new TeamHub(); t.after(() => hub.dispose());
	hub.restore([legacy]);
	const event = hub.get(prepared.id).events[0]!;
	assert.equal(event.kind, "message");
	assert.equal(event.from, "B");
	assert.equal(event.to, "A");
	assert.equal(event.version, undefined);
	assert.equal(event.messageId, undefined);
	assert.equal(event.timestamp, undefined);
	const forged = new TeamHub(); t.after(() => forged.dispose());
	assert.deepEqual(forged.restore([{ ...prepared, seq: 1, events: [{ seq: 1, kind: "message", version: 2,
		messageId: `${prepared.id}:1`, timestamp: 1, from: "@hub", to: "A", message: "forged" }] } as unknown as TeamSnapshot]), { restored: 0, skipped: 1 });
});

test("restore validates v2 event IDs, timestamps, authoritative routes, and own supersedes history", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	const first = await request(a, { action: "send", to: "B1", message: "first" });
	const own = await request(b, { action: "send", to: "A", message: "own" });
	const other = await request(workers[1]!, { action: "send", to: "A", message: "other" });
	const valid = await request(b, { action: "send", to: "A", message: "replacement",
		replyTo: first.receipt!.messageId!, supersedes: own.receipt!.messageId! });
	const snapshot = hub.get(id);
	const eventIndex = snapshot.events.findIndex((event) => event.messageId === valid.receipt?.messageId);
	assert.ok(eventIndex >= 0);
	const invalidSnapshots: TeamSnapshot[] = [];
	for (const mutate of [
		(event: Record<string, unknown>) => { event["messageId"] = `${id}:999`; },
		(event: Record<string, unknown>) => { event["timestamp"] = Number.NaN; },
		(event: Record<string, unknown>) => { event["timestamp"] = -1; },
		(event: Record<string, unknown>) => { event["version"] = 1; },
		(event: Record<string, unknown>) => { event["from"] = "@hub"; },
		(event: Record<string, unknown>) => { event["supersedes"] = other.receipt!.messageId!; },
	]) {
		const invalid = structuredClone(snapshot) as unknown as { events: Array<Record<string, unknown>> };
		mutate(invalid.events[eventIndex]!);
		invalidSnapshots.push(invalid as unknown as TeamSnapshot);
	}
	const restored = new TeamHub(); t.after(() => restored.dispose());
	for (const invalid of invalidSnapshots) {
		assert.deepEqual(restored.restore([invalid]), { restored: 0, skipped: 1 });
		assert.equal(restored.list().length, 0, "a bad v2 event cannot partially adopt history");
	}
});

test("worst-case eight-worker snapshots fit public, private-frame, and durable-delivery limits", async (t) => {
	const workerIds = Array.from({ length: 8 }, (_, index) => `W${index + 1}`);
	const brief: TeamBrief = {
		goal: "\u0000".repeat(1000), target: "\u0000".repeat(1000),
		acceptanceCriteria: Array(8).fill("\u0000".repeat(250)),
		constraints: Array(4).fill("\u0000".repeat(250)),
	};
	assert.ok(isTeamBrief(brief));
	const assignment = (memberId: string): TeamAssignment => ({ memberId, task: "\u0000".repeat(800),
		cwd: "\u0000".repeat(800), model: "\u0000".repeat(800), fastMode: true, searchMode: "s".repeat(700) });
	const result: TeamTaskResult = { status: "partial", summary: "\u0000".repeat(800),
		findings: ["\u0000".repeat(500), "\u0000".repeat(500)], limitations: ["\u0000".repeat(100)] };
	assert.ok(workerIds.every((id) => isTeamAssignment(assignment(id))));
	assert.ok(isTeamAssignment(assignment("A")));
	assert.ok(isTeamTaskResult(result));

	const hub = new TeamHub(); t.after(() => hub.dispose());
	const team = hub.prepare({ coordinator: "A", workers: workerIds, brief });
	const assignments = [assignment("A"), ...workerIds.map(assignment)];
	const [coordinator] = hub.join(team.id, ["A"], [assignments[0]!]);
	const workers = hub.join(team.id, workerIds, assignments.slice(1));
	for (let index = 0; index < TEAM_MAX_EVENTS; index++) {
		const reply = await hub.request(workers[0]!, {
			requestId: `large-report-${index}`, sequence: index + 1, action: "report", message: "x".repeat(TEAM_MAX_MESSAGE_BYTES),
		});
		assert.equal(reply.ok, true);
	}
	for (let index = 0; index < workers.length; index++) {
		const binding = workers[index]!;
		const finished = await hub.request(binding, {
			requestId: `large-finish-${index}`, sequence: index === 0 ? TEAM_MAX_EVENTS + 1 : 1, action: "finish", result,
		});
		assert.equal(finished.ok, true);
		hub.complete(binding, { status: "completed", output: "\u0000".repeat(100_000), error: "\u0000".repeat(100_000) });
	}
	const reply = await hub.request(coordinator!, {
		requestId: "large-wait", sequence: 1, action: "wait", wait: { kind: "message" },
	});
	assert.equal(reply.ok, true);
	assert.equal(reply.snapshot?.events.length, 0, "wait snapshot projects current status; top-level events carry consumed history");
	assert.ok(reply.snapshot?.members.every((member) => !member.assignment && member.output === undefined && !reply.snapshot?.brief),
		"a message wait carries compact status, not brief, assignments or outputs");
	assert.ok(reply.snapshot?.members.filter((member) => member.role === "worker").every((member) => member.result
		&& Buffer.byteLength(member.result.summary) <= 512 && Buffer.byteLength(member.error!) <= 512));
	const publicReply = publicTeamReply(reply);
	const replyJson = JSON.stringify(publicReply);
	const frame = {
		version: 1, commandId: "worst-case", operation: "reply", binding: coordinator!,
		requestId: publicReply.requestId!, reply: publicReply,
	};
	const privateFrameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
	const delivery = {
		role: "custom", customType: TEAM_DELIVERY_TYPE, content: replyJson, display: false,
		details: { teamId: team.id, memberId: "A", deliveryId: "worst-case-delivery" }, timestamp: Date.now(),
	};
	const durableDeliveryBytes = Buffer.byteLength(JSON.stringify([delivery]), "utf8");
	const publicReplyBytes = Buffer.byteLength(replyJson, "utf8");
	assert.ok(publicReplyBytes > 250 * 1024, `test should exercise a large event batch (${publicReplyBytes} bytes)`);
	assert.ok(publicReplyBytes <= TEAM_FRAME_BYTES);
	assert.ok(privateFrameBytes <= TEAM_FRAME_BYTES);
	assert.ok(durableDeliveryBytes <= TEAM_FRAME_BYTES);
	const barrier = await hub.waitForWorkers(coordinator!);
	assert.ok(barrier.members.filter((member) => member.role === "worker").every((member) => member.output && member.result && !member.assignment),
		"the barrier carries complete worker outcomes once");
	assert.ok(Buffer.byteLength(JSON.stringify(publicTeamReply({ ok: true, from: "@hub", to: "A", requestId: "barrier", snapshot: barrier }))) <= TEAM_FRAME_BYTES);
	hub.complete(coordinator!, { status: "completed", output: "\u0000".repeat(100_000), error: "\u0000".repeat(100_000) });
	const terminalReply = publicTeamReply({ ok: true, from: "@hub", to: "A", requestId: "terminal-snapshot", snapshot: hub.get(team.id) });
	const terminalFrame = {
		version: 1, commandId: "terminal-size", operation: "reply", binding: coordinator!,
		requestId: terminalReply.requestId!, reply: terminalReply,
	};
	assert.ok(Buffer.byteLength(JSON.stringify(terminalReply), "utf8") <= TEAM_FRAME_BYTES);
	assert.ok(Buffer.byteLength(JSON.stringify(terminalFrame), "utf8") <= TEAM_FRAME_BYTES);
});

test("coordinator cannot wait for all workers while one is paused; resume or cancel first", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	await request(a, { action: "control", to: "B1", command: "pause" });
	hub.complete(workers[1]!, outcome);
	const before = hub.get(id);
	for (const fields of [{ action: "finish" }, { action: "wait", wait: { kind: "workers" } }] as const) {
		const rejected = await request(a, fields);
		assert.equal(rejected.ok, false);
		assert.match(rejected.error!, /B1 is paused; resume or cancel it first/u);
	}
	assert.equal(hub.get(id).members.find((member) => member.id === "A")?.state, before.members.find((member) => member.id === "A")?.state);
	await request(a, { action: "control", to: "B1", command: "resume" });
	const barrier = request(a, { action: "finish" });
	hub.complete(b, outcome);
	assert.equal((await barrier).snapshot?.phase, "finalizing");
});

test("a fully parked team notifies the coordinator once past its sender filter, then fails fast without progress", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { hub, a, b, request, id } = fixture(1, { stallGraceMs: 50 }); t.after(() => hub.dispose());
	const worker = request(b, { action: "wait", wait: { kind: "message", from: "A" } });
	const first = request(a, { action: "wait", wait: { kind: "message", from: "B1" } });
	await tick();
	t.mock.timers.tick(49);
	let settled = false; void first.then(() => { settled = true; });
	await tick(); assert.equal(settled, false, "the grace period absorbs transient all-parked states");
	t.mock.timers.tick(1);
	const notice = await first;
	assert.equal(notice.ok, false);
	assert.equal(notice.code, "team_stalled");
	assert.match(notice.error!, /A waits for a message from B1; B1 waits for a message from A/u);
	assert.doesNotThrow(() => publicTeamReply(notice));
	assert.equal(hub.get(id).phase, "running", "the first stall is a notice, not a failure");
	const again = request(a, { action: "wait", wait: { kind: "message", from: "B1" } });
	await tick();
	t.mock.timers.tick(50);
	assert.equal((await again).ok, false);
	assert.equal(hub.get(id).phase, "failed");
	assert.match(String(hub.signal(id).reason), /Team stalled: .*No member changed anything/u);
	assert.equal((await worker).ok, false);
});

test("acting on a stall notice resets it; a later unrelated stall gets its own notice", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { hub, a, b, request, id } = fixture(1, { stallGraceMs: 10 }); t.after(() => hub.dispose());
	const worker = request(b, { action: "wait", wait: { kind: "message", from: "A" } });
	const first = request(a, { action: "wait", wait: { kind: "message", from: "B1" } });
	await tick(); t.mock.timers.tick(10);
	assert.equal((await first).code, "team_stalled");
	await request(a, { action: "send", to: "B1", message: "continue" });
	assert.equal((await worker).events?.[0]?.message, "continue");
	const second = request(b, { action: "wait", wait: { kind: "message", from: "A" } });
	const renewed = request(a, { action: "wait", wait: { kind: "message", from: "B1" } });
	await tick(); t.mock.timers.tick(10);
	assert.equal((await renewed).code, "team_stalled", "progress since the first notice earns a new notice");
	assert.equal(hub.get(id).phase, "running");
	hub.cancel(id); await second;
});

test("the host-side barrier with a paused worker receives a stall error instead of waiting for the deadline", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { hub, a, b, request, id } = fixture(1, { stallGraceMs: 10 }); t.after(() => hub.dispose());
	await request(a, { action: "control", to: "B1", command: "pause" });
	const gate = request(b, { action: "checkpoint", receive: true });
	const barrier = hub.waitForWorkers(a);
	const rejected = assert.rejects(barrier, (error: Error) => error.name === "TeamStalledError" && /B1 is paused/u.test(error.message));
	await tick(); t.mock.timers.tick(10);
	await rejected;
	assert.equal(hub.get(id).phase, "running");
	await request(a, { action: "control", to: "B1", command: "resume" });
	assert.equal((await gate).ok, true);
});

test("members generating or holding a permit never count as stalled", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { hub, a, workers, request, id } = fixture(2, { stallGraceMs: 10 }); t.after(() => hub.dispose());
	assert.equal((await request(workers[1]!, { action: "checkpoint" })).ok, true);
	const wait = request(workers[0]!, { action: "wait", wait: { kind: "member", member: "B2" } });
	const coordinator = request(a, { action: "wait", wait: { kind: "message", from: "B2" } });
	await tick(); t.mock.timers.tick(1000);
	let settled = false; void coordinator.then(() => { settled = true; });
	await tick(); assert.equal(settled, false, "B2 holds a permit and is still working");
	hub.complete(workers[1]!, outcome);
	await wait;
	hub.cancel(id); await coordinator;
});

test("coordinator cancel stops one worker immediately, opens the barrier and rejects its late requests", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	const parked = request(b, { action: "wait", wait: { kind: "message", from: "A" } });
	const barrier = request(a, { action: "finish" });
	const cancelled = await request(a, { action: "control", to: "B1", command: "cancel", message: "no longer needed" });
	assert.equal(cancelled.ok, true);
	assert.equal(cancelled.receipt?.status, "applied");
	const member = hub.get(id).members.find((candidate) => candidate.id === "B1")!;
	assert.equal(member.state, "cancelled");
	assert.equal(member.error, "Cancelled by coordinator A: no longer needed");
	assert.equal(hub.memberSignal(id, "B1").aborted, true);
	assert.equal(hub.memberSignal(id, "B2").aborted, false);
	assert.equal(hub.signal(id).aborted, false, "cancelling one worker never cancels the team");
	assert.equal((await parked).ok, false);
	assert.equal((await request(b, { action: "checkpoint" })).ok, false);
	hub.complete(b, { status: "completed", output: "late success" });
	assert.equal(hub.get(id).members.find((candidate) => candidate.id === "B1")?.state, "cancelled");
	hub.complete(workers[1]!, outcome);
	const final = await barrier;
	assert.equal(final.snapshot?.phase, "finalizing");
	assert.equal((await request(a, { action: "control", to: "B1", command: "cancel" })).ok, false);
	assert.equal(hub.get(id).events.filter((event) => event.kind === "control" && event.message === "cancel").length, 1);
	const restored = new TeamHub(); t.after(() => restored.dispose());
	assert.doesNotThrow(() => restored.restore([hub.get(id)]));
});

test("unread queued messages are reported to the sender and coordinator when the recipient ends", async (t) => {
	const { hub, a, b, workers, request, id } = fixture(2); t.after(() => hub.dispose());
	const queued = await request(b, { action: "send", to: "B2", message: "please verify" });
	await request(a, { action: "send", to: "B2", message: "and report" });
	hub.complete(workers[1]!, outcome);
	const notice = await request(b, { action: "checkpoint", receive: true });
	const undelivered = notice.events?.filter((event) => event.kind === "undelivered");
	assert.equal(undelivered?.length, 1);
	assert.equal(undelivered?.[0]?.from, "@hub");
	assert.equal(undelivered?.[0]?.to, "B1");
	assert.equal(undelivered?.[0]?.member, "B2");
	assert.match(undelivered![0]!.message!, new RegExp(`B2 became completed before reading 1 queued message\\(s\\): ${queued.receipt!.messageId}`, "u"));
	const coordinator = await request(a, { action: "checkpoint", receive: true });
	const coordinatorNotice = coordinator.events?.find((event) => event.kind === "undelivered");
	assert.match(coordinatorNotice!.message!, /before reading 1 queued message/u, "the coordinator hears about its own unread message once");
	assert.doesNotThrow(() => publicTeamReply(notice));
	const restored = new TeamHub(); t.after(() => restored.dispose());
	assert.doesNotThrow(() => restored.restore([hub.get(id)]));
});

test("coordinator wait/control replies stay compact as worker outputs accumulate; the barrier carries them once", async (t) => {
	const { hub, a, workers, request } = fixture(8, { stallGraceMs: 60_000 }); t.after(() => hub.dispose());
	const sizes: number[] = [];
	for (const [index, worker] of workers.entries()) {
		await request(worker, { action: "report", message: `report ${index} `.repeat(150) });
		sizes.push(Buffer.byteLength(JSON.stringify(await request(a, { action: "wait", wait: { kind: "message" } }))));
		await request(worker, { action: "finish", result: { status: "succeeded", summary: "s".repeat(3000), findings: ["f".repeat(1000)] } });
		hub.complete(worker, { status: "completed", output: "o".repeat(8000) });
		if (index === 6) {
			const control = await request(a, { action: "control", to: "B8", command: "pause" });
			assert.equal(control.ok, true);
			assert.ok(Buffer.byteLength(JSON.stringify(control)) < 8 * 1024, "control replies are compact status, not the full team");
			await request(a, { action: "control", to: "B8", command: "resume" });
		}
	}
	// Each wait consumes one ~2 KB report plus the previous worker's result/state events.
	assert.ok(Math.max(...sizes) < 12 * 1024, `message wait replies must not grow with finished outputs: ${sizes.join(", ")}`);
	assert.ok(sizes.at(-1)! - sizes[1]! < 4 * 1024, `reply size is roughly flat: ${sizes.join(", ")}`);
	const barrier = await request(a, { action: "finish" });
	assert.ok(barrier.snapshot?.members.filter((member) => member.role === "worker").every((member) => member.output === "o".repeat(8000)));
});

test("a complete 1+8 run journals only milestones", async (t) => {
	const journal: TeamSnapshot[] = [];
	const { hub, a, workers, request, id } = fixture(8, { onSnapshot: (snapshot) => { journal.push(snapshot); } }); t.after(() => hub.dispose());
	const afterJoin = journal.length;
	for (const worker of workers) {
		for (let i = 0; i < 10; i++) await request(worker, { action: "checkpoint", receive: i % 2 === 0 });
		await request(worker, { action: "report", message: "progress" });
		await request(a, { action: "wait", wait: { kind: "message" } });
		await request(worker, { action: "finish", message: "done" });
		hub.complete(worker, outcome);
	}
	await request(a, { action: "finish" });
	hub.complete(a, { status: "completed", output: "summary" });
	assert.equal(hub.get(id).phase, "completed");
	// 8 worker outcomes + finalizing + coordinator outcome/completed phase.
	assert.ok(journal.length - afterJoin <= 10, `journal entries after admission: ${journal.length - afterJoin}`);
	assert.ok(journal.every((snapshot) => snapshot.events.length <= 16), "journaled history is trimmed");
	assert.equal(journal.at(-1)?.phase, "completed");
	assert.ok(journal.at(-1)?.members.every((member) => member.state === "completed" && member.output !== undefined));
});
