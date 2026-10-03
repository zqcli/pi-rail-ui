import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamProtocolError } from "../../tools/subagents/team-codec";
import type { WorkRef } from "../../tools/subagents/team-protocol";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";

function world(initialRequests: Array<{ to: string; task: string }>) {
	let ids = 0;
	let time = 1_700_000_000_000;
	const runtime = new TeamRuntime({ now: () => time++, createId: () => `id${++ids}` });
	const { teamId } = runtime.prepare({
		members: ["lead", "w1", "w2", "w3"].map((alias) => ({ alias, roleDescription: `Member ${alias}.` })), lead: "lead",
		brief: { goal: "Exercise faulted members." }, initialRequests, timeoutSeconds: null,
	});
	runtime.launch(teamId);
	return { runtime, teamId };
}

const sequences = new WeakMap<RuntimeActivation, number>();
function act(runtime: TeamRuntime, activation: RuntimeActivation, args: unknown) {
	const sequence = (sequences.get(activation) ?? 0) + 1;
	sequences.set(activation, sequence);
	return runtime.handleAction(activation.binding, activation.scope, sequence, `call-${sequence}`, args, `call-${sequence}`);
}
const errorCode = (reply: ReturnType<typeof act>) => reply.ok ? undefined : reply.error.code;

function take(runtime: TeamRuntime, teamId: string): RuntimeActivation {
	const activation = runtime.takeNextActivation(teamId)!;
	assert.ok(activation);
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
	return activation;
}

function settle(runtime: TeamRuntime, activation: RuntimeActivation): void {
	const last = `call-${sequences.get(activation)}`;
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: last }).ok, true);
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
}

function end(runtime: TeamRuntime, activation: RuntimeActivation, args: unknown): void {
	assert.equal(act(runtime, activation, args).ok, true);
	settle(runtime, activation);
}

/** A native provider error ends the activation: the member is faulted, its process still owned. */
function fault(runtime: TeamRuntime, activation: RuntimeActivation): void {
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "error", error: { code: "NATIVE_FAILURE", message: "boom" } }).ok, true);
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
}

const workOf = (activation: RuntimeActivation): WorkRef => activation.scope.work!;
const events = (activation: RuntimeActivation) => activation.input.scope.kind === "events" ? activation.input.scope.events : [];
const memberOf = (runtime: TeamRuntime, teamId: string, id: string) => runtime.getTeam(teamId).members.find((member) => member.id === id)!;
const state = (runtime: TeamRuntime, teamId: string, id: string) => [memberOf(runtime, teamId, id).lifecycle, memberOf(runtime, teamId, id).resourceState];
const waive = (runtime: TeamRuntime, lead: RuntimeActivation, work: WorkRef) =>
	act(runtime, lead, { action: "control", command: "accept_result", work, disposition: "waived", reason: "Worker failed." });

function closeTeam(runtime: TeamRuntime, lead: RuntimeActivation, args: Record<string, unknown>): string {
	const closed = act(runtime, lead, { action: "control", command: "close_team", ...args });
	assert.ok(closed.ok && closed.receipt?.status === "closing", JSON.stringify(closed));
	return closed.receipt.closeId;
}

function release(runtime: TeamRuntime, teamId: string, id: string, closeId: string): void {
	assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, id), closeId, { ok: true }).ok, true);
}

function bootIdle(runtime: TeamRuntime, teamId: string): void {
	end(runtime, take(runtime, teamId), { action: "yield" });
}

