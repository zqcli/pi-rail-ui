import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreTeamHistory } from "../../tools/subagents/team-history";
import { TEAM_JOURNAL_ENTRY_TYPE, TeamJournalGeneration, type TeamJournalRecord } from "../../tools/subagents/team-journal";
import type { WorkRef } from "../../tools/subagents/team-protocol";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";

function world(initialRequests: Array<{ to: string; task: string }>, journal?: TeamJournalGeneration, claimLead = false) {
	let ids = 0;
	let time = 1_700_000_000_000;
	const runtime = new TeamRuntime({ now: () => time++, createId: () => `id${++ids}`, ...(journal ? { journal } : {}) });
	const { teamId } = runtime.prepare({
		members: ["lead", "w1", "w2", "w3"].map((alias) => ({ alias, roleDescription: `Member ${alias}.` })), lead: "lead",
		brief: { goal: "Exercise ownership and handover." }, initialRequests, timeoutSeconds: null,
	});
	if (claimLead) runtime.claimNativeLifetime(teamId, "lead");
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

/** End the activation with its last staged call. */
function settle(runtime: TeamRuntime, activation: RuntimeActivation): void {
	const last = `call-${sequences.get(activation)}`;
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: last }).ok, true);
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
}

function end(runtime: TeamRuntime, activation: RuntimeActivation, args: unknown): void {
	assert.equal(act(runtime, activation, args).ok, true);
	settle(runtime, activation);
}

function bootIdle(runtime: TeamRuntime, teamId: string): void {
	end(runtime, take(runtime, teamId), { action: "yield" });
}

function request(runtime: TeamRuntime, activation: RuntimeActivation, to: string, task: string): WorkRef {
	const reply = act(runtime, activation, { action: "request", to, task });
	assert.ok(reply.ok && reply.receipt?.status === "accepted");
	return reply.receipt.work;
}

const workOf = (activation: RuntimeActivation): WorkRef => activation.scope.work!;
const eventKinds = (activation: RuntimeActivation) => activation.input.scope.kind === "events" ? activation.input.scope.events.map((event) => event.kind) : [];

/** w1 works the root and requests `child` from w2, waits for it, and w2 starts the child. */
function parentWithRunningChild() {
	const { runtime, teamId } = world([{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = take(runtime, teamId);
	const child = request(runtime, parent, "w2", "child");
	end(runtime, parent, { action: "yield", waitingFor: [child], checkpoint: "waiting for the child" });
	return { runtime, teamId, parent, child, childRun: take(runtime, teamId) };
}

test("a work is controlled by its requester or the lead, never by its own assignee or a third member", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "parent" }, { to: "w3", task: "bystander root" }]);
	bootIdle(runtime, teamId);
	const parent = take(runtime, teamId);
	const bystander = take(runtime, teamId);
	const child = request(runtime, parent, "w2", "child");
	const cancel = (ref: WorkRef) => ({ action: "control", command: "cancel_work", workId: ref.workId, expectedRevision: ref.revision, reason: "not needed" });

	assert.equal(errorCode(act(runtime, bystander, cancel(child))), "FORBIDDEN_ACTION", "a member that did not request the work cannot control it");
	assert.equal(errorCode(act(runtime, parent, cancel(workOf(parent)))), "FORBIDDEN_ACTION", "a member cannot control its own current work");
	assert.equal(errorCode(act(runtime, parent, { action: "control", command: "pause_member", memberId: "w2" })), "FORBIDDEN_ACTION", "member control stays lead-only");
	assert.equal(errorCode(act(runtime, parent, { action: "control", command: "close_member", memberId: "w2" })), "FORBIDDEN_ACTION");

	const revised = act(runtime, parent, { action: "control", command: "revise_work", workId: child.workId, expectedRevision: 1, task: "child, revised" });
	assert.ok(revised.ok && revised.receipt?.status === "applied", "the requester revises its sub-task");
	assert.equal(runtime.getWork(teamId, child)!.current.state, "superseded");
	const current = { workId: child.workId, revision: 2 };
	assert.equal(act(runtime, parent, cancel(current)).ok, true, "the requester cancels its sub-task");
	assert.equal(runtime.getWork(teamId, current)!.current.state, "cancelled");
	runtime.assertInvariants(teamId);
});

