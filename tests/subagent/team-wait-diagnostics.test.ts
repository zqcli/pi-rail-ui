import assert from "node:assert/strict";
import { test } from "node:test";
import { shortWorkRef, workRefKey, type SignalRecord, type WorkRef } from "../../tools/subagents/team-protocol";
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
const waitSignals = (...waitingForSignals: string[]) => ({ action: "yield", waitingForSignals, checkpoint: "Await these exact phases." });
function phase(w: ReturnType<typeof world>, producer: RuntimeActivation, name = "Repeated phase"): SignalRecord {
	const result = w.call(producer, { action: "signal", operation: "open", name });
	assert.ok(result.ok && result.receipt?.status === "opened");
	return result.data as SignalRecord;
}
const publish = (signalId: string) => ({ action: "signal", operation: "publish", signalId, text: "This phase was published; other work can continue." });

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

test("phase diagnostics keep repeated handles distinct, omit only ready blockers, and retain outcomes until input_ready", () => {
	const w = world(["a", "b"].map((to) => ({ to, task: to })));
	const [a, b] = [w.take(), w.take()];
	const first = phase(w, b), second = phase(w, b);
	w.end(a, waitSignals(first.id, second.id));
	assert.deepEqual(w.waits(ref(a)).map((fact) => fact.signal), [{ id: first.id, name: first.name }, { id: second.id, name: second.name }]);
	assert.ok(w.waits(ref(a)).every((fact) => fact.blocking && fact.state === "pending" && fact.reason === "producer running"));
	assert.ok(w.runtime.panelFacts(w.teamId).stalled.get("a")!.includes(first.id));
	assert.ok(w.runtime.panelFacts(w.teamId).stalled.get("a")!.includes(second.id), "two handles from one producer are not deduplicated by its WorkRef");
	assert.equal(w.call(b, publish(first.id)).ok, true);
	const partial = w.runtime.panelFacts(w.teamId);
	assert.equal(partial.stalled.get("a")!.includes(first.id), false);
	assert.ok(partial.stalled.get("a")!.includes(second.id));
	assert.deepEqual(w.waits(ref(a)).map((fact) => fact.blocking), [false, true]);
	assert.ok(w.text().includes(`${first.id} «Repeated phase» (${shortWorkRef(ref(b))}) → b · published`));
	assert.equal(w.call(b, publish(second.id)).ok, true);
	assert.equal(w.runtime.getWork(w.teamId, ref(a))!.current.state, "queued");
	assert.equal(w.runtime.panelFacts(w.teamId).stalled.has("a"), false);
	assert.equal(w.runtime.panelFacts(w.teamId).dependencies.get(workRefKey(ref(a)))!.length, 2);
	const resumed = w.take(false);
	assert.deepEqual(ref(resumed), ref(a));
	assert.equal(w.runtime.panelFacts(w.teamId).dependencies.get(workRefKey(ref(a)))!.length, 2, "running does not imply delivered");
	const before = w.snapshot();
	w.waits(ref(a)); w.text();
	assert.deepEqual(w.snapshot(), before);
	assert.equal(w.runtime.inputReady(resumed.binding, resumed.scope.activationId, resumed.deliveryId).ok, true);
	assert.deepEqual(w.waits(ref(a)), []);
	assert.equal(w.runtime.panelFacts(w.teamId).dependencies.has(workRefKey(ref(a))), false);
	w.runtime.assertInvariants(w.teamId);
});

for (const mode of ["revise", "loss"] as const) test(`phase diagnostics distinguish ${mode} from resource release without applying Work cleanup gates`, () => {
	const w = world(["a", "b"].map((to) => ({ to, task: to })));
	const [a, b] = [w.take(), w.take()];
	const published = phase(w, b), unpublished = phase(w, b);
	assert.equal(w.call(b, publish(published.id)).ok, true);
	w.end(a, waitSignals(published.id, unpublished.id));
	if (mode === "revise") assert.equal(w.call(w.lead, { action: "control", command: "revise_work", workId: ref(b).workId, expectedRevision: 1, task: "New producer revision." }).ok, true);
	else assert.equal(w.runtime.activationLost(b.binding, b.scope.activationId, { code: "TRANSPORT_LOST", message: "Producer exit is unconfirmed." }, false).ok, true);
	const before = w.snapshot();
	const facts = w.waits(ref(a));
	assert.deepEqual(facts.map((fact) => [fact.signal!.id, fact.state, fact.blocking]), [[published.id, "published", false], [unpublished.id, "unavailable", false]]);
	assert.ok(facts.every((fact) => fact.work.revision === 1 && fact.reason!.includes("no resource release implied")));
	assert.match(facts[1]!.reason!, /^not published; phase outcome ready/u);
	assert.doesNotMatch(facts.map(waitFactText).join("\n"), /cleanup pending|explicit decision required/u);
	assert.equal(w.runtime.getWork(w.teamId, ref(a))!.current.state, "queued", "the unavailable phase is a deliverable outcome, not success or a cleanup hold");
	if (mode === "revise") assert.ok(facts.every((fact) => fact.latestRevision === 2));
	else assert.equal(w.runtime.getWork(w.teamId, ref(b))!.current.error!.outcomeUnknown, true);
	w.text();
	assert.deepEqual(w.snapshot(), before, "diagnostics never confirm producer cleanup or rewrite its outcome");
	w.runtime.assertInvariants(w.teamId);
});

