import assert from "node:assert/strict";
import { test } from "node:test";
import {
	TeamProtocolError, encodeActivationInput, jsonBytes, normalizeTeamAction, normalizeTeamPlan, parseChildFrame, parseParentCommand, parseTeamReply,
} from "../../tools/subagents/team-codec";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import { TEAM_MAX_ACTIVATION_INPUT_BYTES, TEAM_MAX_FRAME_BYTES, TEAM_MAX_RESULT_BYTES, type WorkRef } from "../../tools/subagents/team-protocol";

function makeRuntime(initialRequests: Array<{ to: string; task: string }> = [{ to: "w1", task: "root work" }]) {
	let ids = 0;
	let time = 1_700_000_000_000;
	const runtime = new TeamRuntime({ now: () => time++, createId: () => `id${++ids}` });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage work, review roots and close the Team." },
		workers: [
			{ alias: "w1", roleDescription: "Perform assigned work." },
			{ alias: "w2", roleDescription: "Perform dependent work." },
		],
		brief: { goal: "Complete the test work." },
		initialRequests,
		timeoutSeconds: null,
	});
	runtime.launch(prepared.teamId);
	return { runtime, teamId: prepared.teamId };
}

function action(runtime: TeamRuntime, activation: RuntimeActivation, sequence: number, rpcRequestId: string, args: unknown, toolCallId = rpcRequestId) {
	return runtime.handleAction(activation.binding, activation.scope, sequence, rpcRequestId, args, toolCallId);
}

function inputReady(runtime: TeamRuntime, activation: RuntimeActivation): void {
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
}

function settle(runtime: TeamRuntime, activation: RuntimeActivation, toolCallId?: string, finalAssistantText?: string): void {
	const completion = {
		status: "success",
		...(toolCallId ? { appliedToolCallId: toolCallId } : {}),
		...(finalAssistantText !== undefined ? { finalAssistantText } : {}),
	} as const;
	const cleanup = { ok: true } as const;
	runtime.nativeSettled(activation.binding, activation.scope.activationId, completion);
	runtime.cleanupFinished(activation.binding, activation.scope.activationId, cleanup);
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true, "late duplicate input_ready is idempotent");
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, completion).ok, true, "late duplicate settlement is idempotent");
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, cleanup).ok, true, "late duplicate cleanup is idempotent");
}

function finishManagerBoot(runtime: TeamRuntime, teamId: string): void {
	const activation = runtime.takeNextActivation(teamId)!;
	assert.equal(activation.scope.kind, "management");
	inputReady(runtime, activation);
	const staged = action(runtime, activation, 1, "boot-yield", { action: "yield" });
	assert.equal(staged.ok, true);
	settle(runtime, activation, "boot-yield");
}

function reply(runtime: TeamRuntime, activation: RuntimeActivation, callId: string, summary: string, sequence = 1): void {
	inputReady(runtime, activation);
	const staged = action(runtime, activation, sequence, callId, { action: "reply", result: { status: "succeeded", summary } });
	assert.equal(staged.ok, true);
	settle(runtime, activation, callId);
}

function code(replyValue: ReturnType<typeof action>): string | undefined {
	return replyValue.ok ? undefined : replyValue.error.code;
}

function workRef(activation: RuntimeActivation): WorkRef {
	assert.equal(activation.scope.kind, "work");
	return activation.scope.work!;
}

function businessSnapshot(runtime: TeamRuntime, teamId: string, refs: readonly WorkRef[] = []) {
	const works = refs.map((ref) => runtime.getWork(teamId, ref));
	const resultRefs = new Set(works.flatMap((work) => work?.revisions.flatMap((revision) => revision.resultRef ? [revision.resultRef] : []) ?? []));
	return {
		team: runtime.getTeam(teamId),
		works,
		results: [...resultRefs].sort().map((resultRef) => runtime.getResult(teamId, resultRef)),
		teamResult: runtime.getTeamResult(teamId),
	};
}

test("P: v2 codec rejects v1 live frames, legacy actions, unknown fields and non-JSON values", () => {
	assert.throws(() => parseChildFrame({ version: 1, kind: "request" }), (error) => error instanceof TeamProtocolError && error.code === "UNSUPPORTED_PROTOCOL");
	for (const args of [
		{ action: "wait", wait: { kind: "message" } },
		{ action: "request", to: "w1", task: "work", afterSeq: 2 },
		{ action: "toString" },
		{ action: "request", to: "w1", task: "work", surprise: true },
	]) assert.throws(() => normalizeTeamAction(args), TeamProtocolError);
	assert.throws(() => jsonBytes({ value: Number.NaN }), TeamProtocolError);
	assert.throws(() => jsonBytes({ value: 1n }), TeamProtocolError);
	const resume = normalizeTeamAction({ action: "control", command: "resume_member", memberId: "w1" });
	assert.equal(resume.action, "control");
	if (resume.action === "control") assert.equal(resume.control.command, "resume_member");
	assert.deepEqual(normalizeTeamPlan({
		manager: { alias: "lead", roleDescription: "Manage." },
		workers: [{ alias: "w1", roleDescription: "Work." }], brief: { goal: "Test." }, timeoutSeconds: null,
	}), {
		manager: { alias: "lead", roleDescription: "Manage.", policy: {} },
		workers: [{ alias: "w1", roleDescription: "Work.", policy: {} }],
		brief: { goal: "Test." }, initialRequests: [], timeoutSeconds: null,
	});
});

test("P: prepare rejects initial per-member overflow before reserving a Team or changing live state", () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `prepare-${++ids}`, limits: { memberUnresolvedWork: 1 } });
	const active = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "Existing Team." }, timeoutSeconds: null,
	});
	runtime.launch(active.teamId);
	const before = runtime.getTeam(active.teamId);
	const idsBefore = ids;
	assert.throws(() => runtime.prepare({
		manager: { alias: "other", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "Too many initial assignments." }, timeoutSeconds: null,
		initialRequests: [{ to: "w1", task: "one" }, { to: "w1", task: "two" }],
	}), (error) => error instanceof TeamProtocolError && error.code === "REQUEST_QUEUE_FULL");
	assert.equal(ids, idsBefore, "rejected prepare does not allocate a Team or member lifetime");
	assert.deepEqual(runtime.getTeam(active.teamId), before);
	runtime.assertInvariants(active.teamId);
});

test("P: request admission is activation-idempotent and derives identity/root from the binding", () => {
	const { runtime, teamId } = makeRuntime([]);
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const args = { action: "request", to: "w1", task: "inspect protocol" };
	const accepted = action(runtime, manager, 1, "request-1", args);
	assert.equal(accepted.ok, true);
	assert.equal(accepted.ok && accepted.receipt?.status, "accepted");
	const acceptedWork = accepted.ok && accepted.receipt?.status === "accepted" ? accepted.receipt.work : undefined;
	assert.ok(acceptedWork);
	const afterAccept = businessSnapshot(runtime, teamId, [acceptedWork]);
	assert.deepEqual(action(runtime, manager, 1, "request-1", args), accepted);
	assert.equal(code(action(runtime, manager, 1, "request-1", { ...args, task: "different" })), "PROTOCOL_FAILURE");
	assert.deepEqual(businessSnapshot(runtime, teamId, [acceptedWork]), afterAccept, "conflicting duplicate leaves authoritative business state unchanged");
	const forged = { ...manager.binding, memberId: "w1", role: "worker" as const };
	assert.equal(runtime.handleAction(forged, manager.scope, 2, "forged", args).ok, false);
	assert.deepEqual(businessSnapshot(runtime, teamId, [acceptedWork]), afterAccept, "forged binding leaves authoritative business state unchanged");
	runtime.assertInvariants(teamId);
});

test("A/A09: provider/tool gates require the exact delivered WorkRef; a post-intent continuation stays settling and bounded", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const activation = runtime.takeNextActivation(teamId)!;
	assert.equal(activation.scope.kind, "work");
	assert.deepEqual(runtime.gate(activation.binding, activation.scope, "provider_gate"), {
		allow: false, reason: "delivery_pending", message: "The exact activation input is not acknowledged yet",
	});
	inputReady(runtime, activation);
	assert.deepEqual(runtime.gate(activation.binding, activation.scope, "provider_gate"), { allow: true });
	assert.deepEqual(runtime.gate(activation.binding, activation.scope, "tool_gate"), { allow: true });
	const staged = action(runtime, activation, 1, "gate-stage", { action: "reply", result: { status: "succeeded", summary: "done" } });
	assert.equal(staged.ok, true);
	assert.equal(runtime.gate(activation.binding, activation.scope, "tool_gate").allow, false);
	// A09: a third-party continuation after the intent is observed, counted and recorded; it gets no side effects.
	assert.deepEqual(runtime.gate(activation.binding, activation.scope, "provider_gate"), { allow: true });
	assert.equal(runtime.gate(activation.binding, activation.scope, "tool_gate", "after-intent-write", "write").allow, false);
	assert.equal(code(action(runtime, activation, 2, "after-intent-request", { action: "request", to: "w2", task: "new side effect" })), "INTENT_CONFLICT");
	const team = runtime.getTeam(teamId);
	const conflict = team.incidents.filter((incident) => incident.code === "POST_INTENT_CONTINUATION");
	assert.equal(conflict.length, 1);
	assert.equal(conflict[0]!.state, "resolved");
	assert.equal(team.health, "ok", "a diagnostic continuation record does not demand attention");
	assert.equal(team.budget.used.teamModelRequests, 2, "the continuation is a counted provider request");
	runtime.assertInvariants(teamId);
});