test("a held sub-task wakes its waiting parent with childIssues, raises no WORK_HELD, and the parent resumes it", () => {
	const { runtime, teamId, parent, child, childRun } = parentWithRunningChild();
	assert.equal(runtime.liveEffects(teamId).unprocessedEvents, 0);
	end(runtime, childRun, { action: "yield", attention: "Which branch should I diff?", checkpoint: "before diffing" });
	assert.equal(runtime.getWork(teamId, child)!.current.hold?.reason, "attention");
	assert.equal(runtime.liveEffects(teamId).unprocessedEvents, 0, "no WORK_HELD event reaches the lead");
	const incident = runtime.getTeam(teamId).incidents.find((item) => item.work?.workId === child.workId)!;

	const woken = take(runtime, teamId);
	assert.equal(woken.scope.kind, "work", "the parent runs before any lead activation");
	assert.deepEqual(workOf(woken), workOf(parent));
	assert.deepEqual(woken.input.childIssues, [{ work: child, assignee: "w2", incidentId: incident.id, reason: "attention", message: "Which branch should I diff?" }]);
	assert.deepEqual(woken.input.scope.kind === "work" && woken.input.scope.waitingFor, [child], "the parent still waits on the held child");
	assert.match(woken.input.notice, /resume_work \{workId, expectedRevision, incidentId, instruction\}.*revise_work\/cancel_work.*yield waitingFor again.*yield attention to escalate/u);
	assert.equal(runtime.getWork(teamId, workOf(parent))!.current.childIssues, undefined, "an issue is delivered once");

	const answered = act(runtime, woken, { action: "control", command: "resume_work", workId: child.workId, expectedRevision: 1, incidentId: incident.id, instruction: "Diff main" });
	assert.ok(answered.ok && answered.receipt?.status === "applied");
	end(runtime, woken, { action: "yield", waitingFor: [child], checkpoint: "waiting again" });

	const resumed = take(runtime, teamId);
	assert.deepEqual(workOf(resumed), child, "the child continues");
	assert.equal(resumed.input.scope.kind === "work" && resumed.input.scope.resumeInstruction, "Diff main");
	end(runtime, resumed, { action: "reply", result: { status: "succeeded", summary: "diffed" } });
	const again = take(runtime, teamId);
	assert.deepEqual(workOf(again), workOf(parent));
	assert.equal(again.input.childIssues, undefined);
	assert.equal(again.input.outcomes[0]?.state, "resolved");
	assert.equal(runtime.getTeam(teamId).health, "ok", "answering the issue resolved its incident");
	runtime.assertInvariants(teamId);
});

test("an issue raised while the parent is running is delivered when it next yields", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = take(runtime, teamId);
	const child = request(runtime, parent, "w2", "child");
	const childRun = take(runtime, teamId);
	end(runtime, childRun, { action: "yield", attention: "Need credentials", checkpoint: "stopped" });
	assert.equal(runtime.getWork(teamId, workOf(parent))!.current.state, "running");
	assert.equal(runtime.getWork(teamId, workOf(parent))!.current.childIssues?.length, 1, "recorded on the parent's current version");
	end(runtime, parent, { action: "yield", waitingFor: [child], checkpoint: "waiting" });
	const woken = take(runtime, teamId);
	assert.deepEqual(workOf(woken), workOf(parent), "requeued immediately instead of blocking on the held child");
	assert.equal(woken.input.childIssues?.[0]?.message, "Need credentials");
	runtime.assertInvariants(teamId);
});

