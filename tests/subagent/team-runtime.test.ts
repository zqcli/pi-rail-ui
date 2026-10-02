import assert from "node:assert/strict";
import { test } from "node:test";
import {
	TeamProtocolError, encodeActivationInput, jsonBytes, normalizeTeamAction, normalizeTeamPlan, parseChildFrame, parseParentCommand, parseTeamReply,
} from "../../tools/subagents/team-codec";
import { TEAM_TIMELINE_HEAD, TeamRuntime, handlingText, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import {
	TEAM_MAX_ACTIVATION_INPUT_BYTES, TEAM_MAX_FRAME_BYTES, TEAM_MAX_NOTE_BYTES, TEAM_MAX_RESULT_BYTES, shortWorkRef, workRefKey, type TeamBudgetLimits, type WorkRef,
} from "../../tools/subagents/team-protocol";

function makeRuntime(initialRequests: Array<{ to: string; task: string }> = [{ to: "w1", task: "root work" }],
	{ extraWorkers = [], limits = {}, createId, defaultIds = false }: {
		extraWorkers?: string[]; limits?: Partial<TeamBudgetLimits>; createId?: (count: number) => string; defaultIds?: boolean;
	} = {}) {
	let ids = 0;
	let time = 1_700_000_000_000;
	// An injected createId (the deterministic `id1`... by default) is used for every kind of ID; `defaultIds` runs the production generators.
	const runtime = new TeamRuntime({ now: () => time++, ...(defaultIds ? {} : { createId: () => createId ? createId(++ids) : `id${++ids}` }), limits });
	const prepared = runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage work, review roots and close the Team." }, { alias: "w1", roleDescription: "Perform assigned work." },
			{ alias: "w2", roleDescription: "Perform dependent work." },
			...extraWorkers.map((alias) => ({ alias, roleDescription: "Perform assigned work." })),], lead: "lead",
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
	assert.equal(activation.scope.kind, "events");
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
		members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "lead", brief: { goal: "Test." }, timeoutSeconds: null,
	}), {
		members: [{ alias: "lead", roleDescription: "Manage.", policy: {} }, { alias: "w1", roleDescription: "Work.", policy: {} }], lead: "lead",
		brief: { goal: "Test." }, initialRequests: [], timeoutSeconds: null, review: null,
	});
});

test("Manager guidance: management input says to yield instead of polling, and host panel facts count events and results", () => {
	const { runtime, teamId } = makeRuntime();
	const boot = runtime.takeNextActivation(teamId)!;
	assert.equal(boot.scope.kind, "events");
	assert.match(boot.input.notice, /no current WorkRef.*yield.*do not poll status/u);
	assert.match(boot.input.notice, /WORK_HELD .*resume_work \{workId, expectedRevision, incidentId, instruction\}.*resultRef or WorkRef/u,
		"the Manager learns how to hand a held member the conclusion it needs");
	assert.match(boot.input.notice, /close_team checks every root itself/u);
	const bootEvent = boot.input.scope.kind === "events" ? boot.input.scope.events[0]! : undefined;
	assert.match(bootEvent?.message ?? "", /1 initial request\(s\) are already assigned.*w1 \S+@1 "root work".*Do not request them again/u,
		"BOOT names the initialRequests that already run, so the Manager does not duplicate them");
	assert.match(bootEvent?.message ?? "", /close_team itself closes idle members/u);
	inputReady(runtime, boot);
	const waiting = action(runtime, boot, 1, "manager-wait", { action: "yield", waitingFor: [{ workId: "any", revision: 1 }], checkpoint: "wait" });
	assert.equal(code(waiting), "INVALID_ARGUMENT");
	assert.match(waiting.ok ? "" : waiting.error.message, /never waits inside an activation.*start the next events activation automatically/u);
	assert.equal(action(runtime, boot, 2, "boot-yield", { action: "yield" }).ok, true);
	settle(runtime, boot, "boot-yield");

	const work = runtime.takeNextActivation(teamId)!;
	assert.ok(work.input.notice.startsWith(`Current work: ${workRefKey(workRef(work))}. Earlier works in this session are finished; answer only this task, not a previous one. `),
		"the notice names the exact current WorkRef, so a long-lived session does not answer an earlier work");
	assert.ok(Buffer.byteLength(work.input.notice, "utf8") < TEAM_MAX_NOTE_BYTES, "and still fits the notice bound");
	assert.match(work.input.notice, /Only the current WorkRef is authorized/u);
	assert.match(work.input.notice, /An outcome's preview is only its status and summary; read its findings and evidence with status\(result\) before relying on them\./u,
		"a woken worker is told a preview is not the dependency's full result");
	assert.match(work.input.notice, /needs another member's conclusion.*yield \{waitingFor:.*request it from that member.*yield \{attention, checkpoint\}/u,
		"a worker learns the peer-dependency paths");
	reply(runtime, work, "w1-reply", "first result");
	const facts = runtime.panelFacts(teamId);
	assert.ok(facts.pendingEvents >= 1, "the committed result waits as a Manager event");
	assert.equal(facts.results.get("w1")?.count, 1);
	assert.equal(facts.results.get("w1")?.latest.result.summary, "first result");
	assert.equal(facts.results.has("lead"), false);
	const next = runtime.takeNextActivation(teamId)!;
	assert.equal(next.scope.kind, "events");
	assert.equal(runtime.panelFacts(teamId).pendingEvents, 0, "events delivered to an activation are no longer pending");
	const resultEvent = next.input.scope.kind === "events" ? next.input.scope.events.find((event) => event.kind === "ROOT_RESULT_READY") : undefined;
	assert.match(resultEvent?.message ?? "", /committed succeeded result \S+ from w1, in full below; review it .* without a status call:\n\nfirst result$/u);

	// A duplicate root that the Manager cancels is named when a succeeded close is refused.
	inputReady(runtime, next);
	const duplicate = action(runtime, next, 1, "dup-request", { action: "request", to: "w2", task: "duplicate root" });
	assert.equal(duplicate.ok, true);
	const duplicateRef = (duplicate as any).receipt.work;
	assert.equal(action(runtime, next, 2, "dup-cancel", { action: "control", command: "cancel_work", workId: duplicateRef.workId,
		expectedRevision: 1, reason: "duplicate" }).ok, true);
	const rootRef = resultEvent!.work!;
	assert.equal(action(runtime, next, 3, "accept", { action: "control", command: "accept_result", work: rootRef, disposition: "accepted", reason: "ok" }).ok, true);
	const resultRef = resultEvent!.resultRef!;
	const refused = action(runtime, next, 4, "close-succeeded", { action: "control", command: "close_team", resultRefs: [resultRef], outcome: "succeeded" });
	assert.equal(code(refused), "INVALID_TEAM_OUTCOME");
	assert.match(refused.ok ? "" : refused.error.message, /waive it with accept_result disposition waived/u);
	assert.deepEqual(refused.ok ? [] : refused.error.blockers?.map((blocker) => [blocker.kind, blocker.id, blocker.reason]),
		[["root_outcome", `${duplicateRef.workId}@1`, "root is cancelled and not accepted"]]);
});