test("C01: an idle paused worker accepts new work without launching it, then resumes unchanged", () => {
	const { runtime, teamId } = makeRuntime([
		{ to: "w1", task: "paused root" },
		{ to: "w2", task: "independent root" },
	]);
	finishManagerBoot(runtime, teamId);
	const host = runtime.hostControl(teamId);
	assert.equal(host.message_manager("pause w1").actor, "@host");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	assert.equal(code(action(runtime, manager, 1, "pause-w1", { action: "control", command: "pause_member", memberId: "w1" })), undefined);
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause, "confirmed");
	const repeatedPause = action(runtime, manager, 2, "pause-w1-again", { action: "control", command: "pause_member", memberId: "w1" });
	assert.equal(repeatedPause.ok && repeatedPause.receipt?.status, "unchanged");
	const accepted = action(runtime, manager, 3, "request-while-paused", { action: "request", to: "w1", task: "new paused root" });
	assert.equal(accepted.ok && accepted.receipt?.status, "accepted");
	assert.equal(accepted.ok && accepted.receipt?.status === "accepted" && accepted.receipt.paused, true);
	assert.equal(action(runtime, manager, 4, "pause-manager-yield", { action: "yield" }).ok, true);
	settle(runtime, manager, "pause-manager-yield");
	const independent = runtime.takeNextActivation(teamId)!;
	assert.equal(independent.binding.memberId, "w2", "a paused worker does not hold an execution permit");
	reply(runtime, independent, "independent-reply", "w2 completed");

	host.message_manager("resume w1");
	const resumeManager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, resumeManager);
	assert.equal(code(action(runtime, resumeManager, 1, "resume-w1", { action: "control", command: "resume_member", memberId: "w1" })), undefined);
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause, "none");
	action(runtime, resumeManager, 2, "resume-manager-yield", { action: "yield" });
	settle(runtime, resumeManager, "resume-manager-yield");
	const resumed = runtime.takeNextActivation(teamId)!;
	assert.equal(resumed.binding.memberId, "w1");
	assert.equal(resumed.input.scope.kind, "work");
	if (resumed.input.scope.kind === "work") assert.equal(resumed.input.scope.task, "paused root", "resume keeps the original WorkRef/task");
	runtime.assertInvariants(teamId);
});

test("C02/C03: pause waits for approved native tools, acknowledges every preflight result, and reacquires its permit", async () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `pause-${++ids}`, limits: { workerPermits: 1 } });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage work." },
		workers: [{ alias: "w1", roleDescription: "First worker." }, { alias: "w2", roleDescription: "Second worker." }],
		brief: { goal: "Exercise safe-point pause." },
		initialRequests: [{ to: "w1", task: "latched work" }, { to: "w2", task: "permit waiter" }],
		timeoutSeconds: null,
	});
	runtime.launch(prepared.teamId);
	finishManagerBoot(runtime, prepared.teamId);
	const first = runtime.takeNextActivation(prepared.teamId)!;
	assert.equal(first.binding.memberId, "w1");
	inputReady(runtime, first);
	assert.equal(runtime.gate(first.binding, first.scope, "tool_gate", "approved-read", "read").allow, true);
	runtime.hostControl(prepared.teamId).message_manager("pause w1 at its next safe point");
	const manager = runtime.takeNextActivation(prepared.teamId)!;
	inputReady(runtime, manager);
	action(runtime, manager, 1, "request-pause", { action: "control", command: "pause_member", memberId: "w1" });
	action(runtime, manager, 2, "manager-yield", { action: "yield" });
	settle(runtime, manager, "manager-yield");
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.pause, "requested");
	assert.deepEqual(runtime.gate(first.binding, first.scope, "tool_gate", "blocked-write", "write"), {
		allow: false, reason: "paused", message: "This member is paused by TeamRuntime",
	});
	assert.equal(runtime.toolResult(first.binding, first.scope, "blocked-write", "write").ok, true,
		"a blocked call still reports its exact native tool_result without waiting on earlier calls");
	assert.equal(runtime.toolResult(first.binding, first.scope, "blocked-write", "write").ok, true,
		"a duplicate event from Pi is idempotent for the exact same native call ID/name");
	assert.throws(() => runtime.toolResult(first.binding, first.scope, "blocked-write", "bash"),
		(error: unknown) => error instanceof TeamProtocolError && error.code === "PROTOCOL_FAILURE",
		"a duplicate result cannot change the native tool name");
	let gateDecision: boolean | undefined;
	const waitingAtProvider = runtime.waitAtProviderGate(first.binding, first.scope).then((decision) => {
		gateDecision = decision.allow;
		return decision;
	});
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.pause, "requested",
		"the already approved side effect is not falsely declared complete");
	assert.equal(gateDecision, undefined, "provider gate stays parked while the approved tool has not returned");
	assert.equal(runtime.toolResult(first.binding, first.scope, "approved-read", "read").ok, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.pause, "confirmed");
	assert.equal(gateDecision, undefined, "confirmed pause parks the same native activation instead of marking it idle");
	const second = runtime.takeNextActivation(prepared.teamId)!;
	assert.equal(second.binding.memberId, "w2", "the parked activation releases its sole worker permit");
	inputReady(runtime, second);
	runtime.hostControl(prepared.teamId).message_manager("resume w1 after w2 releases the permit");
	const resumeManager = runtime.takeNextActivation(prepared.teamId)!;
	inputReady(runtime, resumeManager);
	action(runtime, resumeManager, 1, "queue-resume-w1", { action: "control", command: "resume_member", memberId: "w1" });
	action(runtime, resumeManager, 2, "resume-yield", { action: "yield" });
	settle(runtime, resumeManager, "resume-yield");
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.pause, "requested",
		"resume waits rather than oversubscribing the single worker permit");
	assert.equal(gateDecision, undefined);
	const secondRef = workRef(second);
	reply(runtime, second, "w2-permit-release", "w2 done");
	assert.equal((await waitingAtProvider).allow, true, "the parked provider gate opens only after Runtime reserves a real permit");
	assert.equal(gateDecision, true);
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.pause, "none");
	const endCall = "w1-final-intent";
	assert.equal(runtime.gate(first.binding, first.scope, "tool_gate", endCall, "team", true).allow, true);
	assert.equal(runtime.toolResult(first.binding, first.scope, endCall, "team").ok, true);
	assert.equal(action(runtime, first, 1, endCall, { action: "reply", result: { status: "succeeded", summary: "completed after pause" } }, endCall).ok, true);
	settle(runtime, first, endCall);
	assert.equal(runtime.getWork(prepared.teamId, workRef(first))?.current.state, "resolved");
	assert.equal(runtime.getWork(prepared.teamId, secondRef)?.current.state, "resolved");
	runtime.assertInvariants(prepared.teamId);
});

test("C04: member resume does not clear a work hold; exact resume_work and HostControl release are idempotent", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const work = runtime.takeNextActivation(teamId)!;
	const ref = workRef(work);
	inputReady(runtime, work);
	const heldCall = "hold-for-attention";
	assert.equal(action(runtime, work, 1, heldCall, { action: "yield", attention: "verify local state", checkpoint: "inspect before retry" }).ok, true);
	settle(runtime, work, heldCall);
	const held = runtime.getWork(teamId, ref)!;
	assert.equal(held.current.state, "blocked");
	assert.equal(held.current.hold?.reason, "attention");
	const incidentId = held.current.hold!.incidentId;

	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	action(runtime, manager, 1, "pause-held-worker", { action: "control", command: "pause_member", memberId: "w1" });
	action(runtime, manager, 2, "resume-held-worker", { action: "control", command: "resume_member", memberId: "w1" });
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause, "none");
	assert.equal(runtime.getWork(teamId, ref)?.current.hold?.incidentId, incidentId, "member resume never releases a work hold");
	const instruction = "Retry after checking the local state.";
	assert.equal(action(runtime, manager, 3, "resume-held-work", { action: "control", command: "resume_work",
		workId: ref.workId, expectedRevision: ref.revision, incidentId, instruction }).ok, true);
	const hostRelease = runtime.hostControl(teamId).release_hold(ref, incidentId, instruction);
	assert.equal(hostRelease.actor, "@host");
	assert.equal(hostRelease.status, "unchanged", "host hold release is idempotent after the Manager already released this exact hold");
	action(runtime, manager, 4, "resume-hold-manager-yield", { action: "yield" });
	settle(runtime, manager, "resume-hold-manager-yield");
	const resumed = runtime.takeNextActivation(teamId)!;
	assert.equal(resumed.binding.memberId, "w1");
	assert.deepEqual(workRef(resumed), ref);
	assert.equal(resumed.input.scope.kind === "work" && resumed.input.scope.resumeInstruction, instruction);
	runtime.assertInvariants(teamId);
});

test("C04: member resume and hold-release APIs cannot bypass an exhausted budget hold", () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `budget-hold-${++ids}`, limits: { teamActivations: 1 } });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage work." },
		workers: [{ alias: "w1", roleDescription: "Perform assigned work." }],
		brief: { goal: "Verify budget holds cannot be released by resume controls." },
		initialRequests: [{ to: "w1", task: "budget-held root" }],
		timeoutSeconds: null,
	});
	runtime.launch(prepared.teamId);
	const manager = runtime.takeNextActivation(prepared.teamId)!;
	inputReady(runtime, manager);
	assert.equal(runtime.takeNextActivation(prepared.teamId), undefined, "the live Manager consumes the sole team activation slot before the root launches");
	const workStatus = action(runtime, manager, 1, "budget-held-work-status", { action: "status", view: "work" });
	const incidentStatus = action(runtime, manager, 2, "budget-held-incident-status", { action: "status", view: "incident" });
	assert.ok(workStatus.ok && workStatus.data && "view" in workStatus.data && workStatus.data.view === "work");
	assert.ok(incidentStatus.ok && incidentStatus.data && "view" in incidentStatus.data && incidentStatus.data.view === "incident");
	if (!workStatus.ok || !workStatus.data || !("view" in workStatus.data) || workStatus.data.view !== "work"
		|| !incidentStatus.ok || !incidentStatus.data || !("view" in incidentStatus.data) || incidentStatus.data.view !== "incident") {
		throw new Error("Expected work and incident status pages");
	}
	const held = workStatus.data.items[0];
	assert.ok(held && "work" in held && "hold" in held && held.hold === "budget");
	const heldIncidentId = runtime.getWork(prepared.teamId, held.work)?.current.hold?.incidentId;
	const incident = incidentStatus.data.items.find((item) => "id" in item && item.id === heldIncidentId);
	assert.ok(incident && "code" in incident && incident.code === "BUDGET_HIT", "the hold points at the Team-scope budget incident");
	action(runtime, manager, 3, "pause-budget-worker", { action: "control", command: "pause_member", memberId: "w1" });
	action(runtime, manager, 4, "resume-budget-worker", { action: "control", command: "resume_member", memberId: "w1" });
	assert.equal(runtime.getWork(prepared.teamId, held.work)?.current.hold?.reason, "budget");
	assert.equal(code(action(runtime, manager, 5, "resume-budget-work", {
		action: "control", command: "resume_work", workId: held.work.workId, expectedRevision: held.work.revision,
		incidentId: incident.id, instruction: "Retry despite the exhausted activation cap.",
	})), "BUDGET_BLOCKED");
	assert.throws(() => runtime.hostControl(prepared.teamId).release_hold(held.work, incident.id, "no implicit budget grant"),
		(error: unknown) => error instanceof TeamProtocolError && error.code === "BUDGET_BLOCKED");
	action(runtime, manager, 6, "budget-manager-yield", { action: "yield" });
	settle(runtime, manager, "budget-manager-yield");
	assert.equal(runtime.getWork(prepared.teamId, held.work)?.current.state, "blocked");
	assert.equal(runtime.getWork(prepared.teamId, held.work)?.current.hold?.reason, "budget");
	runtime.assertInvariants(prepared.teamId);
});

