import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamRuntime, type RuntimeActivation, type TeamRuntimeExecutor } from "../../tools/subagents/team-runtime";
import type { WorkRef } from "../../tools/subagents/team-protocol";

const SECOND = 1000;

function makeRuntime(initialRequests: Array<{ to: string; task: string }> = [{ to: "w1", task: "root work" }], executor?: (runtime: TeamRuntime) => TeamRuntimeExecutor) {
	let ids = 0;
	const clock = { now: 1_700_000_000_000 };
	const runtime = new TeamRuntime({ now: () => clock.now, createId: () => `id${++ids}` });
	const prepared = runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage work and close the Team." }, { alias: "w1", roleDescription: "Perform assigned work." },
			{ alias: "w2", roleDescription: "Perform other work." }], lead: "lead",
		brief: { goal: "Complete the test work." }, initialRequests, timeoutSeconds: null,
	});
	if (executor) runtime.attachExecutor(prepared.teamId, executor(runtime));
	runtime.launch(prepared.teamId);
	return { runtime, teamId: prepared.teamId, clock };
}

function take(runtime: TeamRuntime, teamId: string): RuntimeActivation {
	const activation = runtime.takeNextActivation(teamId);
	assert.ok(activation, "an activation was expected");
	return activation;
}

function action(runtime: TeamRuntime, activation: RuntimeActivation, sequence: number, id: string, args: unknown) {
	const result = runtime.handleAction(activation.binding, activation.scope, sequence, id, args, id);
	assert.equal(result.ok, true, JSON.stringify(result));
}

function inputReady(runtime: TeamRuntime, activation: RuntimeActivation): void {
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
}

function settle(runtime: TeamRuntime, activation: RuntimeActivation, toolCallId: string): void {
	runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: toolCallId });
	runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
}

function fail(runtime: TeamRuntime, activation: RuntimeActivation, message: string, transient = true): void {
	runtime.nativeSettled(activation.binding, activation.scope.activationId, {
		status: "error", error: { code: "NATIVE_FAILURE", message, ...(transient ? { transient: true as const } : {}) },
	});
	runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
}

function reply(runtime: TeamRuntime, activation: RuntimeActivation, id: string): void {
	inputReady(runtime, activation);
	action(runtime, activation, 1, id, { action: "reply", result: { status: "succeeded", summary: "done" } });
	settle(runtime, activation, id);
}

function yieldLead(runtime: TeamRuntime, activation: RuntimeActivation, id: string): void {
	inputReady(runtime, activation);
	action(runtime, activation, 1, id, { action: "yield" });
	settle(runtime, activation, id);
}

/** The next activation of a worker; lead activations on the way (Team events) are simply yielded. */
function nextWorkerActivation(runtime: TeamRuntime, teamId: string): RuntimeActivation | undefined {
	for (;;) {
		const next = runtime.takeNextActivation(teamId);
		if (next?.binding.memberId !== "lead") return next;
		yieldLead(runtime, next, `lead-${next.scope.activationId}`);
	}
}

const member = (runtime: TeamRuntime, teamId: string, id: string) => runtime.getTeam(teamId).members.find((item) => item.id === id)!;
const workRef = (activation: RuntimeActivation): WorkRef => activation.scope.work!;
const resumeInstruction = (activation: RuntimeActivation) => activation.input.scope.kind === "work" ? activation.input.scope.resumeInstruction : undefined;
const RETRY_NOTE = /temporary provider error/u;

function bootedWorkerFailing(message = "503 service unavailable") {
	const harness = makeRuntime();
	yieldLead(harness.runtime, take(harness.runtime, harness.teamId), "boot");
	const worker = take(harness.runtime, harness.teamId);
	inputReady(harness.runtime, worker);
	fail(harness.runtime, worker, message);
	return { ...harness, ref: workRef(worker) };
}

