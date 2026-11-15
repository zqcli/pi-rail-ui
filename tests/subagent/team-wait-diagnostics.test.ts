import assert from "node:assert/strict";
import { test } from "node:test";
import { shortWorkRef, workRefKey, type WorkRef } from "../../tools/subagents/team-protocol";
import { TeamRuntime, waitFactText, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import { formatTeamView } from "../../tools/subagents/team-tool";

function world(initialRequests: Array<{ to: string; task: string }>) {
	let id = 0;
	const runtime = new TeamRuntime({ createId: () => `id${++id}`, now: () => 1_700_000_000_000 });
	const { teamId } = runtime.prepare({ members: ["lead", "a", "b", "c"].map((alias) => ({ alias, roleDescription: alias })),
		lead: "lead", brief: { goal: "Diagnose exact waits without changing them." }, initialRequests, timeoutSeconds: null });
	runtime.launch(teamId);
	const sequence = new WeakMap<RuntimeActivation, number>();
	const take = (ready = true) => {
		const activation = runtime.takeNextActivation(teamId)!;
		assert.ok(activation);
		if (ready) assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
		return activation;
	};
	const call = (activation: RuntimeActivation, args: unknown) => {
		const seq = (sequence.get(activation) ?? 0) + 1;
		sequence.set(activation, seq);
		return runtime.handleAction(activation.binding, activation.scope, seq, `call${seq}`, args, `call${seq}`);
	};
	const settle = (activation: RuntimeActivation) => {
		assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId,
			{ status: "success", appliedToolCallId: `call${sequence.get(activation)}` }).ok, true);
		assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
	};
	const end = (activation: RuntimeActivation, args: unknown) => {
		const reply = call(activation, args);
		assert.equal(reply.ok, true, JSON.stringify(reply));
		settle(activation);
	};
	const request = (activation: RuntimeActivation, to: string) => {
		const reply = call(activation, { action: "request", to, task: `A child for ${to}.` });
		assert.ok(reply.ok && reply.receipt?.status === "accepted");
		return reply.receipt.work;
	};
	const snapshot = () => ({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId).map((work) => runtime.getWork(teamId, work.work)) });
	const lead = take(); // Keep the lead available for explicit decisions, without consuming a worker permit.
	assert.equal(lead.scope.kind, "events");
	return { runtime, teamId, lead, take, call, settle, end, request, snapshot,
		waits: (ref: WorkRef) => runtime.workWaits(teamId, ref),
		text: () => formatTeamView(runtime.getTeam(teamId), runtime.listWorks(teamId), undefined, runtime.panelFacts(teamId)).join("\n") };
}

const ref = (activation: RuntimeActivation) => activation.scope.work!;
const reply = { action: "reply", result: { status: "succeeded", summary: "Done." } };
const wait = (...waitingFor: WorkRef[]) => ({ action: "yield", waitingFor, checkpoint: "Await these exact outcomes." });

test("wait diagnostics retain an older peer revision, separate cleanup from ready delivery, and never retarget an AND wait", () => {
	const w = world(["a", "b", "c"].map((to) => ({ to, task: `${to} root` })));
	const [a, b, c] = [w.take(), w.take(), w.take()];
	w.end(a, wait(ref(b), ref(c)));
	assert.equal(w.call(w.lead, { action: "control", command: "revise_work", workId: ref(b).workId, expectedRevision: 1, task: "New peer revision." }).ok, true);
	assert.deepEqual(w.waits(ref(a)).map(({ work, state, blocking, reason, latestRevision }) => ({ work, state, blocking, reason, latestRevision })), [
		{ work: ref(b), state: "superseded", blocking: true, reason: "cleanup pending", latestRevision: 2 },
		{ work: ref(c), state: "running", blocking: true, reason: undefined, latestRevision: undefined },
	]);
	assert.match(w.runtime.panelFacts(w.teamId).stalled.get("a")!, /b \(superseded · cleanup pending\)/u);
	assert.equal(w.runtime.nativeSettled(b.binding, b.scope.activationId, { status: "aborted" }).ok, true);
	assert.equal(w.runtime.cleanupFinished(b.binding, b.scope.activationId, { ok: true }).ok, true);
	const before = w.snapshot();
	const facts = w.waits(ref(a));
	assert.equal(facts[0]!.blocking, false);
	assert.match(waitFactText(facts[0]!), /@1 → b · superseded · outcome ready; awaiting delivery · current @2/u);
	assert.equal(facts.some((item) => item.work.workId === ref(b).workId && item.work.revision === 2), false);
	assert.equal(w.runtime.panelFacts(w.teamId).stalled.get("a"), `waiting on c (running ${shortWorkRef(ref(c))})`);
	assert.ok(w.text().includes(`${workRefKey(ref(a))}: ${shortWorkRef(ref(b))} → b · superseded`));
	assert.deepEqual(w.snapshot(), before, "reading facts/status does not change work, health, incidents, events, or scheduling");
	w.end(c, reply);
	assert.equal(w.runtime.getWork(w.teamId, ref(a))!.current.state, "queued");
	assert.equal(w.runtime.panelFacts(w.teamId).stalled.has("a"), false);
	assert.ok(w.waits(ref(a)).every((item) => !item.blocking));
	w.runtime.assertInvariants(w.teamId);
});