test("X02: a valid staged reply survives a concurrent pause and commits after cleanup", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const ref = workRef(worker);
	inputReady(runtime, worker);
	runtime.hostControl(teamId).message_manager("pause active w1");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	assert.equal(action(runtime, manager, 1, "pause-active-w1", { action: "control", command: "pause_member", memberId: "w1" }).ok, true);
	action(runtime, manager, 2, "pause-active-manager-yield", { action: "yield" });
	settle(runtime, manager, "pause-active-manager-yield");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause, "requested");
	assert.equal(runtime.gate(worker.binding, worker.scope, "tool_gate", "reply-while-paused", "team", true).allow, true,
		"the exact Team end-intent tool is not dropped by a pause gate");
	assert.equal(runtime.toolResult(worker.binding, worker.scope, "reply-while-paused", "team").ok, true);
	assert.equal(action(runtime, worker, 1, "reply-while-paused", {
		action: "reply", result: { status: "succeeded", summary: "committed despite the pause request" },
	}, "reply-while-paused").ok, true);
	settle(runtime, worker, "reply-while-paused");
	assert.equal(runtime.getWork(teamId, ref)?.current.state, "resolved");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause, "confirmed",
		"the pause takes effect after the legal reply commits and native cleanup completes");
	runtime.assertInvariants(teamId);
});

test("C10: a genuine native provider error outranks a simultaneous pause request", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const ref = workRef(worker);
	inputReady(runtime, worker);
	runtime.hostControl(teamId).message_manager("pause w1 while provider settles");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	action(runtime, manager, 1, "pause-before-provider-error", { action: "control", command: "pause_member", memberId: "w1" });
	action(runtime, manager, 2, "manager-yield-before-provider-error", { action: "yield" });
	settle(runtime, manager, "manager-yield-before-provider-error");
	assert.equal(runtime.nativeSettled(worker.binding, worker.scope.activationId, {
		status: "error", error: { code: "UPSTREAM_FAILURE", message: "synthetic provider error" },
	}).ok, true);
	assert.equal(runtime.activationCompletionReason(worker.binding, worker.scope.activationId), "native_failure");
	assert.equal(runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true }).ok, true);
	assert.equal(runtime.getWork(teamId, ref)?.current.state, "failed");
	assert.equal(runtime.getWork(teamId, ref)?.current.error?.message, "synthetic provider error");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.lifecycle, "faulted");
	runtime.assertInvariants(teamId);
});

test("C05/C06: superseded reply evidence waits for cleanup, committed results survive revision, and stale revisions never apply", () => {
	const { runtime, teamId } = makeRuntime([
		{ to: "w1", task: "revision one" },
		{ to: "w2", task: "wait for revision one" },
	]);
	finishManagerBoot(runtime, teamId);
	const old = runtime.takeNextActivation(teamId)!;
	const ref = workRef(old);
	const consumer = runtime.takeNextActivation(teamId)!;
	const consumerRef = workRef(consumer);
	inputReady(runtime, consumer);
	action(runtime, consumer, 1, "wait-old-revision", { action: "yield", waitingFor: [ref], checkpoint: "waiting for exact v1" });
	settle(runtime, consumer, "wait-old-revision");
	inputReady(runtime, old);
	assert.equal(action(runtime, old, 1, "old-staged-reply", {
		action: "reply", result: { status: "succeeded", summary: "candidate from v1" },
	}, "old-staged-reply").ok, true);
	runtime.hostControl(teamId).message_manager("revise the active v1");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const revision = action(runtime, manager, 1, "revise-active-v1", {
		action: "control", command: "revise_work", workId: ref.workId, expectedRevision: 1,
		task: "revision two", inputRefs: [],
	});
	assert.equal(revision.ok && revision.receipt?.status, "applied");
	assert.equal(runtime.getWork(teamId, consumerRef)?.current.state, "blocked",
		"a superseded terminal outcome stays unavailable to dependents until native cleanup");
	action(runtime, manager, 2, "revise-manager-yield", { action: "yield" });
	settle(runtime, manager, "revise-manager-yield");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "the old writer fence prevents v2 and the dependent from starting");
	const oldNative = runtime.nativeSettled(old.binding, old.scope.activationId, { status: "success", appliedToolCallId: "old-staged-reply" });
	assert.equal(oldNative.ok, true);
	assert.equal(runtime.cleanupFinished(old.binding, old.scope.activationId, { ok: true }).ok, true);
	const oldView = runtime.getWork(teamId, ref)!;
	assert.equal(oldView.current.state, "superseded");
	assert.equal(oldView.current.resultRef, undefined);
	assert.deepEqual(oldView.rejectedCandidates?.map(({ revision, reason, summary }) => ({ revision, reason, summary })), [
		{ revision: 1, reason: "policy_superseded", summary: "candidate from v1" },
	]);
	const revisionTwo = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(revisionTwo), { workId: ref.workId, revision: 2 });
	inputReady(runtime, revisionTwo);
	reply(runtime, revisionTwo, "reply-v2", "v2 committed");
	const v2ResultManager = runtime.takeNextActivation(teamId)!;
	assert.equal(v2ResultManager.scope.kind, "management");
	inputReady(runtime, v2ResultManager);
	action(runtime, v2ResultManager, 1, "v2-result-idle", { action: "yield" });
	settle(runtime, v2ResultManager, "v2-result-idle");
	const resumedConsumer = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(resumedConsumer), consumerRef);
	assert.equal(resumedConsumer.input.outcomes[0]?.state, "superseded");
	inputReady(runtime, resumedConsumer);
	reply(runtime, resumedConsumer, "reply-consumer", "observed superseded v1");
	const refTwo = { workId: ref.workId, revision: 2 };
	const v2ResultRef = runtime.getWork(teamId, refTwo)?.current.resultRef;
	assert.ok(v2ResultRef);
	const reviewManager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, reviewManager);
	assert.equal(action(runtime, reviewManager, 1, "revise-after-commit", {
		action: "control", command: "revise_work", workId: ref.workId, expectedRevision: 2,
		task: "revision three", inputRefs: [],
	}).ok, true);
	action(runtime, reviewManager, 2, "revise-after-commit-yield", { action: "yield" });
	settle(runtime, reviewManager, "revise-after-commit-yield");
	const revised = runtime.getWork(teamId, { workId: ref.workId, revision: 2 })!;
	assert.equal(revised.currentRevision, 3);
	assert.equal(revised.revisions[1]?.state, "resolved");
	assert.equal(revised.revisions[1]?.resultRef, v2ResultRef, "a later revision does not erase committed prior evidence");
	runtime.hostControl(teamId).message_manager("probe stale revision protection");
	const staleManager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, staleManager);
	assert.equal(code(action(runtime, staleManager, 1, "stale-v2-revision", {
		action: "control", command: "revise_work", workId: ref.workId, expectedRevision: 2,
		task: "must not replace v3", inputRefs: [],
	})), "STALE_REVISION");
	assert.equal(runtime.getWork(teamId, { workId: ref.workId, revision: 3 })?.current.task, "revision three");
	action(runtime, staleManager, 2, "stale-manager-yield", { action: "yield" });
	settle(runtime, staleManager, "stale-manager-yield");
	runtime.assertInvariants(teamId);
});