test("a held root, and a sub-task whose parent cannot answer, still go to the lead as WORK_HELD", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "root" }]);
	bootIdle(runtime, teamId);
	end(runtime, take(runtime, teamId), { action: "yield", attention: "Which environment?", checkpoint: "stopped" });
	const lead = take(runtime, teamId);
	assert.equal(lead.scope.kind, "events");
	assert.ok(eventKinds(lead).includes("WORK_HELD"), "a root question is the lead's");

	const second = world([{ to: "w1", task: "parent" }]);
	bootIdle(second.runtime, second.teamId);
	const parent = take(second.runtime, second.teamId);
	const child = request(second.runtime, parent, "w2", "child");
	const childRun = take(second.runtime, second.teamId);
	end(second.runtime, parent, { action: "yield", attention: "I am stuck myself", checkpoint: "stuck" });
	end(second.runtime, childRun, { action: "yield", attention: "Child question", checkpoint: "stopped" });
	assert.equal(second.runtime.getWork(second.teamId, child)!.current.hold?.reason, "attention");
	const events = take(second.runtime, second.teamId);
	assert.deepEqual(eventKinds(events).filter((kind) => kind === "WORK_HELD").length, 2, "a held parent escalates itself and its held child to the lead");
	second.runtime.assertInvariants(second.teamId);
});

test("handover gives the pending Team events to the new lead and is refused while the lead handles events", () => {
	const journal: TeamJournalRecord[] = [];
	const { runtime, teamId } = world([], new TeamJournalGeneration((record) => journal.push(record)));
	runtime.messageLead(teamId, "ping");
	assert.throws(() => runtime.handoverLead(teamId, "lead"), /already the lead/u);
	assert.throws(() => runtime.handoverLead(teamId, "nobody"), /Unknown member/u);

	const receipt = runtime.handoverLead(teamId, "w2", "w2 knows the code");
	assert.deepEqual(receipt, { actor: "@host", status: "applied", teamId, lead: "w2" });
	assert.equal(runtime.getTeam(teamId).lead, "w2");
	const events = take(runtime, teamId);
	assert.equal(events.binding.memberId, "w2");
	assert.equal(events.input.member.lead, true);
	assert.deepEqual(events.input.roster.filter((item) => item.lead).map((item) => item.id), ["w2"]);
	assert.deepEqual(eventKinds(events), ["USER_COMMAND", "USER_COMMAND", "BOOT"]);
	assert.deepEqual(events.input.scope.kind === "events" && events.input.scope.events.filter((event) => event.kind === "USER_COMMAND").map((event) => event.message),
		["ping", "Host made you the Team lead: w2 knows the code"]);
	assert.throws(() => runtime.handoverLead(teamId, "w1"), /handling Team events/u, "refused while the lead is in an events activation");

	end(runtime, events, { action: "yield" });
	assert.equal(runtime.handoverLead(teamId, "lead").status, "applied", "back to the first lead once its events activation ended");
	assert.deepEqual(journal.filter((record) => record.kind === "handover").map((record) => record.kind === "handover" && record.lead), ["w2", "lead"]);
	runtime.assertInvariants(teamId);
});

test("after a lead fault, handover resolves LEAD_UNAVAILABLE, fails its stranded work and resumes the other members", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "parent" }], undefined, true);
	bootIdle(runtime, teamId);
	const parent = take(runtime, teamId);
	const stranded = request(runtime, parent, "lead", "work for the lead");
	end(runtime, parent, { action: "yield", waitingFor: [stranded], checkpoint: "waiting for the lead" });
	runtime.hostStopMember(teamId, "lead", "provider died");
	assert.equal(runtime.getWork(teamId, stranded)!.current.hold?.reason, "lead_unavailable");
	assert.ok(runtime.getTeam(teamId).incidents.some((item) => item.code === "LEAD_UNAVAILABLE" && item.state === "open"));
	assert.equal(runtime.takeNextActivation(teamId), undefined, "the Team is paused");

	runtime.handoverLead(teamId, "w2", "the lead failed");
	const team = runtime.getTeam(teamId);
	assert.equal(team.lead, "w2");
	assert.ok(team.incidents.filter((item) => item.code === "LEAD_UNAVAILABLE").every((item) => item.state === "resolved"));
	assert.equal(team.members.find((member) => member.id === "w1")!.pause, "none");
	const failed = runtime.getWork(teamId, stranded)!.current;
	assert.deepEqual([failed.state, failed.error?.code], ["failed", "MEMBER_UNAVAILABLE"]);

	const events = take(runtime, teamId);
	assert.equal(events.binding.memberId, "w2");
	assert.ok(eventKinds(events).includes("MEMBER_FAULTED"), "the unprocessed fault event is the new lead's");
	end(runtime, events, { action: "yield" });
	const woken = take(runtime, teamId);
	assert.deepEqual(workOf(woken), workOf(parent), "the parent is released and sees the failed outcome");
	assert.equal(woken.input.outcomes[0]?.state, "failed");
	runtime.assertInvariants(teamId);
});