test("ROOT_RESULT_READY carries a maximum-size root result in full inside a valid Manager activation input", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const work = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, work);
	const finding = "界".repeat(1300);
	const findings = Array.from({ length: 3 }, (_, index) => `${index}${finding}`);
	assert.equal(action(runtime, work, 1, "big", { action: "reply", result: { status: "succeeded", summary: "big", findings } }).ok, true);
	settle(runtime, work, "big");
	const manager = runtime.takeNextActivation(teamId)!;
	const event = manager.input.scope.kind === "events" ? manager.input.scope.events.find((item) => item.kind === "ROOT_RESULT_READY") : undefined;
	assert.ok(event?.message.endsWith(`Findings:\n${findings.map((item) => `- ${item}`).join("\n")}`));
	assert.doesNotThrow(() => parseParentCommand({ version: 2, commandId: "activate", operation: "activate", binding: manager.binding,
		activation: manager.scope, deliveryId: manager.deliveryId, input: manager.input }));
});

test("peer dependency: a held worker gets another worker's resultRef from the Manager, or waits on its WorkRef directly", () => {
	const setup = (initialRequests: Array<{ to: string; task: string }>) => {
		const { runtime, teamId } = makeRuntime(initialRequests);
		finishManagerBoot(runtime, teamId);
		return { runtime, teamId, first: runtime.takeNextActivation(teamId)!, second: runtime.takeNextActivation(teamId)! };
	};
	// Path 1: w1 asks the Manager; the Manager resumes it naming w2's committed result.
	{
		const { runtime, teamId, first, second } = setup([{ to: "w1", task: "step 1, then step 2 with w2's conclusion" }, { to: "w2", task: "conclude" }]);
		reply(runtime, second, "w2-reply", "w2 conclusion: plan X");
		inputReady(runtime, first);
		assert.equal(action(runtime, first, 1, "w1-held", { action: "yield", attention: "need w2's conclusion", checkpoint: "step 1 done" }).ok, true);
		settle(runtime, first, "w1-held");
		const manager = runtime.takeNextActivation(teamId)!;
		const events = manager.input.scope.kind === "events" ? manager.input.scope.events : [];
		const held = events.find((event) => event.kind === "WORK_HELD")!;
		const conclusion = events.find((event) => event.kind === "ROOT_RESULT_READY")!.resultRef!;
		inputReady(runtime, manager);
		const producer = events.find((event) => event.kind === "ROOT_RESULT_READY")!.work!;
		const misuse = action(runtime, manager, 1, "work-as-input", { action: "request", to: "w2", task: "follow up", inputRefs: [producer.workId] });
		assert.equal(code(misuse), "UNKNOWN_RESULT");
		assert.match(misuse.ok ? "" : misuse.error.message, new RegExp(`is a work ID, not a result ID; its current result is ${conclusion}`, "u"),
			"passing a work ID where a result ID belongs names the result to use");
		assert.equal(action(runtime, manager, 2, "resume", { action: "control", command: "resume_work", workId: held.work!.workId, expectedRevision: 1,
			incidentId: held.incidentId!, instruction: `w2's conclusion is result ${conclusion}` }).ok, true);
		assert.equal(runtime.getTeam(teamId).health, "ok", "an answered WORK_HELD no longer flags the Team");
		assert.equal(action(runtime, manager, 3, "manager-yield", { action: "yield" }).ok, true);
		settle(runtime, manager, "manager-yield");
		const resumed = runtime.takeNextActivation(teamId)!;
		assert.equal(resumed.binding.memberId, "w1");
		assert.equal(resumed.input.scope.kind === "work" ? resumed.input.scope.checkpoint : undefined, "step 1 done");
		assert.match(resumed.input.scope.kind === "work" ? resumed.input.scope.resumeInstruction ?? "" : "", new RegExp(conclusion, "u"));
		inputReady(runtime, resumed);
		const read = action(runtime, resumed, 1, "read", { action: "status", view: "result", id: conclusion });
		assert.equal((read as any).data.result.summary, "w2 conclusion: plan X");
		assert.equal(action(runtime, resumed, 2, "w1-reply", { action: "reply", result: { status: "succeeded", summary: "step 2 done" } }).ok, true);
		settle(runtime, resumed, "w1-reply");
		assert.equal(runtime.getWork(teamId, first.scope.work!)!.revisions[0]!.state, "resolved");
		const timeline = runtime.panelFacts(teamId).timeline.map((entry) => entry.text);
		const heldAt = timeline.findIndex((text) => /^w1 ended work \S+ \(yield attention\)$/u.test(text));
		const resumedAt = timeline.findIndex((text) => /^lead resumed work \S+$/u.test(text));
		assert.ok(heldAt >= 0 && resumedAt > heldAt, "the timeline shows the hold and the Manager's hand-off");
	}
	// Path 2: w1 waits on w2's WorkRef itself and wakes with its outcome.
	{
		const { runtime, teamId, first, second } = setup([{ to: "w1", task: "needs w2" }, { to: "w2", task: "conclude" }]);
		inputReady(runtime, first);
		assert.equal(action(runtime, first, 1, "w1-wait", { action: "yield", waitingFor: [second.scope.work], checkpoint: "waiting for w2" }).ok, true);
		settle(runtime, first, "w1-wait");
		reply(runtime, second, "w2-reply", "w2 conclusion: plan X");
		let next = runtime.takeNextActivation(teamId)!;
		while (next.binding.memberId === "lead") { finishIdle(runtime, next); next = runtime.takeNextActivation(teamId)!; }
		assert.equal(next.binding.memberId, "w1");
		assert.equal(next.input.outcomes[0]?.preview?.summary, "w2 conclusion: plan X");
	}
});

function finishIdle(runtime: TeamRuntime, activation: RuntimeActivation): void {
	inputReady(runtime, activation);
	assert.equal(action(runtime, activation, 1, `idle-${activation.scope.activationId}`, { action: "yield" }).ok, true);
	settle(runtime, activation, `idle-${activation.scope.activationId}`);
}

/** Acknowledge the input, stage a yield (the first action of the activation) and settle it. */
function yieldWork(runtime: TeamRuntime, activation: RuntimeActivation, callId: string, args: Record<string, unknown>): void {
	inputReady(runtime, activation);
	assert.equal(action(runtime, activation, 1, callId, { action: "yield", ...args }).ok, true);
	settle(runtime, activation, callId);
}

function request(runtime: TeamRuntime, activation: RuntimeActivation, sequence: number, to: string, task: string): WorkRef {
	const requested = action(runtime, activation, sequence, `request-${to}`, { action: "request", to, task });
	const ref = requested.ok && requested.receipt?.status === "accepted" ? requested.receipt.work : undefined;
	assert.ok(ref);
	return ref;
}

/** Deterministic 4-character codes, any two differing in at least two positions, so none is a one-slip typo of another. */
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const spacedCode = (count: number) => [count % 8, (count * 7 + 3) % 31, Math.floor(count / 8) % 31, (Math.floor(count / 8) * 5 + 1) % 31]
	.map((index) => ALPHABET.charAt(index)).join("");
/** The same ID with one code character replaced, and with two adjacent code characters swapped. */
const substituted = (id: string) => `${id.slice(0, -2)}${id.at(-2) === "z" ? "y" : "z"}${id.at(-1)}`;
const transposed = (id: string) => `${id.slice(0, -2)}${id.at(-1)}${id.at(-2)}`;