test("C07/C08/C10: cancel only the selected subtree, keep same-member roots, and delay dependency outcomes until cleanup", () => {
	const { runtime, teamId } = makeRuntime([
		{ to: "w1", task: "cancel this root" },
		{ to: "w1", task: "keep this unrelated root" },
		{ to: "w2", task: "wait for the canceled root" },
	]);
	finishManagerBoot(runtime, teamId);
	const target = runtime.takeNextActivation(teamId)!;
	const targetRef = workRef(target);
	const consumer = runtime.takeNextActivation(teamId)!;
	const consumerRef = workRef(consumer);
	inputReady(runtime, consumer);
	action(runtime, consumer, 1, "wait-for-cancelled-root", {
		action: "yield", waitingFor: [targetRef], checkpoint: "wait for target cleanup and outcome",
	});
	settle(runtime, consumer, "wait-for-cancelled-root");
	inputReady(runtime, target);
	const childRequest = action(runtime, target, 1, "child-of-cancelled-root", { action: "request", to: "w2", task: "cancel with parent" });
	assert.equal(childRequest.ok && childRequest.receipt?.status, "accepted");
	const childRef = childRequest.ok && childRequest.receipt?.status === "accepted" ? childRequest.receipt.work : undefined;
	assert.ok(childRef);
	runtime.hostControl(teamId).message_manager("cancel only the selected root subtree");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const cancel = { action: "control", command: "cancel_work", workId: targetRef.workId, expectedRevision: 1, reason: "obsolete request" };
	assert.equal(action(runtime, manager, 1, "cancel-target", cancel).ok, true);
	const repeatedCancel = action(runtime, manager, 2, "cancel-target-again", cancel);
	assert.equal(repeatedCancel.ok && repeatedCancel.receipt?.status, "unchanged");
	action(runtime, manager, 3, "cancel-manager-yield", { action: "yield" });
	settle(runtime, manager, "cancel-manager-yield");
	assert.equal(runtime.getWork(teamId, targetRef)?.current.state, "cancelled");
	assert.equal(runtime.getWork(teamId, childRef)?.current.state, "cancelled");
	assert.equal(runtime.getWork(teamId, consumerRef)?.current.state, "blocked",
		"logical cancellation is not deliverable while the target's native cleanup is pending");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "neither the same-member root nor its dependent bypasses the active writer/outcome fence");

	assert.equal(runtime.nativeSettled(target.binding, target.scope.activationId, { status: "success" }).ok, true);
	assert.equal(runtime.cleanupFinished(target.binding, target.scope.activationId, { ok: true }).ok, true);
	const unrelated = runtime.takeNextActivation(teamId)!;
	assert.equal(unrelated.binding.memberId, "w1");
	assert.equal(unrelated.input.scope.kind === "work" && unrelated.input.scope.task, "keep this unrelated root");
	const releasedConsumer = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(releasedConsumer), consumerRef);
	assert.ok(releasedConsumer.input.outcomes.some((outcome) => outcome.work.workId === targetRef.workId
		&& outcome.work.revision === targetRef.revision && outcome.state === "cancelled"),
	"the dependent receives the cancelled outcome only after target cleanup is confirmed");
	runtime.assertInvariants(teamId);
});

test("C09: pre-settlement worker transport loss isolates only that member and preserves unrelated queued work", () => {
	const { runtime, teamId } = makeRuntime([
		{ to: "w1", task: "transport-lost root" },
		{ to: "w2", task: "unrelated queued root" },
	]);
	finishManagerBoot(runtime, teamId);
	const activation = runtime.takeNextActivation(teamId)!;
	assert.equal(activation.binding.memberId, "w1");
	const ref = workRef(activation);
	const lost = runtime.activationLost(activation.binding, activation.scope.activationId, {
		code: "NATIVE_OUTCOME_UNKNOWN", message: "transport stopped before agent_settled", outcomeUnknown: true,
	}, false);
	assert.equal(lost.ok, true);
	const team = runtime.getTeam(teamId);
	const worker = team.members.find((member) => member.id === "w1")!;
	assert.equal(worker.lifecycle, "faulted");
	assert.equal(worker.activity, "idle");
	assert.equal(worker.resourceState, "cleanup_failed");
	assert.equal(worker.currentWork, undefined);
	assert.equal(team.members.find((member) => member.id === "w2")?.lifecycle, "open");
	assert.equal(team.members.find((member) => member.id === "w2")?.queued, 1);
	assert.equal(runtime.getWork(teamId, ref)?.current.state, "failed");
	assert.equal(runtime.getWork(teamId, ref)?.current.error?.outcomeUnknown, true);
	assert.equal(runtime.gate(activation.binding, activation.scope, "tool_gate").allow, false);
	runtime.assertInvariants(teamId);
	const next = runtime.takeNextActivation(teamId);
	assert.equal(next?.scope.kind, "management", "the manager can observe the incident; the failed worker is not stuck holding a permit");
	inputReady(runtime, next!);
	action(runtime, next!, 1, "fault-notice-yield", { action: "yield" });
	settle(runtime, next!, "fault-notice-yield");
	const unrelated = runtime.takeNextActivation(teamId)!;
	assert.equal(unrelated.binding.memberId, "w2");
	assert.equal(unrelated.input.scope.kind === "work" && unrelated.input.scope.task, "unrelated queued root");
	runtime.assertInvariants(teamId);
});

test("P: exhausted result slots reject request admission without ledger or budget side effects", () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `slot-${++ids}`, limits: { reservedResultBytes: TEAM_MAX_RESULT_BYTES } });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "One reserved result slot." }, timeoutSeconds: null,
	});
	runtime.launch(prepared.teamId);
	const manager = runtime.takeNextActivation(prepared.teamId)!;
	inputReady(runtime, manager);
	const accepted = action(runtime, manager, 1, "slot-request-1", { action: "request", to: "w1", task: "fits the sole slot" });
	assert.equal(accepted.ok, true);
	const ref = accepted.ok && accepted.receipt?.status === "accepted" ? accepted.receipt.work : undefined;
	assert.ok(ref);
	const before = businessSnapshot(runtime, prepared.teamId, [ref]);
	assert.equal(before.team.budget.used.reservedResultBytes, TEAM_MAX_RESULT_BYTES);
	const full = action(runtime, manager, 2, "slot-request-2", { action: "request", to: "w1", task: "must not be admitted" });
	assert.equal(code(full), "TEAM_CAPACITY");
	assert.deepEqual(businessSnapshot(runtime, prepared.teamId, [ref]), before, "capacity rejection leaves ledger, result slots and state version unchanged");
	runtime.assertInvariants(prepared.teamId);
});

test("P: revise_work capacity rejection preserves the current writer, revision and reserved slots", () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `rev-slot-${++ids}`, limits: { reservedResultBytes: TEAM_MAX_RESULT_BYTES } });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "One result slot only." }, initialRequests: [{ to: "w1", task: "current task" }], timeoutSeconds: null,
	});
	runtime.launch(prepared.teamId);
	const manager = runtime.takeNextActivation(prepared.teamId)!;
	inputReady(runtime, manager);
	const worker = runtime.takeNextActivation(prepared.teamId)!;
	const ref = workRef(worker);
	inputReady(runtime, worker);
	const before = businessSnapshot(runtime, prepared.teamId, [ref]);
	assert.equal(before.team.budget.used.reservedResultBytes, TEAM_MAX_RESULT_BYTES);
	assert.equal(code(action(runtime, manager, 1, "revise-without-slot", {
		action: "control", command: "revise_work", workId: ref.workId, expectedRevision: ref.revision, task: "must not reserve revision two",
	})), "TEAM_CAPACITY");
	assert.deepEqual(businessSnapshot(runtime, prepared.teamId, [ref]), before, "rejected revision leaves active WorkRef and slot accounting unchanged");
	runtime.assertInvariants(prepared.teamId);
});

test("P: native tool-call IDs remain opaque and exact across private preflight/result frames", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const activation = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, activation);
	const nativeId = "call|ws/1+opaque=value";
	const gateFrame = parseChildFrame({ version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
		sequence: 1, rpcRequestId: "native-gate-request", request: { action: "tool_gate", toolCallId: nativeId, toolName: "bash", endIntent: false } });
	assert.equal(gateFrame.kind, "request");
	if (gateFrame.kind === "request") {
		assert.equal(gateFrame.request.action, "tool_gate");
		if (gateFrame.request.action === "tool_gate") assert.equal(gateFrame.request.toolCallId, nativeId);
	}
	assert.equal(runtime.gate(activation.binding, activation.scope, "tool_gate", nativeId, "bash").allow, true);
	const resultFrame = parseChildFrame({ version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
		sequence: 2, rpcRequestId: "native-result-request", request: { action: "tool_result", toolCallId: nativeId, toolName: "bash" } });
	assert.equal(resultFrame.kind, "request");
	if (resultFrame.kind === "request") {
		assert.equal(resultFrame.request.action, "tool_result");
		if (resultFrame.request.action === "tool_result") assert.equal(resultFrame.request.toolCallId, nativeId);
	}
	assert.equal(runtime.toolResult(activation.binding, activation.scope, nativeId, "bash").ok, true);
	assert.throws(() => parseChildFrame({ version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
		sequence: 3, rpcRequestId: "invalid-native-id", request: { action: "tool_gate", toolCallId: "bad\u0000id", toolName: "bash", endIntent: false } }), TeamProtocolError);
	runtime.assertInvariants(teamId);
});