test("close_team with a partial outcome stops a faulted worker's process and ends with the worker still faulted", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "fails" }, { to: "w2", task: "succeeds" }]);
	bootIdle(runtime, teamId);
	const failing = take(runtime, teamId);
	const working = take(runtime, teamId);
	fault(runtime, failing);
	end(runtime, working, { action: "reply", result: { status: "succeeded", summary: "done" } });
	assert.deepEqual(state(runtime, teamId, "w1"), ["faulted", "owned"]);

	const lead = take(runtime, teamId);
	assert.equal(waive(runtime, lead, workOf(failing)).ok, true);
	assert.equal(act(runtime, lead, { action: "control", command: "accept_result", work: workOf(working), disposition: "accepted" }).ok, true);
	const closeId = closeTeam(runtime, lead, { resultRefs: [runtime.getWork(teamId, workOf(working))!.current.resultRef], outcome: "partial", reason: "One worker failed." });
	assert.deepEqual(state(runtime, teamId, "w1"), ["faulted", "stopping"], "the fault stays; only the live process is stopped");
	settle(runtime, lead);
	release(runtime, teamId, "w1", closeId);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closing", "the other exits are still pending");
	for (const id of ["w2", "w3", "lead"]) release(runtime, teamId, id, closeId);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closed");
	assert.deepEqual(state(runtime, teamId, "w1"), ["faulted", "released"]);
	runtime.assertInvariants(teamId);
});

test("close_team while a faulted worker is already stopping is accepted and completes after that release", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "fails" }]);
	bootIdle(runtime, teamId);
	const failing = take(runtime, teamId);
	fault(runtime, failing);
	const lead = take(runtime, teamId);
	const memberClose = act(runtime, lead, { action: "control", command: "close_member", memberId: "w1" });
	assert.ok(memberClose.ok && memberClose.receipt?.status === "closing");
	const workerCloseId = memberClose.receipt.closeId;
	assert.equal(waive(runtime, lead, workOf(failing)).ok, true);
	const closeId = closeTeam(runtime, lead, { resultRefs: [], outcome: "failed", reason: "Worker failed." });
	settle(runtime, lead);
	for (const id of ["w2", "w3", "lead"]) release(runtime, teamId, id, closeId);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closing", "the worker's own close is still pending");
	release(runtime, teamId, "w1", workerCloseId);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closed");
	assert.deepEqual(state(runtime, teamId, "w1"), ["faulted", "released"]);
	runtime.assertInvariants(teamId);
});

test("close_member stops a faulted member's process, repeats as closing, and is applied once released; an unconfirmed exit stays refused", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "fails" }, { to: "w2", task: "fails too" }]);
	bootIdle(runtime, teamId);
	const first = take(runtime, teamId);
	const second = take(runtime, teamId);
	fault(runtime, first);
	fault(runtime, second);
	const lead = take(runtime, teamId);
	const close = (id: string) => act(runtime, lead, { action: "control", command: "close_member", memberId: id });
	const revive = (id: string) => act(runtime, lead, { action: "control", command: "revive_member", memberId: id });

	const closing = close("w1");
	assert.ok(closing.ok && closing.receipt?.status === "closing" && closing.receipt.memberId === "w1");
	assert.deepEqual(state(runtime, teamId, "w1"), ["faulted", "stopping"]);
	const again = close("w1");
	assert.ok(again.ok && again.receipt?.status === "closing" && again.receipt.closeId === closing.receipt.closeId);
	assert.equal(errorCode(revive("w1")), "MEMBER_UNAVAILABLE", "a process that is closing cannot be revived");
	release(runtime, teamId, "w1", closing.receipt.closeId);
	assert.deepEqual(state(runtime, teamId, "w1"), ["faulted", "released"]);
	const applied = close("w1");
	assert.ok(applied.ok && applied.receipt?.status === "applied");
	assert.match(JSON.stringify(revive("w1")), /process has exited/u);
	assert.throws(() => runtime.reviveMember(teamId, "w1"), (error) => error instanceof TeamProtocolError && error.code === "MEMBER_UNAVAILABLE");

	const unconfirmed = close("w2");
	assert.ok(unconfirmed.ok && unconfirmed.receipt?.status === "closing");
	assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, "w2"), unconfirmed.receipt.closeId, { ok: false, error: { code: "CLEANUP_FAILED", message: "no exit" } }).ok, false);
	assert.deepEqual(state(runtime, teamId, "w2"), ["faulted", "cleanup_failed"]);
	assert.equal(errorCode(close("w2")), "RECIPIENT_CLOSED");
	assert.equal(errorCode(revive("w2")), "MEMBER_UNAVAILABLE");
	assert.equal(errorCode(revive("lead")), "FORBIDDEN_ACTION");
	runtime.assertInvariants(teamId);
});