test("quoted IDs: a mistyped short ID in a reply is rejected with the one it is a typo of, nothing is staged, and the corrected reply commits", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "needs w2's conclusion" }, { to: "w2", task: "conclude" }, { to: "w3", task: "free text" }],
		{ extraWorkers: ["w3"], createId: spacedCode });
	finishManagerBoot(runtime, teamId);
	const writer = runtime.takeNextActivation(teamId)!;
	const source = runtime.takeNextActivation(teamId)!;
	const natural = runtime.takeNextActivation(teamId)!;
	reply(runtime, source, "w2-reply", "w2 conclusion");
	const resultId = runtime.getWork(teamId, workRef(source))!.current.resultRef!;
	const sourceId = workRef(source).workId;
	assert.match(resultId, /^result:[2-9a-hjkmnp-z]{4}$/u);
	assert.match(sourceId, /^work:[2-9a-hjkmnp-z]{4}$/u);
	assert.notEqual(transposed(resultId), resultId);

	inputReady(runtime, writer);
	const before = businessSnapshot(runtime, teamId, [workRef(writer)]);
	let sequence = 0;
	const send = (result: Record<string, unknown>) => action(runtime, writer, ++sequence, `reply-${sequence}`, { action: "reply", result: { status: "succeeded", summary: "done", ...result } });
	const message = (replyValue: ReturnType<typeof send>) => replyValue.ok ? "" : replyValue.error.message;

	const slipped = send({ summary: `Based on ${substituted(resultId)} and ${resultId}.` });
	assert.equal(code(slipped), "UNKNOWN_RESULT");
	assert.match(message(slipped), new RegExp(`${substituted(resultId)} \\(did you mean ${resultId}\\?\\)`, "u"), "a substituted character names the ID it was copied from");
	assert.doesNotMatch(message(slipped), new RegExp(`${resultId}[^?]`, "u"), "the correct ID quoted next to it is not listed as unknown");
	const swapped = send({ findings: [`Based on ${transposed(resultId)}`] });
	assert.match(message(swapped), new RegExp(`${transposed(resultId)} \\(did you mean ${resultId}\\?\\)`, "u"), "so does an adjacent transposition");
	const badWork = send({ findings: [`Produced by ${substituted(sourceId)}`] });
	assert.equal(code(badWork), "UNKNOWN_WORK", "a mistyped work ID is rejected with the existing unknown-work code");
	assert.match(message(badWork), new RegExp(`${substituted(sourceId)} \\(did you mean ${sourceId}\\?\\)`, "u"));
	const both = send({ artifacts: [substituted(sourceId), transposed(resultId)] });
	assert.equal(code(both), "UNKNOWN_RESULT", "a wrong result ID decides the code when both kinds are wrong");
	assert.match(message(both), new RegExp(`${substituted(sourceId)}.*${transposed(resultId)}`, "u"), "every unknown token is listed");
	const far = send({ summary: "Based on result:zz9z." });
	assert.equal(code(far), "UNKNOWN_RESULT");
	assert.match(message(far), /result:zz9z\. /u, "an ID that is a typo of none is listed without a guess");
	for (const carrier of [{ limitations: [substituted(resultId)] }, { evidence: [{ source: substituted(resultId), basis: "observed" }] },
		{ evidence: [{ source: "status", locator: substituted(resultId), basis: "observed" }] }]) {
		assert.equal(code(send(carrier)), "UNKNOWN_RESULT", JSON.stringify(carrier));
	}
	assert.deepEqual(businessSnapshot(runtime, teamId, [workRef(writer)]), before, "a rejected reply changes no work, result or Team state");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.activity, "running", "and the activation is not ending");

	// Correct IDs, other text that is not a short ID (an old UUID-format ID, a longer word) and prose pass.
	const foreign = "result:9ce10099-0fac-48ff-9b00-e78f26233979";
	const committed = send({ summary: `Based on ${resultId.toUpperCase()} from ${sourceId}; an older run cited ${foreign}; see work:${resultId.slice(7)}x and result:ab; result:pass is a word, not an ID.` });
	assert.equal(committed.ok, true, JSON.stringify(committed));
	settle(runtime, writer, `reply-${sequence}`);
	assert.equal(runtime.getWork(teamId, workRef(writer))?.current.state, "resolved");

	// Only the text a member forwards is checked: a natural final answer is committed as the model wrote it.
	inputReady(runtime, natural);
	settle(runtime, natural, undefined, `Natural final quoting ${substituted(resultId)}.`);
	assert.equal(runtime.getWork(teamId, workRef(natural))?.current.state, "resolved");
	runtime.assertInvariants(teamId);
});

test("quoted IDs: a request, a question and every Manager control text with an unknown ID is rejected and changes nothing", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "asks a question" }], { createId: spacedCode });
	finishManagerBoot(runtime, teamId);
	const asker = runtime.takeNextActivation(teamId)!;
	const ref = workRef(asker);
	inputReady(runtime, asker);
	const ghost = `Compare with ${substituted(ref.workId)}.`;
	const asked = action(runtime, asker, 1, "ask-bad", { action: "yield", attention: ghost, checkpoint: "stopped" });
	assert.equal(code(asked), "UNKNOWN_WORK", "a question forwarded to the Manager is checked");
	assert.match(asked.ok ? "" : asked.error.message, new RegExp(`${substituted(ref.workId)} \\(did you mean ${ref.workId}\\?\\)`, "u"));
	assert.equal(runtime.getWork(teamId, ref)?.current.state, "running", "nothing was staged, so the work is not held");
	assert.equal(action(runtime, asker, 2, "ask-good", { action: "yield", attention: `Which approach for ${ref.workId}?`, checkpoint: "stopped" }).ok, true);
	settle(runtime, asker, "ask-good");
	const incidentId = runtime.getWork(teamId, ref)!.current.hold!.incidentId;
	assert.match(incidentId, /^incident:[2-9a-hjkmnp-z]{4}$/u);

	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const total = () => runtime.getTeam(teamId).works.total;
	const before = businessSnapshot(runtime, teamId, [ref]);
	const bad = `see ${substituted(incidentId)}`;
	let sequence = 0;
	const attempts: Array<[string, Record<string, unknown>]> = [
		["request.task", { action: "request", to: "w2", task: `Follow up on ${substituted(ref.workId)}` }],
		["resume_work.instruction", { action: "control", command: "resume_work", workId: ref.workId, expectedRevision: 1, incidentId, instruction: `Use ${substituted(ref.workId)}` }],
		["revise_work.task", { action: "control", command: "revise_work", workId: ref.workId, expectedRevision: 1, task: `Redo ${substituted(ref.workId)}`, inputRefs: [] }],
		["cancel_work.reason", { action: "control", command: "cancel_work", workId: ref.workId, expectedRevision: 1, reason: bad }],
		["accept_result.reason", { action: "control", command: "accept_result", work: ref, disposition: "waived", reason: bad }],
		["close_team.reason", { action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: bad }],
	];
	for (const [field, args] of attempts) {
		const rejected = action(runtime, manager, ++sequence, `bad-${sequence}`, args);
		assert.equal(code(rejected), "UNKNOWN_WORK", field);
		assert.match(rejected.ok ? "" : rejected.error.message, /did you mean (work|incident):[2-9a-hjkmnp-z]{4}\?/u, field);
	}
	assert.equal(total(), 1, "no work was created");
	assert.deepEqual(businessSnapshot(runtime, teamId, [ref]), before, "the held work was not resumed, revised, cancelled, waived or closed");
	assert.equal(runtime.getWork(teamId, ref)?.current.hold?.incidentId, incidentId);

	const resumed = action(runtime, manager, ++sequence, "resume-good", { action: "control", command: "resume_work", workId: ref.workId, expectedRevision: 1,
		incidentId, instruction: `Take the first approach for ${ref.workId} (${incidentId}).` });
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	assert.equal(runtime.getWork(teamId, ref)?.current.hold, undefined);
	runtime.assertInvariants(teamId);
});

