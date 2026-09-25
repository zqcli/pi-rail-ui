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

test("A: provider/tool gates require the exact delivered WorkRef and reject the activation after a staged intent", () => {
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
	assert.equal(runtime.gate(activation.binding, activation.scope, "provider_gate").allow, false);
	runtime.assertInvariants(teamId);
});

test("A: pre-settlement transport loss clears the running slot as outcome-unknown and faults only that member", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const activation = runtime.takeNextActivation(teamId)!;
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
	assert.equal(runtime.getWork(teamId, ref)?.current.state, "failed");
	assert.equal(runtime.getWork(teamId, ref)?.current.error?.outcomeUnknown, true);
	assert.equal(runtime.gate(activation.binding, activation.scope, "tool_gate").allow, false);
	runtime.assertInvariants(teamId);
	const next = runtime.takeNextActivation(teamId);
	assert.equal(next?.scope.kind, "management", "the manager can observe the incident; the failed worker is not stuck holding a permit");
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