test("waiting for a child's phase does not invent a completion wait, and child decisions remain visible without a false cycle", () => {
	const w = world([{ to: "a", task: "parent" }]);
	const a = w.take();
	const child = w.request(a, "b");
	const b = w.take();
	const signal = phase(w, b);
	w.end(a, waitSignals(signal.id));
	assert.equal(w.waits(ref(a)).length, 1, "owned-child completion is not another phase-wake prerequisite");
	assert.equal(w.waits(ref(a))[0]!.signal!.id, signal.id);
	assert.doesNotMatch(w.runtime.panelFacts(w.teamId).stalled.get("a")!, /sub-task/u);
	w.end(b, { action: "yield", attention: "Which phase data?", checkpoint: "Need the parent's answer." });
	assert.equal(w.waits(ref(a))[0]!.reason, "producer held · needs a's decision");
	assert.equal(w.runtime.getWork(w.teamId, ref(a))!.current.state, "queued", "the child issue wakes its parent normally");
	assert.equal(w.runtime.panelFacts(w.teamId).stalled.has("a"), false);
	assert.doesNotMatch(w.text(), /dependency cycle/u);
	const owner = w.take();
	const hold = w.runtime.getWork(w.teamId, child)!.current.hold!;
	assert.equal(w.call(owner, { action: "control", command: "resume_work", workId: child.workId, expectedRevision: 1, incidentId: hold.incidentId, instruction: "Use the verified data." }).ok, true);
	w.end(owner, waitSignals(signal.id));
	const producer = w.take();
	assert.equal(w.call(producer, publish(signal.id)).ok, true);
	assert.equal(w.waits(ref(a))[0]!.blocking, false);
	assert.equal(w.runtime.getWork(w.teamId, child)!.current.state, "running");
	const consumer = w.take();
	const rejected = w.call(consumer, reply);
	assert.equal(!rejected.ok && rejected.error.code, "UNRESOLVED_CHILDREN", "a signal does not discharge child Work-result obligations");
	w.runtime.assertInvariants(w.teamId);
});

test("pending phases expose the producer's current queue blocker rather than a previous activity", () => {
	const w = world(["a", "b", "c"].map((to) => ({ to, task: to })));
	const [a, b, c] = [w.take(), w.take(), w.take()];
	const signal = phase(w, b);
	w.end(a, waitSignals(signal.id));
	assert.equal(w.call(w.lead, { action: "request", to: "b", task: "Other work for b." }).ok, true);
	w.end(b, wait(ref(c)));
	const other = w.take();
	assert.equal(other.binding.memberId, "b");
	w.end(c, reply);
	assert.equal(w.waits(ref(a))[0]!.reason, `producer queued · member busy on ${shortWorkRef(ref(other))}`);
	w.end(other, reply);
	assert.equal(w.waits(ref(a))[0]!.reason, "producer queued");
	const producer = w.take();
	assert.deepEqual(ref(producer), ref(b));
	assert.equal(w.waits(ref(a))[0]!.reason, "producer running");
	w.runtime.assertInvariants(w.teamId);
});

test("signal-cycle rejection has bounded timeline evidence while valid parent publication remains nonblocking", () => {
	const w = world(["a", "b"].map((to) => ({ to, task: to })));
	const [a, b] = [w.take(), w.take()];
	const fromA = phase(w, a), fromB = phase(w, b);
	assert.equal(w.call(a, waitSignals(fromB.id)).ok, true);
	const before = w.snapshot();
	const rejected = w.call(b, waitSignals(fromA.id));
	assert.ok(!rejected.ok && rejected.error.code === "DEPENDENCY_CYCLE");
	assert.equal(rejected.error.blockers?.[0]?.kind, "cycle");
	const notice = w.runtime.panelFacts(w.teamId).timeline.at(-1)!.text;
	assert.match(notice, /^b wait rejected: dependency cycle/u);
	assert.ok(notice.includes(fromA.id) && notice.includes(fromB.id));
	assert.deepEqual(w.snapshot(), before, "a rejected signal edge changes only diagnostic evidence");
	assert.deepEqual(w.waits(ref(b)), []);

	const valid = world([{ to: "a", task: "parent" }]);
	const parent = valid.take();
	const signal = phase(valid, parent);
	valid.request(parent, "b");
	const child = valid.take();
	valid.end(child, waitSignals(signal.id));
	assert.doesNotMatch(valid.text(), /dependency cycle/u);
	assert.equal(valid.call(parent, publish(signal.id)).ok, true);
	assert.equal(valid.waits(ref(child))[0]!.blocking, false);
	valid.runtime.assertInvariants(valid.teamId);
});