test("default IDs: work, result, incident and event IDs are 4-character codes from the unambiguous alphabet, unique in their Team", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "asks a question" }], { defaultIds: true });
	const boot = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, boot);
	for (let index = 0; index < 60; index++) assert.equal(action(runtime, boot, index + 1, `request-${index}`, { action: "request", to: "w2", task: `task ${index}` }).ok, true);
	assert.equal(action(runtime, boot, 61, "boot-yield", { action: "yield" }).ok, true);
	settle(runtime, boot, "boot-yield");
	const asker = runtime.takeNextActivation(teamId)!;
	const answerer = runtime.takeNextActivation(teamId)!;
	yieldWork(runtime, asker, "ask", { attention: "which scope?", checkpoint: "stopped" });
	reply(runtime, answerer, "reply", "done");
	const manager = runtime.takeNextActivation(teamId)!;
	const events = manager.input.scope.kind === "events" ? manager.input.scope.events.map((event) => event.id) : [];
	const ids = {
		work: runtime.listWorks(teamId).map((item) => item.work.workId),
		result: runtime.listWorks(teamId).flatMap((item) => item.resultRef ? [item.resultRef] : []),
		incident: runtime.getTeam(teamId).incidents.map((incident) => incident.id),
		event: events,
	};
for (const [kind, list] of Object.entries(ids)) {
		assert.ok(list.length > 0, `${kind} IDs were created`);
		assert.ok(list.every((id) => new RegExp(`^${kind}:[2-9a-hjkmnp-z]{4}$`, "u").test(id)), `${kind}: ${list.join(", ")}`);
		assert.equal(new Set(list).size, list.length, `${kind} IDs are unique`);
		assert.ok(list.every((id) => /[2-9]/u.test(id.slice(kind.length + 1))), `${kind} codes all carry a digit`);
		assert.ok(list.every((id, index) => list.every((other, at) => at === index
			|| [...id].filter((char, position) => char !== other[position]).length >= 2)), `${kind}: no ID is one substitution from another`);
	}
	assert.equal(ids.work.length, 61);
	assert.equal(shortWorkRef({ workId: ids.work[0]!, revision: 2 }), `work ${ids.work[0]!.slice(5)}@2`, "the display form shows the whole code");
	assert.equal(shortWorkRef({ workId: "work:3f2a9b1c-0a1b-4c2d-8e3f-123456789abc", revision: 1 }), "work 3f2a9b1c@1", "and still the first 8 characters of an old UUID");
});

test("timeline: a full timeline keeps its first entries and the newest, and counts the dropped ones in between", () => {
	const { runtime, teamId } = makeRuntime([]);
	const boot = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, boot);
	let sequence = 0;
	const requestAt = (index: number) => {
		const requested = action(runtime, boot, ++sequence, `request-${index}`, { action: "request", to: index % 2 ? "w1" : "w2", task: `task ${index}` });
		return requested.ok && requested.receipt?.status === "accepted" ? requested.receipt.work : assert.fail(JSON.stringify(requested));
	};
	for (let index = 0; index < TEAM_TIMELINE_HEAD - 2; index++) requestAt(index);
	const head = runtime.panelFacts(teamId).timeline;
	assert.equal(head.length, TEAM_TIMELINE_HEAD, "launch, the Manager's start and the requests so far");
	assert.equal(runtime.panelFacts(teamId).timelineOmitted, 0);
	let last!: WorkRef;
	for (let index = TEAM_TIMELINE_HEAD - 2; index < 120; index++) last = requestAt(index);
	const facts = runtime.panelFacts(teamId);
	assert.equal(facts.timeline.length, 122, "more than 100 milestones remain available to the popup");
	assert.equal(facts.timelineOmitted, 0);
	assert.deepEqual(facts.timeline.slice(0, TEAM_TIMELINE_HEAD), head, "the start of the run is kept, launch included");
	assert.equal(facts.timeline.at(-1)!.text, `lead requested ${shortWorkRef(last)} \u2192 w1`, "and so is the newest milestone (request 119 went to w1)");
	assert.match(facts.timeline[TEAM_TIMELINE_HEAD]!.text, /^lead requested work \S+ \u2192 w[12]$/u);
	const cancel = (ref: WorkRef) => assert.equal(action(runtime, boot, ++sequence, `cancel-${ref.workId}`, {
		action: "control", command: "cancel_work", workId: ref.workId, expectedRevision: 1, reason: "Not needed.",
	}).ok, true);
	for (const work of runtime.listWorks(teamId)) cancel(work.work);
	for (let index = 120; index < 510; index++) cancel(requestAt(index));
	const retained = runtime.panelFacts(teamId);
	assert.equal(retained.timeline.length, 1000);
	assert.equal(retained.timelineOmitted, 22);
	assert.deepEqual(retained.timeline.slice(0, TEAM_TIMELINE_HEAD), head);
	assert.match(retained.timeline.at(-1)!.text, /^lead cancelled /u);
});

test("processStats counts committed waits/questions, versions, results, activations and error replies once", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	const worker = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, worker);
	const requested = action(runtime, worker, 1, "child", { action: "request", to: "w2", task: "child task" });
	assert.equal(requested.ok, true);
	const child = (requested as any).receipt.work;
	assert.equal(action(runtime, worker, 2, "wait", { action: "yield", waitingFor: [child], checkpoint: "wait" }).ok, true);
	assert.equal(runtime.processStats(teamId).dependencyWaits, 0, "staged is not committed");
	settle(runtime, worker, "wait");
	const peer = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, peer);
	assert.equal(action(runtime, peer, 1, "question", { action: "yield", attention: "Which input?", checkpoint: "paused" }).ok, true);
	settle(runtime, peer, "question");
	// The held sub-task wakes its waiting parent, which answers it by revising the child.
	const manager = runtime.takeNextActivation(teamId)!;
	assert.equal(manager.scope.kind, "work");
	assert.equal(manager.input.childIssues?.[0]?.work.workId, child.workId);
	inputReady(runtime, manager);
	const bad = { action: "request", to: "missing", task: "bad" };
	assert.equal(action(runtime, manager, 1, "bad", bad).ok, false);
	assert.equal(action(runtime, manager, 1, "bad", bad).ok, false, "cached error is not a second action");
	assert.equal(action(runtime, manager, 2, "revise", { action: "control", command: "revise_work", workId: child.workId, expectedRevision: 1, task: "Use fixture A", inputRefs: [] }).ok, true);
	const stats = runtime.processStats(teamId);
	assert.deepEqual(stats, {
		works: 2, roots: 1, results: 0, activations: 4, modelTurns: 0,
		dependencyWaits: 1, questions: 1, revisions: 1, cancelled: 0, toolErrors: 1, transientRetries: 0,
		memberActivations: new Map([["lead", 1], ["w1", 2], ["w2", 1]]),
	});
	assert.equal(action(runtime, manager, 3, "malformed", { action: "unknown" }).ok, false);
	assert.equal(runtime.processStats(teamId).toolErrors, 2, "codec errors also produce error replies");
	assert.equal(action(runtime, manager, 4, "wait-again", { action: "yield", waitingFor: [{ workId: child.workId, revision: 2 }], checkpoint: "revised" }).ok, true);
	runtime.nativeSettled(manager.binding, manager.scope.activationId, {
		status: "success", appliedToolCallId: "wait-again",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 2 },
	});
	runtime.cleanupFinished(manager.binding, manager.scope.activationId, { ok: true });
	const revised = runtime.takeNextActivation(teamId)!;
	reply(runtime, revised, "done", "Fixture A is ready.");
	assert.equal(runtime.processStats(teamId).results, 1);
	assert.equal(runtime.processStats(teamId).modelTurns, 2);
	assert.equal(runtime.processStats(teamId).activations, 5);
});