test("after a handover from a faulted lead, the new lead can close the Team", () => {
	const { runtime, teamId } = world([]);
	bootIdle(runtime, teamId);
	runtime.messageLead(teamId, "ping");
	fault(runtime, take(runtime, teamId));
	assert.deepEqual(state(runtime, teamId, "lead"), ["faulted", "owned"]);
	runtime.handoverLead(teamId, "w2", "the lead failed");

	const lead = take(runtime, teamId);
	assert.equal(lead.binding.memberId, "w2");
	const closeId = closeTeam(runtime, lead, { resultRefs: [], outcome: "failed", reason: "The lead failed." });
	assert.deepEqual(state(runtime, teamId, "lead"), ["faulted", "stopping"]);
	settle(runtime, lead);
	for (const id of ["lead", "w1", "w2", "w3"]) release(runtime, teamId, id, closeId);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closed");
	runtime.assertInvariants(teamId);
});

test("revive_member lets the lead reopen a faulted worker and revise its failed work; only the lead may, and not itself or an open member", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "root" }, { to: "w2", task: "bystander" }]);
	bootIdle(runtime, teamId);
	const failing = take(runtime, teamId);
	const bystander = take(runtime, teamId);
	const root = workOf(failing);
	fault(runtime, failing);
	const revive = (activation: RuntimeActivation, id: string) => act(runtime, activation, { action: "control", command: "revive_member", memberId: id });
	assert.equal(errorCode(revive(bystander, "w1")), "FORBIDDEN_ACTION", "only the lead");
	end(runtime, bystander, { action: "reply", result: { status: "succeeded", summary: "done" } });

	const lead = take(runtime, teamId);
	const fault_ = events(lead).find((event) => event.kind === "MEMBER_FAULTED")!;
	assert.match(fault_.message, /revive_member/u, "the failure event tells the lead about reviving");
	assert.equal(errorCode(revive(lead, "lead")), "FORBIDDEN_ACTION");
	assert.equal(errorCode(revive(lead, "w2")), "MEMBER_UNAVAILABLE", "an open member is not faulted");
	assert.equal(errorCode(revive(lead, "nobody")), "UNKNOWN_MEMBER");
	const revived = revive(lead, "w1");
	assert.ok(revived.ok && revived.receipt?.status === "applied" && revived.receipt.command === "revive_member" && revived.receipt.memberId === "w1");
	assert.deepEqual(state(runtime, teamId, "w1"), ["open", "owned"]);
	assert.equal(memberOf(runtime, teamId, "w1").error, undefined);
	assert.equal(runtime.getTeam(teamId).health, "ok");
	assert.equal(runtime.getWork(teamId, root)!.current.state, "failed", "the failed work stays failed");
	assert.equal(act(runtime, lead, { action: "control", command: "revise_work", workId: root.workId, expectedRevision: root.revision, task: "root, again" }).ok, true);
	settle(runtime, lead);

	const rerun = take(runtime, teamId);
	assert.equal(rerun.binding.memberId, "w1");
	assert.deepEqual(workOf(rerun), { workId: root.workId, revision: 2 });
	end(runtime, rerun, { action: "reply", result: { status: "succeeded", summary: "fixed" } });
	assert.equal(runtime.getWork(teamId, { workId: root.workId, revision: 2 })!.current.state, "resolved");
	runtime.assertInvariants(teamId);
});