test("history shows the lead after a handover", () => {
	const records: TeamJournalRecord[] = [];
	const { runtime, teamId } = world([], new TeamJournalGeneration((record) => records.push(record)));
	runtime.handoverLead(teamId, "w3");
	const restored = restoreTeamHistory(records.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data })));
	assert.equal(restored.skipped, 0);
	assert.equal(restored.teams[0]!.lead, "w3");
	assert.equal(restoreTeamHistory(records.slice(0, 1).map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data }))).teams[0]!.lead, "lead", "old journals are unaffected");
});

// Tool-loop detection: the same tool call (name + input fingerprint) failing TEAM_LOOP_REPEATS times in a row.
const HASH_A = "0123456789abcdef";
const HASH_B = "fedcba9876543210";
let toolSequence = 0;

/** One native tool call as the child reports it: the gate with the input fingerprint, then (when it ran) the result. */
function toolCall(runtime: TeamRuntime, activation: RuntimeActivation, tool: string, inputHash: string, isError: boolean) {
	const id = `tool-${++toolSequence}`;
	const decision = runtime.gate(activation.binding, activation.scope, "tool_gate", id, tool, false, inputHash);
	assert.equal(runtime.toolResult(activation.binding, activation.scope, id, tool, decision.allow ? isError : undefined).ok, true);
	return decision;
}

function abort(runtime: TeamRuntime, activation: RuntimeActivation): void {
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "aborted" }).ok, true);
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
}

test("tool loop: 8 identical failing calls hold a sub-task for its requester, who resumes it without a grant", () => {
	const { runtime, teamId, parent, child, childRun } = parentWithRunningChild();
	for (let index = 0; index < 7; index++) assert.equal(toolCall(runtime, childRun, "bash", HASH_A, true).allow, true);
	assert.deepEqual(runtime.gate(childRun.binding, childRun.scope, "provider_gate"), { allow: true }, "7 failures are not a loop");
	assert.equal(toolCall(runtime, childRun, "bash", HASH_A, true).allow, true);
	const stop = runtime.gate(childRun.binding, childRun.scope, "provider_gate");
	assert.ok(!stop.allow && stop.reason === "policy_stop" && /bash call failed 8 times in a row/u.test(stop.message), JSON.stringify(stop));
	assert.equal(toolCall(runtime, childRun, "read", HASH_B, false).allow, false, "further tool gates are denied too");
	assert.ok(runtime.panelFacts(teamId).timeline.some((entry) => entry.text === "w2 tool loop: bash failed 8× with the same input"));
	abort(runtime, childRun);

	const held = runtime.getWork(teamId, child)!.current;
	assert.deepEqual([held.state, held.hold?.reason], ["blocked", "protocol"]);
	const incident = runtime.getTeam(teamId).incidents.find((item) => item.id === held.hold?.incidentId)!;
	assert.deepEqual([incident.code, incident.message], ["TOOL_LOOP", "w2 repeated the same failing bash call 8 times; the work is held"]);
	assert.equal(runtime.liveEffects(teamId).unprocessedEvents, 0, "a sub-task issue goes to its requester, not the lead");

	const woken = take(runtime, teamId);
	assert.deepEqual(workOf(woken), workOf(parent));
	assert.deepEqual(woken.input.childIssues, [{ work: child, assignee: "w2", incidentId: incident.id, reason: "protocol", message: incident.message }]);
	const resumed = act(runtime, woken, { action: "control", command: "resume_work", workId: child.workId, expectedRevision: 1, incidentId: incident.id, instruction: "Use a different command" });
	assert.ok(resumed.ok && resumed.receipt?.status === "applied", JSON.stringify(resumed));
	assert.deepEqual(runtime.getTeam(teamId).budget.grants, [], "no host grant is needed");
	end(runtime, woken, { action: "yield", waitingFor: [child], checkpoint: "waiting again" });
	const again = take(runtime, teamId);
	assert.deepEqual(workOf(again), child);
	assert.equal(again.input.scope.kind === "work" && again.input.scope.resumeInstruction, "Use a different command");
	assert.equal(toolCall(runtime, again, "bash", HASH_A, true).allow, true, "a resumed activation starts a fresh count");
	runtime.assertInvariants(teamId);
});

