import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamBudgetLimits, WorkRef } from "../../tools/subagents/team-protocol";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import { memberDetail } from "../../tools/subagents/team-tool";

function setup(initialRequests: Array<{ to: string; task: string }>, limits: Partial<TeamBudgetLimits> = {}) {
	let ids = 0;
	const clock = { now: 1_700_000_000_000 };
	const runtime = new TeamRuntime({ now: () => clock.now++, createId: () => `id${++ids}`, limits });
	const prepared = runtime.prepare({
		members: ["lead", "w1", "w2"].map((alias) => ({ alias, roleDescription: alias === "lead" ? "Coordinate." : "Do assigned work." })),
		lead: "lead", brief: { goal: "Exercise ready ordering." }, initialRequests, timeoutSeconds: null,
	});
	runtime.launch(prepared.teamId);
	return { runtime, teamId: prepared.teamId, clock };
}

function act(runtime: TeamRuntime, activation: RuntimeActivation, sequence: number, id: string, args: unknown) {
	const reply = runtime.handleAction(activation.binding, activation.scope, sequence, id, args, id);
	assert.equal(reply.ok, true, JSON.stringify(reply));
	return reply;
}

function start(runtime: TeamRuntime, teamId: string): RuntimeActivation {
	const activation = runtime.takeNextActivation(teamId);
	assert.ok(activation, "an activation is runnable");
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
	return activation;
}

function end(runtime: TeamRuntime, activation: RuntimeActivation, id: string, args: unknown, sequence = 99): void {
	act(runtime, activation, sequence, id, args);
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: id }).ok, true);
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
}

function request(runtime: TeamRuntime, activation: RuntimeActivation, sequence: number, to: string, task: string): WorkRef {
	const reply = act(runtime, activation, sequence, `request-${sequence}`, { action: "request", to, task });
	assert.ok(reply.ok && reply.receipt?.status === "accepted");
	return reply.receipt.work;
}

const task = (activation: RuntimeActivation) => activation.input.scope.kind === "work" ? activation.input.scope.task : activation.scope.kind;
const done = { action: "reply", result: { status: "succeeded", summary: "done" } };
const idle = { action: "yield" };

test("a member's work waiting on a dependency never holds back that member's later queued work", () => {
	const { runtime, teamId } = setup([{ to: "w1", task: "A" }, { to: "w1", task: "B" }, { to: "w2", task: "C" }]);
	end(runtime, start(runtime, teamId), "boot", idle);
	const a = start(runtime, teamId);
	const c = start(runtime, teamId);
	assert.deepEqual([task(a), task(c)], ["A", "C"]);
	assert.equal(runtime.takeNextActivation(teamId), undefined, "B waits only while w1 runs A");
	const child = request(runtime, a, 1, "w2", "child of A");
	end(runtime, a, "wait-child", { action: "yield", waitingFor: [child], checkpoint: "need the child" });
	const b = start(runtime, teamId);
	assert.equal(task(b), "B", "w1 takes B at once while A waits");
	end(runtime, c, "c-done", done);
	end(runtime, start(runtime, teamId), "c-result-idle", idle); // the lead sees C's root result
	assert.equal(task(start(runtime, teamId)), "child of A");
	runtime.assertInvariants(teamId);
});

test("a free work permit goes to the work another work waits on, ahead of earlier fresh work; the panel shows the queued work", () => {
	const { runtime, teamId } = setup([{ to: "w1", task: "A" }, { to: "w1", task: "B" }], { workPermits: 1 });
	end(runtime, start(runtime, teamId), "boot", idle);
	const a = start(runtime, teamId);
	const child = request(runtime, a, 1, "w2", "child of A");
	end(runtime, a, "wait-child", { action: "yield", waitingFor: [child], checkpoint: "need the child" });
	const first = start(runtime, teamId);
	assert.equal(task(first), "child of A", "the unblocking child outranks B, which was queued first");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "the child holds the only permit");

	const view = runtime.getTeam(teamId);
	const w1 = view.members.find((member) => member.id === "w1")!;
	assert.deepEqual([w1.blocked, w1.queued], [1, 1]);
	const detail = memberDetail(w1, runtime.panelFacts(teamId), runtime.listWorks(teamId), view.lead);
	assert.match(detail, /^waiting on 1 sub-task: w2 \(running work .+\) · 1 queued$/u, detail);

	end(runtime, first, "child-done", done);
	const resumed = start(runtime, teamId);
	assert.equal(task(resumed), "A", "the resumed continuation goes before the fresh B");
	assert.deepEqual(resumed.input.outcomes.map((outcome) => outcome.work), [child]);
	runtime.assertInvariants(teamId);
});