test("a transient worker error keeps the member open, requeues the work and resumes it after the wait", () => {
	const { runtime, teamId, clock, ref } = bootedWorkerFailing();
	assert.equal(member(runtime, teamId, "w1").lifecycle, "open");
	assert.equal(runtime.getWork(teamId, ref)!.current.state, "queued");
	assert.equal(runtime.getTeam(teamId).health, "ok");
	assert.match(runtime.panelFacts(teamId).retrying.get("w1")!, /^retrying 1\/5 · next 10s · 503 service unavailable$/u);
	assert.equal(runtime.takeNextActivation(teamId), undefined, "nothing is scheduled during the wait, and no MEMBER_FAULTED reaches the lead");
	clock.now += 10 * SECOND - 1;
	assert.equal(runtime.takeNextActivation(teamId), undefined);
	clock.now += 1;
	const retried = take(runtime, teamId);
	assert.deepEqual(workRef(retried), ref);
	assert.match(retried.input.notice, /temporary provider error \(503 service unavailable\).*do not repeat side effects/u);
	assert.equal(resumeInstruction(retried), undefined, "the retry note does not use the work's resume instruction");
	reply(runtime, retried, "retry-reply");
	assert.equal(runtime.getWork(teamId, ref)!.current.state, "resolved");
	assert.equal(runtime.processStats(teamId).transientRetries, 1);
	assert.equal(runtime.panelFacts(teamId).retrying.size, 0);
	runtime.assertInvariants(teamId);
});

test("a retry does not overwrite a host or lead resume instruction, and the note ends with the next success", () => {
	const { runtime, teamId, clock } = makeRuntime();
	yieldLead(runtime, take(runtime, teamId), "boot");
	const asker = take(runtime, teamId);
	inputReady(runtime, asker);
	action(runtime, asker, 1, "ask", { action: "yield", attention: "needs a decision", checkpoint: "stopped" });
	settle(runtime, asker, "ask");
	const manager = take(runtime, teamId);
	const held = (manager.input.scope.kind === "events" ? manager.input.scope.events : []).find((event) => event.kind === "WORK_HELD")!;
	inputReady(runtime, manager);
	action(runtime, manager, 1, "resume", { action: "control", command: "resume_work", workId: held.work!.workId, expectedRevision: 1,
		incidentId: held.incidentId!, instruction: "use the second approach" });
	action(runtime, manager, 2, "idle", { action: "yield" });
	settle(runtime, manager, "idle");
	const resumed = take(runtime, teamId);
	assert.equal(resumeInstruction(resumed), "use the second approach");
	assert.doesNotMatch(resumed.input.notice, RETRY_NOTE);
	inputReady(runtime, resumed);
	fail(runtime, resumed, "503 service unavailable");
	clock.now += 10 * SECOND;
	const retried = take(runtime, teamId);
	assert.equal(resumeInstruction(retried), "use the second approach");
	assert.match(retried.input.notice, RETRY_NOTE);
	// A dependency yield after the retried attempt succeeded: the work resumes later without the note.
	inputReady(runtime, retried);
	action(runtime, retried, 1, "wait", { action: "request", to: "w2", task: "sub task" });
	const child = (runtime.listWorks(teamId).find((work) => work.assignee === "w2"))!.work;
	action(runtime, retried, 2, "yield-deps", { action: "yield", waitingFor: [child], checkpoint: "waiting" });
	settle(runtime, retried, "yield-deps");
	assert.equal(runtime.panelFacts(teamId).retrying.size, 0);
	const sub = take(runtime, teamId);
	assert.equal(sub.binding.memberId, "w2");
	reply(runtime, sub, "sub-reply");
	const later = nextWorkerActivation(runtime, teamId)!;
	assert.equal(later.binding.memberId, "w1");
	assert.equal(resumeInstruction(later), "use the second approach");
	assert.doesNotMatch(later.input.notice, RETRY_NOTE, "the note does not stick to later activations of the work");
});

test("a successful completion clears the retry state, so the next error starts again at retry 1", () => {
	const { runtime, teamId, clock } = bootedWorkerFailing();
	clock.now += 10 * SECOND;
	reply(runtime, take(runtime, teamId), "retry-reply");
	const manager = take(runtime, teamId);
	inputReady(runtime, manager);
	action(runtime, manager, 1, "next", { action: "request", to: "w1", task: "next work" });
	action(runtime, manager, 2, "idle", { action: "yield" });
	settle(runtime, manager, "idle");
	const next = take(runtime, teamId);
	assert.doesNotMatch(next.input.notice, RETRY_NOTE, "an activation after a success carries no retry note");
	inputReady(runtime, next);
	fail(runtime, next, "WebSocket closed 1006");
	assert.match(runtime.panelFacts(teamId).retrying.get("w1")!, /^retrying 1\/5 · next 10s/u);
});