test("timeline: a management activation names each event kind once", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "first root" }, { to: "w2", task: "second root" }]);
	finishManagerBoot(runtime, teamId);
	const first = runtime.takeNextActivation(teamId)!;
	const second = runtime.takeNextActivation(teamId)!;
	reply(runtime, first, "first-reply", "first done");
	reply(runtime, second, "second-reply", "second done");
	const manager = runtime.takeNextActivation(teamId)!;
	const kinds = manager.input.scope.kind === "events" ? manager.input.scope.events.map((event) => event.kind) : [];
	assert.equal(kinds.filter((kind) => kind === "ROOT_RESULT_READY").length, 2, "the batch carries two events of the same kind");
	const note = runtime.panelFacts(teamId).timeline.findLast((entry) => entry.text.startsWith("lead events activation"))!.text;
	assert.equal(note, `lead events activation (${[...new Set(kinds)].join(", ")})`);
	assert.doesNotMatch(note, /ROOT_RESULT_READY, ROOT_RESULT_READY/u);
});

test("panel facts name who a blocked member waits on: a peer with its state, at most three names, and the timeline says who", () => {
	{
		const { runtime, teamId } = makeRuntime([{ to: "w1", task: "needs w2" }, { to: "w2", task: "conclude" }]);
		finishManagerBoot(runtime, teamId);
		const waiter = runtime.takeNextActivation(teamId)!;
		const producer = runtime.takeNextActivation(teamId)!;
		yieldWork(runtime, waiter, "w1-wait", { waitingFor: [workRef(producer)], checkpoint: "waiting for w2" });
		const facts = runtime.panelFacts(teamId);
		assert.equal(facts.stalled.get("w1"), `waiting on w2 (running ${shortWorkRef(workRef(producer))})`, "one peer: its alias, state and short ref");
		assert.equal(facts.stalled.has("w2"), false, "a running member is not stalled");
		assert.equal(facts.waitingFor, "w2 (running) · w1 (waiting on w2)");
		assert.ok(facts.timeline.some((entry) => entry.text === `w1 ended ${shortWorkRef(workRef(waiter))} (waiting on w2)`),
			"the timeline names the assignee a yielded work waits on");
		reply(runtime, producer, "w2-reply", "w2 conclusion");
		assert.equal(runtime.panelFacts(teamId).stalled.has("w1"), false, "once w2 has answered, w1 is queued and no longer waits");
	}
	{
		const { runtime, teamId } = makeRuntime(["w1", "w2", "w3", "w4", "w5"].map((to) => ({ to, task: `root of ${to}` })), { extraWorkers: ["w3", "w4", "w5"] });
		finishManagerBoot(runtime, teamId);
		const hub = runtime.takeNextActivation(teamId)!;
		const peers = runtime.listWorks(teamId).filter((work) => work.assignee !== "w1").map((work) => work.work);
		yieldWork(runtime, hub, "hub-wait", { waitingFor: peers, checkpoint: "waiting for everyone" });
		const facts = runtime.panelFacts(teamId);
		assert.equal(facts.stalled.get("w1"), "waiting on w2 (queued), w3 (queued), w4 (queued) +1 more", "peers in creation order, three named");
		assert.equal(facts.waitingFor, "w1 (waiting on w2, w3, w4 +1 more)");
		// The codec sorts waitingFor by WorkRef (here w3, w4, w5, w2); the timeline names them in creation order, like the panel.
		assert.ok(facts.timeline.some((entry) => /^w1 ended \S+ \S+ \(waiting on w2, w3, w4 \+1 more\)$/u.test(entry.text)));
	}
});

test("panel facts: a parent lists its unresolved sub-tasks, and a question shows what it asks and who answers it", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "parent" }], { extraWorkers: ["w3"] });
	finishManagerBoot(runtime, teamId);
	const parent = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, parent);
	const children = [request(runtime, parent, 1, "w2", "part for w2"), request(runtime, parent, 2, "w3", "part for w3")];
	assert.equal(action(runtime, parent, 3, "parent-wait", { action: "yield", waitingFor: children, checkpoint: "collect both parts" }).ok, true);
	settle(runtime, parent, "parent-wait");
	assert.equal(runtime.panelFacts(teamId).stalled.get("w1"), "waiting on 2 sub-tasks: w2 (queued), w3 (queued)");

	const first = runtime.takeNextActivation(teamId)!;
	const second = runtime.takeNextActivation(teamId)!;
	assert.equal(runtime.panelFacts(teamId).stalled.get("w1"), "waiting on 2 sub-tasks: w2 (running), w3 (running)");
	yieldWork(runtime, second, "w3-asks", { attention: "Which branch\nshould I diff?", checkpoint: "stopped before diffing" });
	assert.equal(runtime.panelFacts(teamId).stalled.has("w1"), false, "the parent is queued to answer the held sub-task, no longer stalled");
	assert.equal(runtime.panelFacts(teamId).stalled.get("w3"), 'held · asks: "Which branch should I diff?" · for w1',
		"a sub-task's question is answered by its requester, on one line");
	yieldWork(runtime, first, "w2-asks", { attention: "Need credentials for the staging cluster. ".repeat(6), checkpoint: "stopped before deploying" });
	const long = runtime.panelFacts(teamId).stalled.get("w2")!;
	assert.match(long, /^held · asks: "Need credentials for the staging cluster\. .*…" · for w1$/u);
	assert.ok(long.length < 130, "a long question is cut to about 80 characters");
	assert.equal(runtime.takeNextActivation(teamId)!.scope.kind, "work", "the waiting parent, not the lead, is woken for both questions");
});

test("panel facts: a root's question is queued for the lead, then handled, then left open", () => {
	const { runtime, teamId } = makeRuntime();
	finishManagerBoot(runtime, teamId);
	yieldWork(runtime, runtime.takeNextActivation(teamId)!, "w1-asks", { attention: "Which branch\nshould I diff?", checkpoint: "stopped before diffing" });
	assert.equal(runtime.panelFacts(teamId).stalled.get("w1"), 'held · asks: "Which branch should I diff?" · queued for lead',
		"a question nobody has picked up yet is queued for the lead, on one line");
	const manager = runtime.takeNextActivation(teamId)!;
	assert.equal(manager.scope.kind, "events");
	inputReady(runtime, manager);
	assert.equal(runtime.panelFacts(teamId).stalled.get("w1"), 'held · asks: "Which branch should I diff?" · lead handling',
		"the lead's current activation holds the WORK_HELD event");
	assert.equal(action(runtime, manager, 1, "manager-yield", { action: "yield" }).ok, true);
	settle(runtime, manager, "manager-yield");
	assert.equal(runtime.panelFacts(teamId).stalled.get("w1"), 'held · asks: "Which branch should I diff?"',
		"a question the lead has already seen and left open is not called queued");
});