test("P: private activate codec validates binding, delivery, nested fields and typed public replies", () => {
	const { runtime, teamId } = makeRuntime([]);
	const activation = runtime.takeNextActivation(teamId)!;
	const command = {
		version: 2, commandId: "cmd-activate", operation: "activate", binding: activation.binding,
		activation: activation.scope, deliveryId: activation.deliveryId, input: activation.input,
	};
	const parsed = parseParentCommand(command);
	assert.equal(parsed.operation, "activate");
	if (parsed.operation === "activate") assert.equal(parsed.input.deliveryId, activation.deliveryId);
	const unknownNested = structuredClone(command);
	(unknownNested.input.scope as Record<string, unknown>)["untrusted"] = true;
	assert.throws(() => parseParentCommand(unknownNested), TeamProtocolError);
	const unknownMember = structuredClone(command);
	(unknownMember.input.member as Record<string, unknown>)["privateEpoch"] = "not-public";
	assert.throws(() => parseParentCommand(unknownMember), TeamProtocolError);
	const unknownRoster = structuredClone(command);
	(unknownRoster.input.roster[0] as Record<string, unknown>)["extra"] = true;
	assert.throws(() => parseParentCommand(unknownRoster), TeamProtocolError);
	const unknownOutcome = structuredClone(command);
	unknownOutcome.input.outcomes.push({ work: { workId: "work-ref", revision: 1 }, state: "failed" });
	(unknownOutcome.input.outcomes[0] as unknown as Record<string, unknown>)["extra"] = true;
	assert.throws(() => parseParentCommand(unknownOutcome), TeamProtocolError);
	assert.throws(() => parseParentCommand({ ...command, binding: { ...activation.binding, epoch: "other", extra: true } }), TeamProtocolError);
	assert.throws(() => encodeActivationInput({ ...activation.input, notice: "x".repeat(TEAM_MAX_ACTIVATION_INPUT_BYTES) }),
		(error) => error instanceof TeamProtocolError && error.code === "INPUT_BUDGET_EXCEEDED");
	const oversizedFrame = structuredClone(command);
	oversizedFrame.input.notice = "x".repeat(TEAM_MAX_FRAME_BYTES);
	assert.throws(() => parseParentCommand(oversizedFrame),
		(error) => error instanceof TeamProtocolError && error.code === "PROTOCOL_FAILURE");
	assert.throws(() => parseChildFrame({ version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
		sequence: 1, rpcRequestId: "oversized-child", request: { action: "business", args: { padding: "x".repeat(TEAM_MAX_FRAME_BYTES) } } }),
	(error) => error instanceof TeamProtocolError && error.code === "PROTOCOL_FAILURE");
	assert.throws(() => parseChildFrame({ version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
		sequence: 1, rpcRequestId: "private-request", request: { action: "input_ready", deliveryId: activation.deliveryId, extra: true } }), TeamProtocolError);
	assert.throws(() => parseTeamReply({ ok: true, from: "@hub", to: "lead", data: { privateEpoch: "do-not-project" } }), TeamProtocolError);
	assert.throws(() => parseTeamReply({ ok: false, from: "@hub", to: "lead", error: { code: "INVENTED", message: "bad" } }), TeamProtocolError);
	inputReady(runtime, activation);
	const accepted = action(runtime, activation, 1, "typed-reply-request", { action: "request", to: "w1", task: "codec result" });
	assert.deepEqual(parseTeamReply(accepted), accepted);
	const status = action(runtime, activation, 2, "typed-status", { action: "status", view: "team" });
	assert.equal(status.ok, true);
	assert.deepEqual(parseTeamReply(status), status);
	const work = accepted.ok && accepted.receipt?.status === "accepted" ? accepted.receipt.work : undefined;
	assert.ok(work);
	const worker = runtime.takeNextActivation(teamId)!;
	assert.equal(worker.binding.memberId, "w1");
	inputReady(runtime, worker);
	const summary = action(runtime, worker, 1, "other-work-summary", { action: "status", view: "work", id: work.workId });
	assert.equal(summary.ok, true);
	assert.deepEqual(parseTeamReply(summary), summary);
	if (summary.ok && summary.data && "view" in summary.data) {
		assert.equal(summary.data.view, "work");
		if (summary.data.view === "work") assert.equal("current" in summary.data.items[0]!, false);
	}
});

test("P: explicit deadline starts at launch admission, while prepare time is unbounded", () => {
	let now = 1_000;
	let ids = 0;
	const runtime = new TeamRuntime({ now: () => now, createId: () => `deadline-${++ids}` });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "Test deadline admission." }, timeoutSeconds: 12.5,
	});
	assert.equal(prepared.timeoutSeconds, 12.5);
	assert.equal(prepared.deadline, null, "prepare delay does not consume the Team deadline");
	now = 8_000;
	const active = runtime.launch(prepared.teamId);
	assert.equal(active.deadline, 20_500);
	assert.equal(active.timeoutSeconds, 12.5);
});

test("W: a yielded parent releases its member for a dependent return trip and observes each outcome once", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);

	const first = runtime.takeNextActivation(teamId)!;
	const firstRef = workRef(first);
	assert.equal(first.binding.memberId, "w1");
	inputReady(runtime, first);
	const childRequest = action(runtime, first, 1, "create-w2-work", { action: "request", to: "w2", task: "resolve a dependency" });
	assert.equal(childRequest.ok, true);
	assert.equal(childRequest.ok && childRequest.receipt?.status, "accepted");
	const childRef = childRequest.ok && childRequest.receipt?.status === "accepted" ? childRequest.receipt.work : undefined;
	assert.ok(childRef);
	const waitFirst = action(runtime, first, 2, "yield-first", { action: "yield", waitingFor: [childRef], checkpoint: "Waiting for w2." });
	assert.equal(waitFirst.ok, true);
	settle(runtime, first, "yield-first");
	assert.equal(runtime.getWork(teamId, firstRef)?.current.state, "blocked");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.lifecycle, "open");

	const second = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(second), childRef);
	assert.equal(second.binding.memberId, "w2");
	inputReady(runtime, second);
	const returnRequest = action(runtime, second, 1, "create-w1-return", { action: "request", to: "w1", task: "provide the peer fact" });
	assert.equal(returnRequest.ok, true);
	const returnRef = returnRequest.ok && returnRequest.receipt?.status === "accepted" ? returnRequest.receipt.work : undefined;
	assert.ok(returnRef);
	const waitSecond = action(runtime, second, 2, "yield-second", { action: "yield", waitingFor: [returnRef], checkpoint: "Waiting for w1." });
	assert.equal(waitSecond.ok, true);
	settle(runtime, second, "yield-second");

	const third = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(third), returnRef);
	assert.equal(third.binding.memberId, "w1");
	assert.equal(third.binding.epoch, first.binding.epoch, "idle/yield does not create a new member lifetime");
	reply(runtime, third, "reply-return", "Peer fact is verified.");

	const secondAgain = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(secondAgain), childRef);
	assert.equal(secondAgain.binding.epoch, second.binding.epoch);
	assert.deepEqual(secondAgain.input.outcomes.map((outcome) => outcome.work), [returnRef]);
	inputReady(runtime, secondAgain);
	assert.deepEqual(runtime.getWork(teamId, childRef)?.current.waitingFor, [], "input_ready confirms the exact dependency outcome");
	reply(runtime, secondAgain, "reply-second", "Dependency resolved.");

	const firstAgain = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(firstAgain), firstRef);
	assert.equal(firstAgain.binding.epoch, first.binding.epoch);
	assert.deepEqual(firstAgain.input.outcomes.map((outcome) => outcome.work), [childRef]);
	inputReady(runtime, firstAgain);
	reply(runtime, firstAgain, "reply-first", "Root completed from the observed dependency.");
	assert.equal(runtime.getWork(teamId, firstRef)?.current.state, "resolved");
	assert.equal(runtime.getWork(teamId, childRef)?.current.state, "resolved");
	assert.equal(runtime.getWork(teamId, returnRef!)?.current.state, "resolved");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.activity, "idle");
	runtime.assertInvariants(teamId);
});

test("W: an outcome that arrives before yield is not lost and produces one ready activation", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const parent = runtime.takeNextActivation(teamId)!;
	const parentRef = workRef(parent);
	inputReady(runtime, parent);
	const requested = action(runtime, parent, 1, "create-child", { action: "request", to: "w2", task: "early outcome" });
	assert.equal(requested.ok, true);
	const childRef = requested.ok && requested.receipt?.status === "accepted" ? requested.receipt.work : undefined;
	assert.ok(childRef);
	const child = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(child), childRef);
	reply(runtime, child, "child-result", "Arrived before parent yield.");
	const yielded = action(runtime, parent, 2, "late-yield", { action: "yield", waitingFor: [childRef], checkpoint: "Collecting the already-finished result." });
	assert.equal(yielded.ok, true);
	settle(runtime, parent, "late-yield");
	const resumed = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(resumed), parentRef);
	assert.equal(resumed.input.outcomes.length, 1);
	assert.deepEqual(resumed.input.outcomes[0]?.work, childRef);
	inputReady(runtime, resumed);
	assert.equal(runtime.takeNextActivation(teamId), undefined, "one dependency outcome creates only one ready item");
	runtime.assertInvariants(teamId);
});

test("W: cycle detection includes parent completion edges and rejects without reserving a wait", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const parent = runtime.takeNextActivation(teamId)!;
	const parentRef = workRef(parent);
	inputReady(runtime, parent);
	const requested = action(runtime, parent, 1, "create-cycle-child", { action: "request", to: "w2", task: "child" });
	assert.equal(requested.ok, true);
	const childRef = requested.ok && requested.receipt?.status === "accepted" ? requested.receipt.work : undefined;
	assert.ok(childRef);
	assert.equal(action(runtime, parent, 2, "wait-parent", { action: "yield", waitingFor: [childRef], checkpoint: "Wait for child." }).ok, true);
	settle(runtime, parent, "wait-parent");
	const child = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, child);
	const beforeCycle = businessSnapshot(runtime, teamId, [parentRef, childRef]);
	const cycle = action(runtime, child, 1, "cycle-attempt", { action: "yield", waitingFor: [parentRef], checkpoint: "This would close a cycle." });
	assert.equal(code(cycle), "DEPENDENCY_CYCLE");
	assert.deepEqual(businessSnapshot(runtime, teamId, [parentRef, childRef]), beforeCycle, "cycle rejection leaves both work records and dependency edges unchanged");
	const staged = action(runtime, child, 2, "child-reply", { action: "reply", result: { status: "succeeded", summary: "No cycle was committed." } });
	assert.equal(staged.ok, true);
	settle(runtime, child, "child-reply");
	runtime.assertInvariants(teamId);
});