test("six consecutive transient errors fault the worker exactly as an untransient error does", () => {
	const { runtime, teamId, clock, ref } = bootedWorkerFailing();
	const delays = [10, 30, 60, 120, 300];
	for (const [index, delay] of delays.entries()) {
		assert.match(runtime.panelFacts(teamId).retrying.get("w1")!, new RegExp(`^retrying ${index + 1}/5 · next ${delay}s`, "u"));
		assert.equal(member(runtime, teamId, "w1").lifecycle, "open");
		clock.now += delay * SECOND;
		const retried = take(runtime, teamId);
		assert.match(retried.input.notice, RETRY_NOTE);
		inputReady(runtime, retried);
		fail(runtime, retried, "503 service unavailable");
	}
	assert.equal(member(runtime, teamId, "w1").lifecycle, "faulted");
	assert.equal(member(runtime, teamId, "w1").error?.code, "NATIVE_FAILURE");
	const failed = runtime.getWork(teamId, ref)!.current;
	assert.equal(failed.state, "failed");
	assert.equal(failed.error?.code, "NATIVE_FAILURE");
	assert.equal(runtime.getTeam(teamId).health, "needs_attention");
	assert.equal(runtime.processStats(teamId).transientRetries, 5);
	assert.equal(runtime.panelFacts(teamId).retrying.size, 0);
	const events = take(runtime, teamId).input.scope;
	assert.equal(events.kind === "events" && events.events.some((event) => event.kind === "MEMBER_FAULTED"), true);
});

test("an error that is not transient faults the worker at once", () => {
	const { runtime, teamId, ref } = (() => {
		const harness = makeRuntime();
		yieldLead(harness.runtime, take(harness.runtime, harness.teamId), "boot");
		const worker = take(harness.runtime, harness.teamId);
		inputReady(harness.runtime, worker);
		fail(harness.runtime, worker, "insufficient_quota", false);
		return { ...harness, ref: workRef(worker) };
	})();
	assert.equal(member(runtime, teamId, "w1").lifecycle, "faulted");
	assert.equal(runtime.getWork(teamId, ref)!.current.state, "failed");
	assert.equal(runtime.processStats(teamId).transientRetries, 0);
});

test("a transient lead error re-delivers the same events after the wait while the other members keep running", () => {
	const { runtime, teamId, clock } = makeRuntime();
	const boot = take(runtime, teamId);
	assert.equal(boot.scope.kind, "events");
	const bootEvents = boot.input.scope.kind === "events" ? boot.input.scope.events.map((event) => event.id) : [];
	inputReady(runtime, boot);
	fail(runtime, boot, "request_timeout: stream error: stream disconnected before completion");
	assert.equal(member(runtime, teamId, "lead").lifecycle, "open");
	assert.equal(runtime.getTeam(teamId).health, "ok");
	assert.match(runtime.panelFacts(teamId).retrying.get("lead")!, /^retrying 1\/5 · next 10s/u);
	const worker = take(runtime, teamId);
	assert.equal(worker.binding.memberId, "w1", "a worker is still activated while the lead waits");
	assert.equal(member(runtime, teamId, "w1").pause, "none");
	reply(runtime, worker, "worker-reply");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "the lead is not activated before its wait ends");
	clock.now += 10 * SECOND;
	const again = take(runtime, teamId);
	assert.equal(again.binding.memberId, "lead");
	const events = again.input.scope.kind === "events" ? again.input.scope.events : [];
	assert.deepEqual(bootEvents.filter((id) => !events.some((event) => event.id === id)), [], "the unfinished batch is delivered again");
	assert.equal(events.some((event) => event.kind === "ROOT_RESULT_READY"), true);
	assert.match(again.input.notice, /temporary provider error \(request_timeout/u, "the re-delivered events activation carries the note");
	yieldLead(runtime, again, "lead-yield");
	assert.equal(runtime.panelFacts(teamId).retrying.size, 0);
	assert.equal(member(runtime, teamId, "lead").lifecycle, "open");
	runtime.assertInvariants(teamId);
});