test("panel facts: budget, protocol and Manager-unavailable holds say why they are held", () => {
	{
		const { runtime, teamId } = makeRuntime(undefined, { limits: { teamActivations: 1 } });
		inputReady(runtime, runtime.takeNextActivation(teamId)!);
		assert.equal(runtime.takeNextActivation(teamId), undefined, "the Manager consumed the only activation, so w1's root is budget-held");
		assert.equal(runtime.panelFacts(teamId).stalled.get("w1"), "held · budget teamActivations exhausted");
	}
	{
		const { runtime, teamId } = makeRuntime(undefined, { limits: { activationModelRequests: 1 } });
		finishManagerBoot(runtime, teamId);
		const worker = runtime.takeNextActivation(teamId)!;
		inputReady(runtime, worker);
		assert.deepEqual(runtime.gate(worker.binding, worker.scope, "provider_gate"), { allow: true });
		assert.equal(runtime.gate(worker.binding, worker.scope, "provider_gate").allow, false);
		runtime.nativeSettled(worker.binding, worker.scope.activationId, { status: "aborted" });
		runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true });
		assert.equal(runtime.getWork(teamId, workRef(worker))?.current.hold?.reason, "budget");
		assert.equal(runtime.panelFacts(teamId).stalled.get("w1"), "held · budget exhausted", "a per-activation limit has no Team or root counter to name");
	}
	{
		const { runtime, teamId } = makeRuntime();
		finishManagerBoot(runtime, teamId);
		const worker = runtime.takeNextActivation(teamId)!;
		inputReady(runtime, worker);
		settle(runtime, worker);
		assert.equal(runtime.panelFacts(teamId).stalled.get("w1"), "held · protocol: Native work ended without a valid reply or yield");
	}
});

test("panel facts: work held for budget or protocol is named in the Team's waiting reason even when nobody is running or waiting", () => {
	{
		const { runtime, teamId } = makeRuntime(undefined, { limits: { teamActivations: 1 } });
		finishManagerBoot(runtime, teamId);
		assert.equal(runtime.takeNextActivation(teamId), undefined, "the Manager's boot used the only activation, so w1's root is budget-held");
		assert.equal(runtime.panelFacts(teamId).waitingFor, "w1 (held: budget exhausted)");
	}
	{
		const { runtime, teamId } = makeRuntime([{ to: "w1", task: "first root" }, { to: "w2", task: "second root" }]);
		finishManagerBoot(runtime, teamId);
		const first = runtime.takeNextActivation(teamId)!;
		const second = runtime.takeNextActivation(teamId)!;
		inputReady(runtime, first);
		settle(runtime, first);
		assert.equal(runtime.panelFacts(teamId).waitingFor, "w2 (running) · w1 (held: protocol)", "a held member is listed after those running");
		reply(runtime, second, "second-reply", "second done");
		assert.equal(runtime.panelFacts(teamId).waitingFor, "w1 (held: protocol)", "and alone once nobody is running");
	}
});

test("panel facts: the Manager's current activation names the event kinds it is handling", () => {
	assert.equal(handlingText([{ kind: "A" }, { kind: "B" }, { kind: "A" }, { kind: "C" }, { kind: "D" }, { kind: "E" }]), "handling A, B, C +2 more",
		"kinds are distinct and at most three are named");
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "first root" }, { to: "w2", task: "second root" }]);
	assert.equal(runtime.panelFacts(teamId).leadHandling, undefined, "nothing is handled before an activation starts");
	const boot = runtime.takeNextActivation(teamId)!;
	assert.equal(runtime.panelFacts(teamId).leadHandling, "handling BOOT");
	finishIdle(runtime, boot);
	assert.equal(runtime.panelFacts(teamId).leadHandling, undefined, "and nothing once it has settled");
	const first = runtime.takeNextActivation(teamId)!;
	const second = runtime.takeNextActivation(teamId)!;
	reply(runtime, first, "first-reply", "first done");
	yieldWork(runtime, second, "second-asks", { attention: "which scope?", checkpoint: "stopped" });
	const manager = runtime.takeNextActivation(teamId)!;
	assert.equal(manager.scope.kind, "events");
	assert.equal(runtime.panelFacts(teamId).leadHandling, "handling ROOT_RESULT_READY, WORK_HELD, TEAM_QUIESCENT");
});

test("panel facts: an active Team waits for questions, then Manager review, then its close, else for whoever is working", () => {
	{
		const { runtime, teamId } = makeRuntime([{ to: "w1", task: "first root" }, { to: "w2", task: "second root" }]);
		assert.equal(runtime.panelFacts(teamId).waitingFor, undefined, "nothing is running yet");
		const boot = runtime.takeNextActivation(teamId)!;
		assert.equal(runtime.panelFacts(teamId).waitingFor, "lead (running)");
		inputReady(runtime, boot);
		assert.equal(action(runtime, boot, 1, "boot-yield", { action: "yield" }).ok, true);
		settle(runtime, boot, "boot-yield");
		const first = runtime.takeNextActivation(teamId)!;
		const second = runtime.takeNextActivation(teamId)!;
		assert.equal(runtime.panelFacts(teamId).waitingFor, "w1, w2 (running)");
		reply(runtime, first, "first-reply", "first done");
		assert.equal(runtime.panelFacts(teamId).waitingFor, "w2 (running)", "a root is still open, so no review is due yet");
		reply(runtime, second, "second-reply", "second done");
		assert.equal(runtime.panelFacts(teamId).waitingFor, "Lead review of 2 results");

		const manager = runtime.takeNextActivation(teamId)!;
		inputReady(runtime, manager);
		const accept = (activation: RuntimeActivation, sequence: number) => assert.equal(action(runtime, manager, sequence, `accept-${sequence}`,
			{ action: "control", command: "accept_result", work: workRef(activation), disposition: "accepted", reason: "ok" }).ok, true);
		accept(first, 1);
		assert.equal(runtime.panelFacts(teamId).waitingFor, "Lead review of 1 result");
		accept(second, 2);
		assert.equal(runtime.panelFacts(teamId).waitingFor, "Lead: all roots accepted; decide the next step or close");
		const resultRefs = [first, second].map((activation) => runtime.getWork(teamId, workRef(activation))!.current.resultRef!);
		assert.equal(action(runtime, manager, 3, "close", { action: "control", command: "close_team", resultRefs, outcome: "succeeded" }).ok, true);
		assert.equal(runtime.getTeam(teamId).lifecycle, "closing");
		assert.equal(runtime.panelFacts(teamId).waitingFor, undefined, "a Team that is closing is not waiting for anything");
	}
	{
		const { runtime, teamId } = makeRuntime(["w1", "w2", "w3"].map((to) => ({ to, task: `root of ${to}` })), { extraWorkers: ["w3"] });
		finishManagerBoot(runtime, teamId);
		const askers = [runtime.takeNextActivation(teamId)!, runtime.takeNextActivation(teamId)!, runtime.takeNextActivation(teamId)!];
		yieldWork(runtime, askers[0]!, "ask-1", { attention: "scope?", checkpoint: "stopped" });
		assert.equal(runtime.panelFacts(teamId).waitingFor, "Lead decision on w1's question");
		yieldWork(runtime, askers[1]!, "ask-2", { attention: "gate?", checkpoint: "stopped" });
		assert.equal(runtime.panelFacts(teamId).waitingFor, "Lead decisions on w1's and w2's questions");
		yieldWork(runtime, askers[2]!, "ask-3", { attention: "budget?", checkpoint: "stopped" });
		assert.equal(runtime.panelFacts(teamId).waitingFor, "Lead decisions on 3 questions");
	}
	{
		const { runtime, teamId } = makeRuntime([]);
		finishIdle(runtime, runtime.takeNextActivation(teamId)!);
		assert.equal(runtime.panelFacts(teamId).waitingFor, undefined, "a Team without roots has nothing to review or close yet");
	}
});