test("tool loop: a looping root work is announced to the lead as WORK_HELD", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "root" }]);
	bootIdle(runtime, teamId);
	const work = take(runtime, teamId);
	for (let index = 0; index < 8; index++) toolCall(runtime, work, "bash", HASH_A, true);
	abort(runtime, work);
	const held = runtime.getWork(teamId, workOf(work))!.current;
	const incident = runtime.getTeam(teamId).incidents.find((item) => item.id === held.hold?.incidentId)!;
	assert.equal(incident.code, "TOOL_LOOP");
	const lead = take(runtime, teamId);
	assert.ok(eventKinds(lead).includes("WORK_HELD"));
	const resumed = act(runtime, lead, { action: "control", command: "resume_work", workId: workOf(work).workId, expectedRevision: 1, incidentId: incident.id, instruction: "Try another way" });
	assert.ok(resumed.ok && resumed.receipt?.status === "applied", JSON.stringify(resumed));
	end(runtime, lead, { action: "yield" });
	assert.deepEqual(workOf(take(runtime, teamId)), workOf(work));
	runtime.assertInvariants(teamId);
});

test("tool loop: a success, a different input or a different tool breaks the run", () => {
	const { runtime, teamId } = world([{ to: "w1", task: "root" }]);
	bootIdle(runtime, teamId);
	const work = take(runtime, teamId);
	const gate = () => runtime.gate(work.binding, work.scope, "provider_gate");
	for (let index = 0; index < 7; index++) toolCall(runtime, work, "bash", HASH_A, true);
	toolCall(runtime, work, "bash", HASH_A, false);
	for (let index = 0; index < 7; index++) toolCall(runtime, work, "bash", HASH_A, true);
	assert.deepEqual(gate(), { allow: true }, "7 failures + 1 success + 7 failures");
	for (let index = 0; index < 16; index++) toolCall(runtime, work, index % 2 ? "bash" : "read", HASH_A, true);
	for (let index = 0; index < 16; index++) toolCall(runtime, work, "bash", index % 2 ? HASH_A : HASH_B, true);
	assert.deepEqual(gate(), { allow: true }, "the same tool with different inputs, and different tools with the same input");
	end(runtime, work, { action: "reply", result: { status: "succeeded", summary: "done" } });
	assert.equal(runtime.getWork(teamId, workOf(work))!.current.state, "resolved");
	assert.equal(runtime.getTeam(teamId).incidents.some((item) => item.code === "TOOL_LOOP"), false);
});

test("tool loop: the lead's events activation is denied the identical call, without a hold", () => {
	const { runtime, teamId } = world([]);
	const lead = take(runtime, teamId);
	for (let index = 0; index < 8; index++) assert.equal(toolCall(runtime, lead, "bash", HASH_A, true).allow, true);
	const denied = toolCall(runtime, lead, "bash", HASH_A, true);
	assert.ok(!denied.allow && /bash call failed 8 times in a row.*Change approach/u.test(denied.message), JSON.stringify(denied));
	assert.equal(toolCall(runtime, lead, "bash", HASH_A, true).allow, false, "a denied call does not reset the run");
	assert.equal(toolCall(runtime, lead, "bash", HASH_B, false).allow, true, "a different call is allowed");
	assert.equal(toolCall(runtime, lead, "bash", HASH_A, true).allow, true, "and starts a new run");
	assert.deepEqual(runtime.gate(lead.binding, lead.scope, "provider_gate"), { allow: true });
	end(runtime, lead, { action: "yield" });
	assert.equal(runtime.getTeam(teamId).incidents.some((item) => item.code === "TOOL_LOOP"), false);
	assert.equal(runtime.getTeam(teamId).works.held, 0);
});