test("W: revision fences an active old WorkRef until native cleanup, then reuses the same member lifetime", () => {
	const { runtime, teamId } = makeRuntime();
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const oldActivation = runtime.takeNextActivation(teamId)!;
	const oldRef = workRef(oldActivation);
	inputReady(runtime, oldActivation);
	const revised = action(runtime, manager, 1, "revise-active", {
		action: "control", command: "revise_work", workId: oldRef.workId, expectedRevision: 1, task: "revised root task",
	});
	assert.equal(revised.ok, true);
	assert.equal(runtime.getWork(teamId, oldRef)?.current.state, "superseded");
	const currentRef = { workId: oldRef.workId, revision: 2 };
	const beforeStaleYield = businessSnapshot(runtime, teamId, [oldRef, currentRef]);
	assert.equal(code(action(runtime, oldActivation, 1, "stale-old-yield", {
		action: "yield", waitingFor: [oldRef], checkpoint: "Stale direction must not stage.",
	})), "STALE_REVISION");
	assert.deepEqual(businessSnapshot(runtime, teamId, [oldRef, currentRef]), beforeStaleYield, "stale WorkRef cannot stage a yield or mutate ledger state");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "revision 2 cannot overlap the old native writer");
	runtime.nativeSettled(oldActivation.binding, oldActivation.scope.activationId, { status: "aborted" });
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.activity, "settling");
	runtime.cleanupFinished(oldActivation.binding, oldActivation.scope.activationId, { ok: true });
	const next = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(next), { workId: oldRef.workId, revision: 2 });
	assert.equal(next.binding.epoch, oldActivation.binding.epoch);
	assert.equal(next.input.scope.kind, "work");
	if (next.input.scope.kind === "work") assert.equal(next.input.scope.previous?.state, "superseded");
	const beforeStaleRevision = businessSnapshot(runtime, teamId, [oldRef, currentRef]);
	assert.equal(code(action(runtime, manager, 2, "stale-revise", {
		action: "control", command: "revise_work", workId: oldRef.workId, expectedRevision: 1, task: "stale write",
	})), "STALE_REVISION");
	assert.deepEqual(businessSnapshot(runtime, teamId, [oldRef, currentRef]), beforeStaleRevision, "rejected revision leaves the authoritative work and results unchanged");
	reply(runtime, next, "revision-2-reply", "Only revision 2 may commit.");
	assert.equal(runtime.getWork(teamId, oldRef)?.current.state, "superseded");
	assert.equal(runtime.getWork(teamId, { workId: oldRef.workId, revision: 2 })?.current.state, "resolved");
	runtime.assertInvariants(teamId);
});

test("W: revising a resolved root preserves its committed result and old review", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const oldRef = workRef(worker);
	reply(runtime, worker, "resolved-before-revise", "Committed output remains historical evidence.");
	const oldResultRef = runtime.getWork(teamId, oldRef)?.current.resultRef;
	assert.ok(oldResultRef);
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	assert.equal(action(runtime, manager, 1, "accept-before-revise", {
		action: "control", command: "accept_result", work: oldRef, disposition: "accepted",
	}).ok, true);
	const revised = action(runtime, manager, 2, "revise-resolved-root", {
		action: "control", command: "revise_work", workId: oldRef.workId, expectedRevision: oldRef.revision, task: "New current root revision.",
	});
	assert.equal(revised.ok, true);
	const oldVersion = runtime.getWork(teamId, oldRef)?.current;
	assert.equal(oldVersion?.state, "resolved");
	assert.equal(oldVersion?.resultRef, oldResultRef);
	assert.equal(oldVersion?.review?.disposition, "accepted");
	assert.equal(runtime.getResult(teamId, oldResultRef)?.result.summary, "Committed output remains historical evidence.");
	assert.equal(runtime.getWork(teamId, { workId: oldRef.workId, revision: 2 })?.current.state, "queued");
	assert.equal(runtime.getWork(teamId, { workId: oldRef.workId, revision: 2 })?.current.review, undefined);
	runtime.assertInvariants(teamId);
});

test("W: cancelled dependency is not deliverable until the old activation cleanup is confirmed", () => {
	const { runtime, teamId } = makeRuntime();
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const parent = runtime.takeNextActivation(teamId)!;
	const parentRef = workRef(parent);
	inputReady(runtime, parent);
	const childRequest = action(runtime, parent, 1, "create-cancelled-child", { action: "request", to: "w2", task: "cancel me" });
	assert.equal(childRequest.ok, true);
	const childRef = childRequest.ok && childRequest.receipt?.status === "accepted" ? childRequest.receipt.work : undefined;
	assert.ok(childRef);
	assert.equal(action(runtime, parent, 2, "wait-cancelled-child", { action: "yield", waitingFor: [childRef], checkpoint: "Wait for cleanup." }).ok, true);
	settle(runtime, parent, "wait-cancelled-child");
	const child = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(child), childRef);
	inputReady(runtime, child);
	assert.equal(action(runtime, manager, 1, "cancel-child", {
		action: "control", command: "cancel_work", workId: childRef.workId, expectedRevision: childRef.revision, reason: "Manager cancelled the obsolete child.",
	}).ok, true);
	assert.equal(runtime.getWork(teamId, childRef)?.current.state, "cancelled");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "dependent parent remains blocked while native cleanup is unknown");
	runtime.nativeSettled(child.binding, child.scope.activationId, { status: "aborted" });
	runtime.cleanupFinished(child.binding, child.scope.activationId, { ok: true });
	const resumed = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(resumed), parentRef);
	assert.equal(resumed.input.outcomes[0]?.state, "cancelled");
	inputReady(runtime, resumed);
	reply(runtime, resumed, "parent-handles-cancelled-child", "The dependency was cancelled and handled.");
	runtime.assertInvariants(teamId);
});

test("W: reply refuses a logically cancelled child while its native cleanup is pending", () => {
	const { runtime, teamId } = makeRuntime();
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const parent = runtime.takeNextActivation(teamId)!;
	const parentRef = workRef(parent);
	inputReady(runtime, parent);
	const request = action(runtime, parent, 1, "cleanup-child-request", { action: "request", to: "w2", task: "child with pending cleanup" });
	assert.equal(request.ok, true);
	const childRef = request.ok && request.receipt?.status === "accepted" ? request.receipt.work : undefined;
	assert.ok(childRef);
	const child = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, child);
	assert.equal(action(runtime, manager, 1, "cancel-child-before-reply", {
		action: "control", command: "cancel_work", workId: childRef.workId, expectedRevision: childRef.revision, reason: "Stop the child.",
	}).ok, true);
	assert.equal(runtime.getWork(teamId, childRef)?.current.state, "cancelled");
	const beforeReply = businessSnapshot(runtime, teamId, [parentRef, childRef]);
	const premature = action(runtime, parent, 2, "reply-during-child-cleanup", {
		action: "reply", result: { status: "succeeded", summary: "Must not commit before child cleanup." },
	});
	assert.equal(code(premature), "UNRESOLVED_CHILDREN");
	assert.deepEqual(businessSnapshot(runtime, teamId, [parentRef, childRef]), beforeReply, "cleanup blocker does not stage or commit the parent reply");
	runtime.nativeSettled(child.binding, child.scope.activationId, { status: "aborted" });
	runtime.cleanupFinished(child.binding, child.scope.activationId, { ok: true });
	assert.equal(action(runtime, parent, 3, "yield-after-child-cleanup", {
		action: "yield", waitingFor: [childRef], checkpoint: "Observe the cancelled child outcome.",
	}).ok, true);
	settle(runtime, parent, "yield-after-child-cleanup");
	const resumed = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(workRef(resumed), parentRef);
	assert.deepEqual(resumed.input.outcomes.map((outcome) => outcome.work), [childRef]);
	runtime.assertInvariants(teamId);
});

test("W: native failure faults a worker and terminalizes its other assigned work", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "first" }, { to: "w1", task: "second" }]);
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const ref = workRef(worker);
	assert.equal(worker.binding.memberId, "w1");
	inputReady(runtime, worker);
	runtime.nativeSettled(worker.binding, worker.scope.activationId, {
		status: "error", error: { code: "NATIVE_FAILURE", message: "synthetic provider failed" },
	});
	runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true });
	const team = runtime.getTeam(teamId);
	assert.equal(team.members.find((member) => member.id === "w1")?.lifecycle, "faulted");
	assert.equal(team.works.failed, 2, "unstarted work assigned to a faulted worker is failed, not left runnable");
	const manager = runtime.takeNextActivation(teamId)!;
	assert.equal(manager.scope.kind, "management");
	inputReady(runtime, manager);
	const before = businessSnapshot(runtime, teamId, [ref]);
	assert.equal(code(action(runtime, manager, 1, "revise-faulted-assignee", {
		action: "control", command: "revise_work", workId: ref.workId, expectedRevision: ref.revision, task: "unrunnable revision",
	})), "RECIPIENT_CLOSED");
	assert.deepEqual(businessSnapshot(runtime, teamId, [ref]), before, "revision cannot create new obligations for a faulted member");
	runtime.assertInvariants(teamId);
});

test("W: revision rejects a closed assignee without changing work, results or member state", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const ref = workRef(worker);
	reply(runtime, worker, "close-before-revise", "Result is committed before member close.");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const closed = action(runtime, manager, 1, "close-worker-before-revise", { action: "control", command: "close_member", memberId: "w1" });
	assert.equal(closed.ok && closed.receipt?.status, "closing");
	const closeId = closed.ok && closed.receipt?.status === "closing" ? closed.receipt.closeId : undefined;
	assert.ok(closeId);
	assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, "w1"), closeId, { ok: true }).ok, true);
	const before = businessSnapshot(runtime, teamId, [ref]);
	assert.equal(code(action(runtime, manager, 2, "revise-closed-assignee", {
		action: "control", command: "revise_work", workId: ref.workId, expectedRevision: ref.revision, task: "must not be queued to closed worker",
	})), "RECIPIENT_CLOSED");
	assert.deepEqual(businessSnapshot(runtime, teamId, [ref]), before, "revision cannot create work for a released member");
	runtime.assertInvariants(teamId);
});

test("L: close blockers never expose private activation or delivery IDs", () => {
	const { runtime, teamId } = makeRuntime();
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const worker = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, worker);
	const memberClose = action(runtime, manager, 1, "close-active-member", { action: "control", command: "close_member", memberId: "w1" });
	assert.equal(code(memberClose), "CLOSE_BLOCKED");
	assert.ok(!JSON.stringify(memberClose).includes(worker.scope.activationId));
	assert.ok(!JSON.stringify(memberClose).includes(worker.deliveryId));
	assert.deepEqual(parseTeamReply(memberClose), memberClose);
	const teamClose = action(runtime, manager, 2, "close-active-team", {
		action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "Work is still active.",
	});
	assert.equal(code(teamClose), "CLOSE_BLOCKED");
	assert.ok(!JSON.stringify(teamClose).includes(worker.scope.activationId));
	assert.ok(!JSON.stringify(teamClose).includes(worker.deliveryId));
	assert.deepEqual(parseTeamReply(teamClose), teamClose);
	runtime.assertInvariants(teamId);
});