test("fresh work queued for ten minutes is no longer passed by later continuations", () => {
	const { runtime, teamId, clock } = setup([{ to: "w1", task: "A" }, { to: "w2", task: "W" }, { to: "w1", task: "fresh" }], { workPermits: 1 });
	end(runtime, start(runtime, teamId), "boot", idle);
	const a = start(runtime, teamId);
	assert.equal(task(a), "A");
	const child = request(runtime, a, 1, "w2", "child of A");
	end(runtime, a, "wait-child", { action: "yield", waitingFor: [child], checkpoint: "need the child" });
	const unblock = start(runtime, teamId);
	assert.equal(task(unblock), "child of A");
	end(runtime, unblock, "child-done", done);
	// A (continuation) and W, fresh, are both queued; W was queued first but A resumes first.
	const resumedA = start(runtime, teamId);
	assert.equal(task(resumedA), "A");
	const again = request(runtime, resumedA, 1, "w2", "second child of A");
	end(runtime, resumedA, "wait-again", { action: "yield", waitingFor: [again], checkpoint: "need another child" });

	clock.now += 10 * 60_000;
	// W is now aged: it ranks with continuations and keeps its earlier place, while the waited-on child still leads.
	const next = start(runtime, teamId);
	assert.equal(task(next), "second child of A");
	end(runtime, next, "again-done", done);
	assert.equal(task(start(runtime, teamId)), "W", "the aged fresh work goes before the later continuation of A");
	runtime.assertInvariants(teamId);
});

test("the lead's work alternates with advisory event batches, but host messages go first", () => {
	const { runtime, teamId } = setup([{ to: "w1", task: "A" }, { to: "w2", task: "B" }]);
	end(runtime, start(runtime, teamId), "boot", idle);
	const a = start(runtime, teamId);
	const b = start(runtime, teamId);
	assert.deepEqual([task(a), task(b)], ["A", "B"]);
	request(runtime, a, 1, "lead", "decide for A");
	request(runtime, a, 2, "lead", "second decision");

	// A host message is urgent: it is handled before the lead's queued work, though the lead last handled events (boot).
	runtime.hostControl(teamId).message_lead("status please");
	const events = start(runtime, teamId);
	assert.equal(events.scope.kind, "events");
	end(runtime, events, "events-idle", idle);

	end(runtime, b, "b-done", done); // queues an advisory ROOT_RESULT_READY event
	const leadWork = start(runtime, teamId);
	assert.equal(task(leadWork), "decide for A", "after an events batch the lead's runnable work goes before the advisory result event");
	end(runtime, leadWork, "lead-done", done);
	const resultEvents = start(runtime, teamId);
	assert.equal(resultEvents.scope.kind, "events", "after a lead work, pending events come next");
	assert.ok(resultEvents.input.scope.kind === "events" && resultEvents.input.scope.events.some((event) => event.kind === "ROOT_RESULT_READY"));
	end(runtime, resultEvents, "result-idle", idle);
	assert.equal(task(start(runtime, teamId)), "second decision");
	runtime.assertInvariants(teamId);
});