test("an already completed but unobserved outcome is a legitimate yield, not a stale wait", () => {
	const w = world(["a", "b"].map((to) => ({ to, task: to })));
	const [a, b] = [w.take(), w.take()];
	w.end(b, reply);
	w.end(a, wait(ref(b)));
	assert.equal(w.waits(ref(a))[0]!.blocking, false);
	const resumed = w.take(false);
	assert.deepEqual(ref(resumed), ref(a));
	assert.equal(w.waits(ref(a)).length, 1, "reserving an activation is not evidence that its outcome was delivered");
	assert.equal(w.runtime.inputReady(resumed.binding, resumed.scope.activationId, resumed.deliveryId).ok, true);
	assert.deepEqual(w.waits(ref(a)), []);
	const before = w.snapshot();
	const rejected = w.call(resumed, wait(ref(b)));
	assert.equal(!rejected.ok && rejected.error.code, "NO_NEW_DEPENDENCY");
	assert.deepEqual(w.snapshot(), before);
	assert.doesNotMatch(w.runtime.panelFacts(w.teamId).timeline.map((item) => item.text).join("\n"), /cycle|stale/u);
	w.runtime.assertInvariants(w.teamId);
});

test("unknown outcomes require a decision even after cleanup, and only the exact explicit release changes that fact", () => {
	const w = world(["a", "b"].map((to) => ({ to, task: to })));
	const [a, b] = [w.take(), w.take()];
	w.end(a, wait(ref(b)));
	assert.equal(w.runtime.activationLost(b.binding, b.scope.activationId, { code: "TRANSPORT_LOST", message: "Lost transport." }, false).ok, true);
	assert.match(w.waits(ref(a))[0]!.reason!, /cleanup pending · outcome unknown; explicit decision required/u);
	assert.equal(w.runtime.memberExitConfirmed(b.binding).ok, true);
	assert.deepEqual(w.waits(ref(a)).map(({ blocking, reason }) => ({ blocking, reason })), [{ blocking: true, reason: "outcome unknown; explicit decision required" }]);
	assert.equal(w.runtime.getWork(w.teamId, ref(a))!.current.state, "blocked");
	const hold = w.runtime.getWork(w.teamId, ref(a))!.current.hold!;
	w.runtime.releaseHold(w.teamId, ref(a), hold.incidentId, "The side effects were checked; use the failed outcome.");
	assert.equal(w.waits(ref(a))[0]!.blocking, false);
	assert.equal(w.waits(ref(a))[0]!.reason, "outcome ready; awaiting delivery");
	assert.equal(w.runtime.getWork(w.teamId, ref(b))!.current.error!.outcomeUnknown, true, "diagnostics never rewrite the historical evidence");
	w.runtime.assertInvariants(w.teamId);
});