test("a lead that keeps failing transiently faults after 30 minutes like any lead fault", () => {
	const { runtime, teamId, clock } = makeRuntime([]);
	let failures = 0;
	while (member(runtime, teamId, "lead").lifecycle === "open") {
		const lead = take(runtime, teamId);
		inputReady(runtime, lead);
		fail(runtime, lead, "503 service unavailable");
		failures++;
		assert.ok(failures <= 10, "the lead must not retry forever");
		if (failures === 6) assert.match(runtime.panelFacts(teamId).retrying.get("lead")!, /^retrying 6 · next 300s/u, "after 5 the lead's count has no limit");
		clock.now += 300 * SECOND;
	}
	assert.equal(failures, 7, "5 retries, then every 5 minutes until 30 minutes after the first error");
	assert.equal(member(runtime, teamId, "lead").lifecycle, "faulted");
	assert.equal(member(runtime, teamId, "lead").error?.code, "NATIVE_FAILURE");
	assert.equal(member(runtime, teamId, "w1").pause, "confirmed", "the other members are paused as for any lead fault");
	assert.equal(runtime.getTeam(teamId).health, "needs_attention");
	assert.equal(runtime.panelFacts(teamId).retrying.size, 0);
});

test("cancelling or revising work during the retry wait behaves like any queued work", () => {
	for (const command of ["cancel_work", "revise_work"] as const) {
		const { runtime, teamId, clock, ref } = bootedWorkerFailing();
		runtime.hostControl(teamId).message_lead("change of plan");
		const manager = take(runtime, teamId);
		inputReady(runtime, manager);
		action(runtime, manager, 1, command, command === "cancel_work"
			? { action: "control", command, workId: ref.workId, expectedRevision: 1, reason: "Not needed." }
			: { action: "control", command, workId: ref.workId, expectedRevision: 1, task: "revised work" });
		action(runtime, manager, 2, "idle", { action: "yield" });
		settle(runtime, manager, "idle");
		assert.equal(nextWorkerActivation(runtime, teamId), undefined, "the member still waits out its retry delay");
		clock.now += 10 * SECOND;
		if (command === "cancel_work") {
			assert.equal(runtime.getWork(teamId, ref)!.current.state, "cancelled");
			assert.equal(nextWorkerActivation(runtime, teamId), undefined);
		} else {
			const revised = nextWorkerActivation(runtime, teamId)!;
			assert.deepEqual(workRef(revised), { workId: ref.workId, revision: 2 });
			assert.equal(resumeInstruction(revised), undefined);
			assert.match(revised.input.notice, RETRY_NOTE, "the note belongs to the member's retry, not to one revision");
		}
		runtime.assertInvariants(teamId);
	}
});

test("the retry timer wakes the scheduler when the wait ends", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
	const notices: string[] = [];
	let workRuns = 0;
	const { clock } = makeRuntime([{ to: "w1", task: "root work" }], (rt) => ({
		runActivation: async (activation) => {
			assert.equal(rt.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
			if (activation.scope.kind === "events") {
				rt.handleAction(activation.binding, activation.scope, 1, "yield", { action: "yield" }, "yield");
				settle(rt, activation, "yield");
				return;
			}
			notices.push(activation.input.notice);
			if (++workRuns === 1) fail(rt, activation, "503 service unavailable");
			else {
				rt.handleAction(activation.binding, activation.scope, 1, "reply", { action: "reply", result: { status: "succeeded", summary: "done" } }, "reply");
				settle(rt, activation, "reply");
			}
		},
		closeMember: async () => ({ ok: true }),
	}));
	await flush();
	assert.equal(workRuns, 1);
	clock.now += 10 * SECOND;
	t.mock.timers.tick(10 * SECOND);
	await flush();
	assert.equal(workRuns, 2, "the timer drained the Runtime without any other event");
	assert.match(notices[1] ?? "", RETRY_NOTE);
	assert.doesNotMatch(notices[0] ?? "", RETRY_NOTE);
});