test("a member fault is handled before the lead's work turn", () => {
	const { runtime, teamId } = setup([{ to: "w1", task: "A" }, { to: "w2", task: "B" }]);
	end(runtime, start(runtime, teamId), "boot", idle);
	const a = start(runtime, teamId);
	const b = start(runtime, teamId);
	request(runtime, a, 1, "lead", "decide for A");
	assert.equal(runtime.nativeSettled(b.binding, b.scope.activationId, { status: "error", error: { code: "UPSTREAM_FAILURE", message: "provider refused" } }).ok, true);
	assert.equal(runtime.cleanupFinished(b.binding, b.scope.activationId, { ok: true }).ok, true);
	const events = start(runtime, teamId);
	assert.equal(events.scope.kind, "events", "the lead last handled events, yet the fault outranks its work turn");
	assert.ok(events.input.scope.kind === "events" && events.input.scope.events.some((event) => event.kind === "MEMBER_FAULTED"));
	end(runtime, events, "fault-idle", idle);
	assert.equal(task(start(runtime, teamId)), "decide for A");
	runtime.assertInvariants(teamId);
});

test("by default every member other than the lead can run at once; a host override still caps permits", () => {
	const open = setup([{ to: "w1", task: "A" }, { to: "w2", task: "B" }]);
	assert.equal(open.runtime.getTeam(open.teamId).budget.limits.workPermits, 2, "one permit per non-lead member");
	end(open.runtime, start(open.runtime, open.teamId), "boot", idle);
	assert.deepEqual([task(start(open.runtime, open.teamId)), task(start(open.runtime, open.teamId))], ["A", "B"]);
	const capped = setup([{ to: "w1", task: "A" }, { to: "w2", task: "B" }], { workPermits: 1 });
	assert.equal(capped.runtime.getTeam(capped.teamId).budget.limits.workPermits, 1);
});

test("a work interrupted by a transient provider error resumes before work that was queued earlier", () => {
	const { runtime, teamId, clock } = setup([{ to: "w1", task: "A" }, { to: "w2", task: "B" }, { to: "w2", task: "C" }], { workPermits: 1 });
	end(runtime, start(runtime, teamId), "boot", idle);
	const a = start(runtime, teamId);
	assert.equal(task(a), "A");
	assert.equal(runtime.nativeSettled(a.binding, a.scope.activationId, { status: "error", error: { code: "NATIVE_FAILURE", message: "WebSocket closed 1006", transient: true } }).ok, true);
	assert.equal(runtime.cleanupFinished(a.binding, a.scope.activationId, { ok: true }).ok, true);
	const b = start(runtime, teamId);
	assert.equal(task(b), "B", "the free permit is used during A's backoff");
	clock.now += 10_000;
	end(runtime, b, "b-done", done);
	end(runtime, start(runtime, teamId), "b-result-idle", idle);
	const retried = start(runtime, teamId);
	assert.equal(task(retried), "A", "after its backoff A goes before C, which was queued before A was requeued");
	assert.match(retried.input.notice, /temporary provider error/u);
	runtime.assertInvariants(teamId);
});

test("the lead's roster shows each member's load and how long a free member has been idle", () => {
	const { runtime, teamId, clock } = setup([{ to: "w1", task: "A" }, { to: "w1", task: "B" }]);
	end(runtime, start(runtime, teamId), "boot", idle);
	const a = start(runtime, teamId);
	const child = request(runtime, a, 1, "w2", "child of A");
	const w2 = start(runtime, teamId);
	assert.equal(task(w2), "child of A");
	end(runtime, w2, "child-done", done);
	clock.now += 5 * 60_000;
	runtime.hostControl(teamId).message_lead("status?");
	const events = start(runtime, teamId);
	assert.equal(events.scope.kind, "events");
	const roster = Object.fromEntries(events.input.roster.map(({ id, running, queued, waiting, idleMinutes }) => [id, { running, queued, waiting, idleMinutes }]));
	assert.deepEqual(roster["w1"], { running: true, queued: 1, waiting: undefined, idleMinutes: undefined }, "w1 runs A and has B queued");
	assert.deepEqual(roster["w2"], { running: undefined, queued: undefined, waiting: undefined, idleMinutes: 5 }, "w2 is free and idle for 5 minutes");
	assert.equal(roster["lead"]!.running, true);
	end(runtime, events, "events-idle", idle);
	assert.ok(child);
	runtime.assertInvariants(teamId);
});