test("L: close_team refuses faulted worker resources that were never released", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const ref = workRef(worker);
	inputReady(runtime, worker);
	runtime.nativeSettled(worker.binding, worker.scope.activationId, { status: "error", error: { code: "NATIVE_FAILURE", message: "worker fault" } });
	runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true });
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	assert.equal(action(runtime, manager, 1, "waive-failed-root", {
		action: "control", command: "accept_result", work: ref, disposition: "waived", reason: "Worker failed.",
	}).ok, true);
	const beforeClose = businessSnapshot(runtime, teamId, [ref]);
	const close = action(runtime, manager, 2, "close-with-unreleased-fault", {
		action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "Worker resources remain owned.",
	});
	assert.equal(code(close), "CLOSE_BLOCKED");
	assert.deepEqual(businessSnapshot(runtime, teamId, [ref]), beforeClose, "rejected close does not commit a decision or mutate lifecycle");
	assert.equal(runtime.getTeam(teamId).lifecycle, "active");
	runtime.assertInvariants(teamId);
});

test("L: close_team cannot absorb a worker already closing but not yet released", () => {
	const { runtime, teamId } = makeRuntime([]);
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const closing = action(runtime, manager, 1, "close-worker-first", { action: "control", command: "close_member", memberId: "w2" });
	assert.equal(closing.ok && closing.receipt?.status, "closing");
	const before = businessSnapshot(runtime, teamId);
	const close = action(runtime, manager, 2, "close-team-before-worker-release", {
		action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "Worker release is still pending.",
	});
	assert.equal(code(close), "CLOSE_BLOCKED");
	assert.deepEqual(businessSnapshot(runtime, teamId), before, "team close rejection preserves the independent member-close operation");
	runtime.assertInvariants(teamId);
});

test("A: staged reply remains uncommitted through settlement and needs matching native tool-result evidence", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const ref = workRef(worker);
	inputReady(runtime, worker);
	assert.equal(action(runtime, worker, 1, "staged-reply", { action: "reply", result: { status: "succeeded", summary: "Candidate only." } }).ok, true);
	runtime.nativeSettled(worker.binding, worker.scope.activationId, { status: "success", finalAssistantText: "Final answer." });
	assert.equal(runtime.getWork(teamId, ref)?.current.state, "running");
	assert.equal(runtime.getWork(teamId, ref)?.current.resultRef, undefined);
	runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true });
	const version = runtime.getWork(teamId, ref)?.current;
	assert.equal(version?.state, "blocked");
	assert.equal(version?.hold?.reason, "protocol");
	assert.equal(version?.resultRef, undefined);
	assert.equal(runtime.getTeam(teamId).health, "needs_attention");
	runtime.assertInvariants(teamId);
});

test("A: oversized natural final is protocol-held after cleanup and remains manager-disposable", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const ref = workRef(worker);
	inputReady(runtime, worker);
	runtime.nativeSettled(worker.binding, worker.scope.activationId, {
		status: "success", finalAssistantText: "x".repeat(TEAM_MAX_RESULT_BYTES + 64),
	});
	assert.equal(runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true }).ok, true,
		"oversized natural output must not throw after cleanup/tombstone admission");
	const held = runtime.getWork(teamId, ref)?.current;
	assert.equal(held?.state, "blocked");
	assert.equal(held?.hold?.reason, "protocol");
	assert.equal(held?.resultRef, undefined);
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.activity, "idle");
	const manager = runtime.takeNextActivation(teamId)!;
	assert.equal(manager.scope.kind, "management");
	inputReady(runtime, manager);
	assert.equal(action(runtime, manager, 1, "dispose-large-natural", {
		action: "control", command: "cancel_work", workId: ref.workId, expectedRevision: ref.revision, reason: "Oversized native result was rejected.",
	}).ok, true);
	assert.equal(action(runtime, manager, 2, "waive-large-natural", {
		action: "control", command: "accept_result", work: ref, disposition: "waived", reason: "The oversized result was not retained.",
	}).ok, true);
	runtime.assertInvariants(teamId);
});

test("L: request-before-close blocks close; close-before-request rejects without creating work", () => {
	{
		const { runtime, teamId } = makeRuntime([]);
		const manager = runtime.takeNextActivation(teamId)!;
		inputReady(runtime, manager);
		const accepted = action(runtime, manager, 1, "request-before-close", { action: "request", to: "w2", task: "must remain deliverable" });
		assert.equal(accepted.ok, true);
		const ref = accepted.ok && accepted.receipt?.status === "accepted" ? accepted.receipt.work : undefined;
		assert.ok(ref);
		const beforeClose = businessSnapshot(runtime, teamId, [ref]);
		const closed = action(runtime, manager, 2, "close-after-request", { action: "control", command: "close_member", memberId: "w2" });
		assert.equal(code(closed), "CLOSE_BLOCKED");
		assert.deepEqual(businessSnapshot(runtime, teamId, [ref]), beforeClose, "blocked close leaves the accepted obligation and member unchanged");
		runtime.assertInvariants(teamId);
	}
	{
		const { runtime, teamId } = makeRuntime([]);
		const manager = runtime.takeNextActivation(teamId)!;
		inputReady(runtime, manager);
		const closing = action(runtime, manager, 1, "close-before-request", { action: "control", command: "close_member", memberId: "w2" });
		assert.equal(closing.ok, true);
		assert.equal(closing.ok && closing.receipt?.status, "closing");
		const beforeRequest = businessSnapshot(runtime, teamId);
		const rejected = action(runtime, manager, 2, "request-after-close", { action: "request", to: "w2", task: "must not be orphaned" });
		assert.equal(code(rejected), "RECIPIENT_CLOSING");
		assert.deepEqual(businessSnapshot(runtime, teamId), beforeRequest, "request rejected after close adds no work or event-side mutation");
		const closeId = closing.ok && closing.receipt?.status === "closing" ? closing.receipt.closeId : undefined;
		assert.ok(closeId);
		assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, "w2"), closeId, { ok: true }).ok, true);
		assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w2")?.lifecycle, "closed");
		runtime.assertInvariants(teamId);
	}
});

test("L: close_team is a staged Manager decision and reports closed only after all exits are confirmed", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const rootRef = workRef(worker);
	reply(runtime, worker, "root-reply", "Reviewed root output.");
	const resultRef = runtime.getWork(teamId, rootRef)?.current.resultRef;
	assert.ok(resultRef);
	const manager = runtime.takeNextActivation(teamId)!;
	assert.equal(manager.scope.kind, "management");
	inputReady(runtime, manager);
	assert.equal(action(runtime, manager, 1, "accept-root", { action: "control", command: "accept_result", work: rootRef, disposition: "accepted" }).ok, true);
	const stagedClose = action(runtime, manager, 2, "close-team", {
		action: "control", command: "close_team", resultRefs: [resultRef], outcome: "succeeded",
	});
	assert.equal(stagedClose.ok, true);
	assert.equal(stagedClose.ok && stagedClose.receipt?.status, "closing");
	const closeId = stagedClose.ok && stagedClose.receipt?.status === "closing" ? stagedClose.receipt.closeId : undefined;
	assert.ok(closeId);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closing");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "lead")?.lifecycle, "closing",
		"Manager lifecycle closes atomically with the Team decision");
	assert.equal(runtime.takeNextActivation(teamId), undefined);
	assert.equal(runtime.nativeSettled(manager.binding, manager.scope.activationId, { status: "success", appliedToolCallId: "close-team" }).ok, true);
	assert.equal(runtime.cleanupFinished(manager.binding, manager.scope.activationId, { ok: true }).ok, true);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closing", "Manager cleanup is not process-exit confirmation");
	assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, "w1"), closeId, { ok: true }).ok, true);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closing", "other worker and Manager resources still prevent success");
	assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, "w2"), closeId, { ok: true }).ok, true);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closing", "Manager resource still prevents success");
	assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, "lead"), closeId, { ok: true }).ok, true);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closed");
	assert.deepEqual(runtime.getTeamResult(teamId)?.finalResultRefs, [resultRef]);
	runtime.assertInvariants(teamId);
});

test("L: native failure after staged close converges to failed Team and still permits confirmed exits", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	const rootRef = workRef(worker);
	reply(runtime, worker, "root-before-failed-close", "Root result before Manager native failure.");
	const resultRef = runtime.getWork(teamId, rootRef)?.current.resultRef;
	assert.ok(resultRef);
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	assert.equal(action(runtime, manager, 1, "accept-before-failed-close", {
		action: "control", command: "accept_result", work: rootRef, disposition: "accepted",
	}).ok, true);
	const close = action(runtime, manager, 2, "stage-failed-close", {
		action: "control", command: "close_team", resultRefs: [resultRef], outcome: "succeeded",
	});
	assert.equal(close.ok && close.receipt?.status, "closing");
	const closeId = close.ok && close.receipt?.status === "closing" ? close.receipt.closeId : undefined;
	assert.ok(closeId);
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "lead")?.lifecycle, "closing");
	runtime.nativeSettled(manager.binding, manager.scope.activationId, {
		status: "error", error: { code: "NATIVE_FAILURE", message: "close tool did not settle successfully" },
	});
	assert.equal(runtime.cleanupFinished(manager.binding, manager.scope.activationId, { ok: true }).ok, true);
	assert.equal(runtime.getTeam(teamId).lifecycle, "failed");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "lead")?.activity, "idle");
	for (const memberId of ["w1", "w2", "lead"]) {
		assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, memberId), closeId, { ok: true }).ok, true);
	}
	assert.equal(runtime.getTeam(teamId).lifecycle, "failed", "failed close cannot be rewritten as a successful closed Team");
	assert.equal(runtime.getTeamResult(teamId)?.lifecycle, "failed");
	assert.deepEqual(runtime.getTeamResult(teamId)?.finalResultRefs, [resultRef]);
	runtime.assertInvariants(teamId);
});