test("P: prepare rejects initial per-member overflow before reserving a Team or changing live state", () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `prepare-${++ids}`, limits: { memberUnresolvedWork: 1 } });
	const active = runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "lead",
		brief: { goal: "Existing Team." }, timeoutSeconds: null,
	});
	runtime.launch(active.teamId);
	const before = runtime.getTeam(active.teamId);
	const idsBefore = ids;
	assert.throws(() => runtime.prepare({
		members: [{ alias: "other", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "other",
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
	const forged = { ...manager.binding, memberId: "w1" };
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
	assert.equal(host.message_lead("pause w1").actor, "@host");
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

	host.message_lead("resume w1");
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
	const runtime = new TeamRuntime({ createId: () => `pause-${++ids}`, limits: { workPermits: 1 } });
	const prepared = runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage work." }, { alias: "w1", roleDescription: "First worker." }, { alias: "w2", roleDescription: "Second worker." }], lead: "lead",
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
	runtime.hostControl(prepared.teamId).message_lead("pause w1 at its next safe point");
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
	runtime.hostControl(prepared.teamId).message_lead("resume w1 after w2 releases the permit");
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
		members: [{ alias: "lead", roleDescription: "Manage work." }, { alias: "w1", roleDescription: "Perform assigned work." }], lead: "lead",
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
	runtime.hostControl(teamId).message_lead("pause active w1");
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
	runtime.hostControl(teamId).message_lead("pause w1 while provider settles");
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
	runtime.hostControl(teamId).message_lead("revise the active v1");
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
	assert.equal(v2ResultManager.scope.kind, "events");
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
	runtime.hostControl(teamId).message_lead("probe stale revision protection");
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
	runtime.hostControl(teamId).message_lead("cancel only the selected root subtree");
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
	assert.equal(next?.scope.kind, "events", "the manager can observe the incident; the failed worker is not stuck holding a permit");
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
		members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "lead",
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
		members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "lead",
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
		members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "lead",
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

test("processStats cancelled matches current cancelled/superseded works, not historical revisions", () => {
	const { runtime, teamId } = makeRuntime();
	const manager = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, manager);
	const parent = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, parent);
	assert.equal(action(runtime, parent, 1, "child", { action: "request", to: "w2", task: "unfinished child" }).ok, true);
	const root = workRef(parent);
	assert.equal(action(runtime, manager, 1, "revise-parent", {
		action: "control", command: "revise_work", workId: root.workId, expectedRevision: 1, task: "replacement",
	}).ok, true);
	assert.equal(runtime.processStats(teamId).cancelled, 1, "only the child's CURRENT superseded version counts");
	assert.equal(runtime.processStats(teamId).cancelled, runtime.getTeam(teamId).works.cancelled);
	assert.equal(action(runtime, manager, 2, "cancel-parent", {
		action: "control", command: "cancel_work", workId: root.workId, expectedRevision: 2, reason: "stop",
	}).ok, true);
	assert.equal(runtime.processStats(teamId).cancelled, 2);
	assert.equal(runtime.processStats(teamId).cancelled, runtime.getTeam(teamId).works.cancelled);
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
	assert.equal(runtime.panelFacts(teamId).stalled.has("w1"), false, "the cancelled dependency is terminal, so the panel has no one to name for the blocked parent");
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
	assert.equal(manager.scope.kind, "events");
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
	assert.equal(manager.scope.kind, "events");
	const heldEvent = manager.input.scope.kind === "events" ? manager.input.scope.events.find((event) => event.incidentId) : undefined;
	assert.equal(heldEvent?.kind, "WORK_HELD", "a protocol hold asks the Manager for a decision like any held work");
	assert.match(heldEvent?.message ?? "", /without a valid reply or yield/u);
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
	assert.equal(manager.scope.kind, "events");
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

test("C04/G10: hold release rejects lead_unavailable and any release while the Manager is faulted, atomically", () => {
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
	runtime.hostControl(teamId).message_lead("review the held work");
	const manager = runtime.takeNextActivation(teamId)!;
	assert.equal(manager.scope.kind, "events");
	inputReady(runtime, manager);
	runtime.nativeSettled(manager.binding, manager.scope.activationId, { status: "error", error: { code: "UPSTREAM", message: "Manager provider failed" } });
	runtime.cleanupFinished(manager.binding, manager.scope.activationId, { ok: true });
	const team = runtime.getTeam(teamId);
	assert.equal(team.members.find((member) => member.id === "lead")?.lifecycle, "faulted");
	assert.equal(team.members.find((member) => member.id === "w2")?.pause, "requested", "the running worker is safety-paused, not aborted");
	const managerHold = runtime.getWork(teamId, managerWork)!.current.hold;
	assert.equal(managerHold?.reason, "lead_unavailable");
	assert.equal(runtime.panelFacts(teamId).stalled.get("lead"), "held · lead unavailable");
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
	const runtime = new TeamRuntime({ createId: () => `repause-${++ids}`, limits: { workPermits: 1 } });
	const prepared = runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage work." }, { alias: "w1", roleDescription: "Parked worker." }, { alias: "w2", roleDescription: "Permit holder." }], lead: "lead",
		brief: { goal: "Exercise resume/pause races at a parked gate." },
		initialRequests: [{ to: "w1", task: "parked work" }, { to: "w2", task: "permit work" }],
		timeoutSeconds: null,
	});
	const teamId = prepared.teamId;
	runtime.launch(teamId);
	finishManagerBoot(runtime, teamId);
	const parked = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, parked);
	runtime.hostControl(teamId).message_lead("pause w1");
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
	runtime.hostControl(teamId).message_lead("pause w1");
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
	runtime.hostControl(teamId).message_lead("close now");
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
		members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "lead",
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
	runtime.hostControl(teamId).message_lead("cancel the target");
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

test("prepare takes members plus a lead pointer; the retired manager/workers shape is refused with a migration message", () => {
	const members = [{ alias: "lead", roleDescription: "Coordinate." }, { alias: "w1", roleDescription: "Work." }];
	const brief = { goal: "Plan shapes." };
	// The lead is a pointer, not a position or a name.
	const plan = normalizeTeamPlan({ members, lead: "w1", brief });
	assert.equal(plan.lead, "w1");
	assert.deepEqual(plan.members.map((member) => member.alias), ["lead", "w1"]);
	assert.deepEqual(normalizeTeamPlan({ members: [{ ...members[0]!, tools: [] }, { ...members[1]!, tools: ["read"] }], lead: "lead", brief }).members.map((member) => member.policy.tools),
		[[], ["read"]], "tools is an allowlist; an empty one is valid");

	const migration = /manager\/workers were replaced by members plus lead: <alias>/u;
	assert.throws(() => normalizeTeamPlan({ manager: members[0], workers: [members[1]], brief }), migration);
	assert.throws(() => normalizeTeamPlan({ members, lead: "lead", workers: [], brief }), migration, "a leftover retired field is refused too");
	assert.throws(() => normalizeTeamPlan({ coordinator: members[0], workers: [members[1]], brief }), migration);

	assert.throws(() => normalizeTeamPlan({ members, brief }), /lead/u);
	assert.throws(() => normalizeTeamPlan({ members, lead: "ghost", brief }), /lead must be the alias of one of the members/u);
	assert.throws(() => normalizeTeamPlan({ members: [members[0]], lead: "lead", brief }), /members must list 2-9 members/u);
	assert.throws(() => normalizeTeamPlan({ members: Array.from({ length: 10 }, (_, index) => ({ alias: `m${index}`, roleDescription: "Work." })), lead: "m0", brief }), /at most 9/u);
	assert.throws(() => normalizeTeamPlan({ members: [members[0], { ...members[0]! }], lead: "lead", brief }), /unique/u);
	assert.throws(() => normalizeTeamPlan({ members: [{ ...members[0]!, tools: ["read", "read"] }, members[1]], lead: "lead", brief }), /duplicate tool names/u);
	assert.throws(() => normalizeTeamPlan({ members, lead: "lead", brief, initialRequests: [{ to: "lead", task: "x" }] }), /must not be the lead/u);
	assert.throws(() => normalizeTeamPlan({ members, lead: "lead", brief, initialRequests: [{ to: "ghost", task: "x" }] }), /must name a member/u);
	assert.equal(normalizeTeamPlan({ members, lead: "lead", brief, initialRequests: [{ to: "w1", task: "x" }] }).initialRequests[0]!.to, "w1");

	// The runtime follows the pointer: the first member is not special, and the lead requests the initial work.
	const runtime = new TeamRuntime({ createId: (() => { let count = 0; return () => `p${++count}`; })() });
	const prepared = runtime.prepare({ members, lead: "w1", brief, initialRequests: [{ to: "lead", task: "Work for the member named lead." }] });
	assert.equal(prepared.lead, "w1");
	assert.equal(runtime.listWorks(prepared.teamId)[0]!.requester, "w1");
	runtime.launch(prepared.teamId);
	const boot = runtime.takeNextActivation(prepared.teamId)!;
	assert.equal(boot.binding.memberId, "w1");
	assert.equal(boot.scope.kind, "events");
	assert.equal(boot.input.member.lead, true);
	assert.deepEqual(boot.input.roster.map((entry) => [entry.id, entry.lead]), [["lead", undefined], ["w1", true]]);
	inputReady(runtime, boot);
	assert.equal(code(action(runtime, boot, 1, "pause-lead", { action: "control", command: "pause_member", memberId: "w1" })), "FORBIDDEN_ACTION", "the lead is never paused");
	assert.equal(code(action(runtime, boot, 2, "close-lead", { action: "control", command: "close_member", memberId: "w1" })), "FORBIDDEN_ACTION");
	assert.equal(code(action(runtime, boot, 3, "pause-ghost", { action: "control", command: "pause_member", memberId: "ghost" })), "UNKNOWN_MEMBER");
	assert.equal(code(action(runtime, boot, 4, "pause-other", { action: "control", command: "pause_member", memberId: "lead" })), undefined, "any other member can be paused");
});

test("the lead takes a work request from another member as a work activation, and its pending Team events are processed first", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "first root" }, { to: "w2", task: "second root" }]);
	finishManagerBoot(runtime, teamId);
	const w1 = runtime.takeNextActivation(teamId)!;
	const w2 = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, w1);
	const asked = action(runtime, w1, 1, "ask-lead", { action: "request", to: "lead", task: "Decide which fixture to use." });
	assert.ok(asked.ok && asked.receipt?.status === "accepted" && asked.receipt.recipient === "lead", JSON.stringify(asked));
	const child = asked.receipt.work;
	const record = runtime.getWork(teamId, child)!;
	assert.deepEqual([record.requester, record.assignee, record.parent], ["w1", "lead", w1.scope.work], "the lead is an ordinary assignee of a sub-task");
	assert.equal(action(runtime, w1, 2, "wait-lead", { action: "yield", waitingFor: [child], checkpoint: "waiting for the lead" }).ok, true);
	settle(runtime, w1, "wait-lead");
	reply(runtime, w2, "w2-reply", "second done");

	// The lead has a queued work and a pending Team event (w2's root result): the event comes first.
	const events = runtime.takeNextActivation(teamId)!;
	assert.equal(events.scope.kind, "events");
	assert.equal(events.binding.memberId, "lead");
	assert.ok(events.input.scope.kind === "events" && events.input.scope.events.some((event) => event.kind === "ROOT_RESULT_READY"));
	inputReady(runtime, events);
	assert.equal(action(runtime, events, 1, "events-yield", { action: "yield" }).ok, true);
	settle(runtime, events, "events-yield");
	assert.equal(runtime.panelFacts(teamId).pendingEvents, 0, "the event batch was processed");

	const work = runtime.takeNextActivation(teamId)!;
	assert.equal(work.scope.kind, "work");
	assert.equal(work.binding.memberId, "lead");
	assert.equal(work.input.member.lead, true, "the lead is still the lead while it works");
	assert.ok(work.input.scope.kind === "work" && work.input.scope.requester === "w1" && work.input.scope.task === "Decide which fixture to use."
		&& work.input.scope.parent?.workId === w1.scope.work!.workId);
	assert.match(work.input.notice, /^Current work: /u, "a work activation of the lead carries the work notice, not the events notice");
	reply(runtime, work, "lead-reply", "Use fixture A.");
	const woken = runtime.takeNextActivation(teamId)!;
	assert.equal(woken.binding.memberId, "w1");
	assert.deepEqual(woken.input.outcomes.map((outcome) => outcome.work), [child], "the requester receives the lead's result like any other member's");
	runtime.assertInvariants(teamId);
});