test("a held child's requester remains visible after issue delivery, without labelling the normal parent wake as a cycle", () => {
	const w = world([{ to: "a", task: "parent" }]);
	const a = w.take();
	const child = w.request(a, "b");
	w.end(a, wait(child));
	const b = w.take();
	w.end(b, { action: "yield", attention: "Which branch?", checkpoint: "Before checking." });
	assert.equal(w.runtime.getWork(w.teamId, ref(a))!.current.state, "queued");
	assert.equal(w.waits(ref(a))[0]!.reason, "needs a's decision");
	const resumed = w.take();
	assert.equal(w.runtime.getWork(w.teamId, ref(a))!.current.childIssues, undefined);
	w.end(resumed, wait(child)); // The owner has seen, but has not answered, the question.
	assert.equal(w.runtime.getWork(w.teamId, ref(a))!.current.state, "blocked");
	assert.match(w.runtime.panelFacts(w.teamId).stalled.get("a")!, /held.*needs a's decision/u);
	assert.doesNotMatch(w.text(), /dependency cycle/u);
	const before = w.snapshot();
	w.waits(ref(a)); w.runtime.panelFacts(w.teamId);
	assert.deepEqual(w.snapshot(), before, "diagnostics do not resume the child or re-deliver its issue");
	const hold = w.runtime.getWork(w.teamId, child)!.current.hold!;
	assert.equal(w.call(w.lead, { action: "control", command: "resume_work", workId: child.workId, expectedRevision: 1, incidentId: hold.incidentId, instruction: "Use main." }).ok, true);
	assert.equal(w.waits(ref(a))[0]!.reason, undefined);
	w.runtime.assertInvariants(w.teamId);
});

test("a queued dependency names the work occupying its member and drops that reason when the slot changes", () => {
	const w = world(["a", "b"].map((to) => ({ to, task: to })));
	const [a, busy] = [w.take(), w.take()];
	const child = w.request(a, "b");
	w.end(a, wait(child));
	assert.equal(w.waits(ref(a))[0]!.reason, `member busy on ${shortWorkRef(ref(busy))}`);
	assert.ok(w.text().includes(`member busy on ${shortWorkRef(ref(busy))}`));
	w.end(busy, reply);
	assert.equal(w.waits(ref(a))[0]!.reason, undefined);
	const target = w.take();
	assert.deepEqual(ref(target), child);
	assert.equal(w.waits(ref(a))[0]!.state, "running");
	assert.equal(w.call(target, reply).ok, true);
	assert.equal(w.waits(ref(a))[0]!.reason, "settling");
	w.settle(target);
	assert.equal(w.waits(ref(a))[0]!.reason, "outcome ready; awaiting delivery");
	w.runtime.assertInvariants(w.teamId);
});

test("rejected cycles are bounded timeline evidence, never committed edges or automatic recovery", () => {
	const w = world(["a", "b"].map((to) => ({ to, task: to })));
	const [a, b] = [w.take(), w.take()];
	assert.equal(w.call(a, wait(ref(b))).ok, true); // Staged edges must participate before settlement.
	const before = w.snapshot();
	const rejected = w.call(b, wait(ref(a)));
	assert.equal(!rejected.ok && rejected.error.code, "DEPENDENCY_CYCLE");
	assert.deepEqual(w.snapshot(), before);
	assert.match(w.runtime.panelFacts(w.teamId).timeline.at(-1)!.text, /b wait rejected: dependency cycle/u);
	assert.deepEqual(w.waits(ref(b)), [], "a rejected edge is not an active wait");
	w.end(b, reply);
	w.settle(a);
	w.runtime.assertInvariants(w.teamId);
});

test("a legal return trip to the first member is not a dependency cycle", () => {
	const w = world([{ to: "a", task: "first" }]);
	const first = w.take();
	const child = w.request(first, "b");
	w.end(first, wait(child));
	const second = w.take();
	const returned = w.request(second, "a");
	w.end(second, wait(returned));
	const third = w.take();
	assert.equal(third.binding.memberId, "a");
	assert.notDeepEqual(ref(third), ref(first));
	assert.equal(w.waits(ref(first))[0]!.state, "blocked");
	assert.equal(w.waits(ref(second))[0]!.state, "running");
	assert.doesNotMatch(w.text(), /dependency cycle/u);
	w.end(third, reply);
	w.end(w.take(), reply);
	w.end(w.take(), reply);
	w.runtime.assertInvariants(w.teamId);
});