function hostError(fn: () => unknown, expected: string): void {
	assert.throws(fn, (error: unknown) => error instanceof TeamProtocolError && error.code === expected, `expected ${expected}`);
}

test("C04/G10: hold release rejects manager_unavailable and any release while the Manager is faulted, atomically", () => {
	const { runtime, teamId } = makeRuntime([
		{ to: "w1", task: "attention root" },
		{ to: "w2", task: "ask the Manager" },
	]);
	finishManagerBoot(runtime, teamId);
	const held = runtime.takeNextActivation(teamId)!;
	const heldRef = workRef(held);
	const asker = runtime.takeNextActivation(teamId)!;
	assert.equal(asker.binding.memberId, "w2");
	inputReady(runtime, held);
	action(runtime, held, 1, "attention", { action: "yield", attention: "needs a decision", checkpoint: "stopped before editing" });
	settle(runtime, held, "attention");
	const attentionIncident = runtime.getWork(teamId, heldRef)!.current.hold!.incidentId;
	inputReady(runtime, asker);
	const requested = action(runtime, asker, 1, "ask-lead", { action: "request", to: "lead", task: "decide the approach" });
	const managerWork = requested.ok && requested.receipt?.status === "accepted" ? requested.receipt.work : undefined;
	assert.ok(managerWork);
	runtime.hostControl(teamId).message_manager("review the held work");
	const manager = runtime.takeNextActivation(teamId)!;
	assert.equal(manager.scope.kind, "management");
	inputReady(runtime, manager);
	runtime.nativeSettled(manager.binding, manager.scope.activationId, { status: "error", error: { code: "UPSTREAM", message: "Manager provider failed" } });
	runtime.cleanupFinished(manager.binding, manager.scope.activationId, { ok: true });
	const team = runtime.getTeam(teamId);
	assert.equal(team.members.find((member) => member.id === "lead")?.lifecycle, "faulted");
	assert.equal(team.members.find((member) => member.id === "w2")?.pause, "requested", "the running worker is safety-paused, not aborted");
	const managerHold = runtime.getWork(teamId, managerWork)!.current.hold;
	assert.equal(managerHold?.reason, "manager_unavailable");
	const before = businessSnapshot(runtime, teamId, [heldRef, managerWork]);
	const host = runtime.hostControl(teamId);
	hostError(() => host.release_hold(managerWork, managerHold!.incidentId, "continue without a Manager"), "MEMBER_UNAVAILABLE");
	hostError(() => host.release_hold(heldRef, attentionIncident, "continue while the Manager is faulted"), "MEMBER_UNAVAILABLE");
	hostError(() => host.release_hold(heldRef, "not-this-incident", "wrong incident"), "INVALID_ARGUMENT");
	assert.deepEqual(businessSnapshot(runtime, teamId, [heldRef, managerWork]), before, "every rejected release leaves the ledger unchanged");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "no hold release can restart work while the Manager is unavailable");
	runtime.assertInvariants(teamId);
});

test("C01/C10: re-pausing a parked worker whose resume awaits a permit keeps it parked; repeated resume is a no-op", async () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `repause-${++ids}`, limits: { workerPermits: 1 } });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage work." },
		workers: [{ alias: "w1", roleDescription: "Parked worker." }, { alias: "w2", roleDescription: "Permit holder." }],
		brief: { goal: "Exercise resume/pause races at a parked gate." },
		initialRequests: [{ to: "w1", task: "parked work" }, { to: "w2", task: "permit work" }],
		timeoutSeconds: null,
	});
	const teamId = prepared.teamId;
	runtime.launch(teamId);
	finishManagerBoot(runtime, teamId);
	const parked = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, parked);
	runtime.hostControl(teamId).message_manager("pause w1");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	let sequence = 0;
	const control = (id: string, command: string) => action(runtime, manager, ++sequence, id, { action: "control", command, memberId: "w1" });
	control("pause", "pause_member");
	let decision: boolean | undefined;
	const gate = runtime.waitAtProviderGate(parked.binding, parked.scope).then((value) => { decision = value.allow; return value; });
	const w1 = () => runtime.getTeam(teamId).members.find((member) => member.id === "w1")!;
	assert.equal(w1().pause, "confirmed");
	const holder = runtime.takeNextActivation(teamId)!;
	assert.equal(holder.binding.memberId, "w2", "the parked activation released its sole permit");
	inputReady(runtime, holder);
	const resumed = control("resume", "resume_member");
	assert.equal(resumed.ok && resumed.receipt?.status, "applied");
	const repeated = control("resume-again", "resume_member");
	assert.equal(repeated.ok && repeated.receipt?.status, "unchanged", "a pending resume is not re-applied");
	const repaused = control("repause", "pause_member");
	assert.equal(repaused.ok && repaused.receipt?.status, "applied", "pause cancels the pending resume");
	assert.equal(w1().pause, "confirmed");
	reply(runtime, holder, "holder-reply", "permit released");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(decision, undefined, "a freed permit does not resume a worker that was paused again");
	assert.equal(w1().pause, "confirmed");
	control("resume-final", "resume_member");
	assert.equal((await gate).allow, true, "the explicit final resume reacquires the free permit");
	assert.equal(w1().pause, "none");
	runtime.assertInvariants(teamId);
});

test("C08: native settlement releases a still-parked provider gate so cleanup never waits on it", async () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, worker);
	runtime.hostControl(teamId).message_manager("pause w1");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	action(runtime, manager, 1, "pause", { action: "control", command: "pause_member", memberId: "w1" });
	const gate = runtime.waitAtProviderGate(worker.binding, worker.scope);
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause, "confirmed");
	assert.equal(runtime.nativeSettled(worker.binding, worker.scope.activationId, { status: "aborted" }).ok, true);
	assert.deepEqual(await gate, { allow: false, reason: "activation_ending", message: "The native activation already settled" });
	assert.equal(runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true }).ok, true);
	assert.equal(runtime.activationCompletionReason(worker.binding, worker.scope.activationId), "native_failure",
		"an unexplained abort is not relabelled as a controlled pause");
	runtime.assertInvariants(teamId);
});

test("L10/X08: host cancel after a staged close_team keeps the close decision and does not stop the Manager settlement", () => {
	const { runtime, teamId } = makeRuntime([]);
	finishManagerBoot(runtime, teamId);
	runtime.hostControl(teamId).message_manager("close now");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const staged = action(runtime, manager, 1, "close", { action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "nothing to do" });
	const closeId = staged.ok && staged.receipt?.status === "closing" ? staged.receipt.closeId : undefined;
	assert.ok(closeId);
	const cancel = runtime.hostControl(teamId).cancel_team("late host cancellation");
	assert.equal(cancel.status, "unchanged");
	assert.equal(runtime.activationCompletionReason(manager.binding, manager.scope.activationId), undefined,
		"the Manager's terminating activation carries no policy stop");
	settle(runtime, manager, "close");
	for (const memberId of ["w1", "w2", "lead"]) {
		assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, memberId), closeId, { ok: true }).ok, true);
	}
	const result = runtime.getTeamResult(teamId)!;
	assert.equal(result.lifecycle, "closed");
	assert.equal(result.outcome, "failed");
	assert.equal(result.reason, "nothing to do");
	runtime.assertInvariants(teamId);
});

test("P/6.1: an unclaimed prepared Team cancels without launch, provider or resource claims", async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "Cancel before launch." }, initialRequests: [{ to: "w1", task: "never runs" }], timeoutSeconds: null,
	});
	const receipt = runtime.hostControl(prepared.teamId).cancel_team("re-prepare instead");
	assert.equal(receipt.status, "applied");
	const result = await runtime.waitForCompletion(prepared.teamId);
	assert.equal(result.lifecycle, "cancelled");
	assert.equal(result.reason, "re-prepare instead");
	assert.deepEqual(result.roots.map((root) => root.state), ["cancelled"]);
	assert.ok(result.members.every((member) => member.lifecycle === "closed" && member.resourceState === "released"));
	assert.equal(runtime.takeNextActivation(prepared.teamId), undefined);
	hostError(() => runtime.launch(prepared.teamId), "INVALID_ARGUMENT");
	hostError(() => runtime.claimNativeLifetime(prepared.teamId, "w1"), "INVALID_ARGUMENT");
	assert.equal(runtime.hostControl(prepared.teamId).cancel_team("again").status, "unchanged");
	runtime.assertInvariants(prepared.teamId);
});

test("C10/12.5: a real native error after cancel_work is isolated as native_failure, not masked as a policy stop", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "cancel me" }, { to: "w2", task: "unrelated" }]);
	finishManagerBoot(runtime, teamId);
	const target = runtime.takeNextActivation(teamId)!;
	const ref = workRef(target);
	inputReady(runtime, target);
	runtime.hostControl(teamId).message_manager("cancel the target");
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	assert.equal(action(runtime, manager, 1, "cancel", { action: "control", command: "cancel_work", workId: ref.workId, expectedRevision: 1, reason: "obsolete" }).ok, true);
	assert.equal(runtime.activationCompletionReason(target.binding, target.scope.activationId), "policy_cancelled");
	runtime.nativeSettled(target.binding, target.scope.activationId, { status: "error", error: { code: "UPSTREAM", message: "provider 500 during stop" } });
	assert.equal(runtime.activationCompletionReason(target.binding, target.scope.activationId), "native_failure");
	runtime.cleanupFinished(target.binding, target.scope.activationId, { ok: true });
	assert.equal(runtime.getWork(teamId, ref)?.current.state, "cancelled", "the earlier cancel decision keeps the work outcome");
	const team = runtime.getTeam(teamId);
	assert.equal(team.members.find((member) => member.id === "w1")?.lifecycle, "faulted", "the real provider error isolates the member");
	assert.equal(team.members.find((member) => member.id === "w2")?.lifecycle, "open");
	assert.ok(team.incidents.some((incident) => incident.code === "UPSTREAM"), "the provider error stays visible as an incident");
	runtime.assertInvariants(teamId);
});