test("workPermits bounds work activations of every member, the lead's included; the lead's event activation has its own slot", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "root" }], { limits: { workPermits: 1 } });
	finishManagerBoot(runtime, teamId);
	const w1 = runtime.takeNextActivation(teamId)!;
	inputReady(runtime, w1);
	const toLead = action(runtime, w1, 1, "to-lead", { action: "request", to: "lead", task: "lead sub-task" });
	const toW2 = action(runtime, w1, 2, "to-w2", { action: "request", to: "w2", task: "w2 sub-task" });
	assert.ok(toLead.ok && toLead.receipt?.status === "accepted" && toW2.ok && toW2.receipt?.status === "accepted");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "w1 holds the only work permit");

	// An event for the lead does not need a work permit.
	runtime.hostControl(teamId).message_lead("check in");
	const events = runtime.takeNextActivation(teamId)!;
	assert.equal(events.scope.kind, "events");
	inputReady(runtime, events);
	assert.equal(action(runtime, events, 1, "events-yield", { action: "yield" }).ok, true);
	settle(runtime, events, "events-yield");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "still no permit for the queued sub-tasks");

	assert.equal(action(runtime, w1, 3, "wait-both", { action: "yield", waitingFor: [toLead.receipt.work, toW2.receipt.work], checkpoint: "waiting" }).ok, true);
	settle(runtime, w1, "wait-both");
	const leadWork = runtime.takeNextActivation(teamId)!;
	assert.equal(leadWork.scope.kind, "work");
	assert.equal(leadWork.binding.memberId, "lead", "FIFO: the lead's sub-task was requested first");
	inputReady(runtime, leadWork);
	assert.equal(runtime.takeNextActivation(teamId), undefined, "the lead's work activation holds the permit, so w2's work waits");
	runtime.assertInvariants(teamId);
	assert.equal(action(runtime, leadWork, 1, "lead-reply", { action: "reply", result: { status: "succeeded", summary: "done" } }).ok, true);
	settle(runtime, leadWork, "lead-reply");
	const w2Work = runtime.takeNextActivation(teamId)!;
	assert.equal(w2Work.binding.memberId, "w2", "the permit freed by the lead's work goes to the next member");
});