test("host revive of a faulted worker reopens it and tells the lead", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "root" }]);
	bootIdle(runtime, teamId);
	fault(runtime, take(runtime, teamId));
	assert.throws(() => runtime.reviveMember(teamId, "nobody"), (error) => error instanceof TeamProtocolError && error.code === "UNKNOWN_MEMBER");
	assert.throws(() => runtime.reviveMember(teamId, "w2"), (error) => error instanceof TeamProtocolError && error.code === "MEMBER_UNAVAILABLE");
	assert.deepEqual(runtime.reviveMember(teamId, "w1"), { actor: "@host", status: "applied", teamId, memberId: "w1" });
	assert.deepEqual(state(runtime, teamId, "w1"), ["open", "owned"]);
	const lead = take(runtime, teamId);
	const command = events(lead).find((event) => event.kind === "USER_COMMAND")!;
	assert.equal(command.actor, "@host");
	assert.match(command.message, /The host revived w1; its earlier failed work stays failed/u);
	runtime.assertInvariants(teamId);
});

test("host revive of a faulted lead requeues its held work, redelivers its events, unpauses the members and lets the Team finish", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = take(runtime, teamId);
	const stranded = act(runtime, parent, { action: "request", to: "lead", task: "work for the lead" });
	assert.ok(stranded.ok && stranded.receipt?.status === "accepted");
	const strandedRef = stranded.receipt.work;
	end(runtime, parent, { action: "yield", waitingFor: [strandedRef], checkpoint: "waiting for the lead" });
	runtime.messageLead(teamId, "ping");
	const faulted = take(runtime, teamId);
	assert.equal(faulted.scope.kind, "events");
	fault(runtime, faulted);
	assert.equal(runtime.getWork(teamId, strandedRef)!.current.hold?.reason, "lead_unavailable");
	assert.equal(memberOf(runtime, teamId, "w2").pause, "confirmed");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "the Team is paused");
	assert.match(runtime.panelFacts(teamId).waitingFor ?? "", /^Lead failed: revive it \(v\) or hand the lead over \(l\)/u, "the panel says what the host can do");

	assert.deepEqual(runtime.reviveMember(teamId, "lead"), { actor: "@host", status: "applied", teamId, memberId: "lead" });
	assert.deepEqual(state(runtime, teamId, "lead"), ["open", "owned"]);
	const held = runtime.getWork(teamId, strandedRef)!.current;
	assert.deepEqual([held.state, held.hold], ["queued", undefined], "requeued, not failed");
	assert.ok(runtime.getTeam(teamId).incidents.filter((item) => item.code === "LEAD_UNAVAILABLE").every((item) => item.state === "resolved"));
	assert.equal(memberOf(runtime, teamId, "w2").pause, "none");
	assert.equal(runtime.getTeam(teamId).health, "ok");

	const lead = take(runtime, teamId);
	assert.equal(lead.scope.kind, "events");
	assert.ok(events(lead).some((event) => event.kind === "MEMBER_FAULTED"));
	assert.ok(events(lead).some((event) => event.message === "ping"), "the batch the lead never finished is delivered again");
	assert.ok(events(lead).some((event) => event.actor === "@host" && /The host revived lead/u.test(event.message)));
	end(runtime, lead, { action: "yield" });

	const leadWork = take(runtime, teamId);
	assert.deepEqual(workOf(leadWork), strandedRef);
	end(runtime, leadWork, { action: "reply", result: { status: "succeeded", summary: "lead did it" } });
	const woken = take(runtime, teamId);
	assert.deepEqual(workOf(woken), workOf(parent));
	assert.equal(woken.input.outcomes[0]?.state, "resolved");
	end(runtime, woken, { action: "reply", result: { status: "succeeded", summary: "parent done" } });

	const closing = take(runtime, teamId);
	assert.equal(act(runtime, closing, { action: "control", command: "accept_result", work: workOf(parent), disposition: "accepted" }).ok, true);
	const closeId = closeTeam(runtime, closing, { resultRefs: [runtime.getWork(teamId, workOf(parent))!.current.resultRef], outcome: "succeeded" });
	settle(runtime, closing);
	for (const id of ["lead", "w1", "w2", "w3"]) release(runtime, teamId, id, closeId);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closed");
	runtime.assertInvariants(teamId);
});
