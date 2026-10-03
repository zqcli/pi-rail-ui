import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreTeamHistory } from "../../tools/subagents/team-history";
import { TEAM_JOURNAL_ENTRY_TYPE, TeamJournalGeneration, type TeamJournalRecord } from "../../tools/subagents/team-journal";
import { TeamProtocolError } from "../../tools/subagents/team-codec";
import type { WorkRef } from "../../tools/subagents/team-protocol";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";

const MEMBERS = ["lead", "w1", "w2"].map((alias) => ({ alias, roleDescription: `Member ${alias}.` }));

function world(options: { initial?: Array<{ to: string; task: string }>; review?: unknown; journal?: TeamJournalGeneration; claim?: string[] } = {}) {
	let ids = 0;
	let time = 1_700_000_000_000;
	const runtime = new TeamRuntime({ now: () => time, createId: () => `id${++ids}`, ...(options.journal ? { journal: options.journal } : {}) });
	const { teamId } = runtime.prepare({
		members: MEMBERS, lead: "lead", brief: { goal: "Ship the feature." }, initialRequests: options.initial ?? [], timeoutSeconds: null,
		review: "review" in options ? options.review : { by: "w2", everyMinutes: 60 },
	});
	for (const alias of options.claim ?? []) runtime.claimNativeLifetime(teamId, alias);
	runtime.launch(teamId);
	return { runtime, teamId, advance: (ms: number) => { time += ms; } };
}

const sequences = new WeakMap<RuntimeActivation, number>();
function act(runtime: TeamRuntime, activation: RuntimeActivation, args: unknown) {
	const sequence = (sequences.get(activation) ?? 0) + 1;
	sequences.set(activation, sequence);
	return runtime.handleAction(activation.binding, activation.scope, sequence, `call-${sequence}`, args, `call-${sequence}`);
}
const errorOf = (reply: ReturnType<typeof act>) => reply.ok ? undefined : reply.error;

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

const bootIdle = (runtime: TeamRuntime, teamId: string) => end(runtime, take(runtime, teamId), { action: "yield" });
const eventsOf = (activation: RuntimeActivation) => activation.input.scope.kind === "events" ? activation.input.scope.events : [];

/** The next activation of `member`; Team notices for the lead on the way are answered with a bare yield. */
function takeFor(runtime: TeamRuntime, teamId: string, member: string): RuntimeActivation {
	for (;;) {
		const activation = take(runtime, teamId);
		if (activation.binding.memberId === member) return activation;
		if (activation.scope.kind === "events") end(runtime, activation, { action: "yield" });
	}
}

/** Let the reviewer answer the open review with `summary`. */
function answerReview(runtime: TeamRuntime, teamId: string, summary: string, extra: Record<string, unknown> = {}): void {
	end(runtime, takeFor(runtime, teamId, "w2"), { action: "reply", result: { status: "succeeded", summary, ...extra } });
}

/** w1 finishes its root so that something changed. */
function finishRoot(runtime: TeamRuntime, teamId: string): WorkRef {
	const work = takeFor(runtime, teamId, "w1");
	end(runtime, work, { action: "reply", result: { status: "succeeded", summary: "Root done." } });
	return work.scope.work!;
}

test("prepare: review.by must be a member other than the lead, the interval is 1..1440 whole minutes, and the default is none", () => {
	const plan = (review?: unknown) => ({ members: MEMBERS, lead: "lead", brief: { goal: "g" }, ...(review === undefined ? {} : { review }) });
	const rejects = (review: unknown, pattern: RegExp) => assert.throws(() => new TeamRuntime().prepare(plan(review)),
		(error) => error instanceof TeamProtocolError && error.code === "INVALID_ARGUMENT" && pattern.test(error.message));
	rejects({ by: "lead", everyMinutes: 60 }, /other than the lead/u);
	rejects({ by: "ghost", everyMinutes: 60 }, /other than the lead/u);
	rejects({ by: "w2", everyMinutes: 0 }, /integer from 1 to 1440/u);
	rejects({ by: "w2", everyMinutes: 1441 }, /integer from 1 to 1440/u);
	rejects({ by: "w2", everyMinutes: 1.5 }, /integer/u);
	rejects({ by: "w2" }, /everyMinutes/u);
	rejects({ by: "w2", everyMinutes: 5, extra: 1 }, /unsupported/u);
	const runtime = new TeamRuntime();
	const none = runtime.prepare(plan(undefined)).teamId;
	assert.equal(runtime.reviewSchedule(none), undefined);
	assert.equal(runtime.prepare(plan(null)).teamId.length > 0, true);
	const edge = runtime.prepare(plan({ by: "w2", everyMinutes: 1440 })).teamId;
	assert.deepEqual(runtime.reviewSchedule(edge), { by: "w2", everyMinutes: 1440, nextAt: null }, "the timer starts at launch");
});

test("the interval timer runs a due review and re-arms; stopping the Team clears it", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }] });
	assert.equal(runtime.reviewSchedule(teamId)?.nextAt, 1_700_000_000_000 + 60 * 60_000);
	bootIdle(runtime, teamId);
	t.mock.timers.tick(60 * 60_000);
	const review = runtime.listWorks(teamId).filter((work) => work.kind === "review");
	assert.equal(review.length, 1, "the tick started a review for the changed Team");
	t.mock.timers.tick(60 * 60_000);
	assert.equal(runtime.listWorks(teamId).filter((work) => work.kind === "review").length, 1, "the next tick skips: the review is still open");
	runtime.cancelTeam(teamId, "stop");
	assert.equal(runtime.reviewSchedule(teamId)?.nextAt, null);
	t.mock.timers.tick(60 * 60_000);
	assert.equal(runtime.listWorks(teamId).filter((work) => work.kind === "review").length, 1, "a stopped Team starts no review");
});

test("a tick creates a review work for the reviewer, requested by the lead, with the snapshot and instructions as its task", () => {
	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(runtime, teamId);
	const ref = runtime.runReviewTick(teamId);
	assert.ok(ref);
	const work = runtime.getWork(teamId, ref)!;
	assert.equal(work.requester, "lead");
	assert.equal(work.assignee, "w2");
	assert.equal(work.parent, undefined);
	const task = work.current.task;
	assert.ok(Buffer.byteLength(task) <= 16 * 1024);
	assert.match(task, /^Team progress review · elapsed 0 min\nGoal: Ship the feature\./u);
	assert.match(task, /Works \(reviews excluded\): 1 total · resolved 0 · running 0/u);
	assert.match(task, /- w1 · /u);
	assert.match(task, /Previous review: none/u);
	assert.match(task, /Budget: teamActivations \d+% \(\d+\/\d+\)/u);
	assert.match(task, /You only advise: do not request or control work\..*summary must start with 'ON TRACK:', 'AT RISK:' or 'OFF TRACK:'/su);
	assert.match(task, /- ON TRACK: .*no lead action is needed\.\n- AT RISK: a concrete problem .*budget above 80%.*\n- OFF TRACK: the work contradicts the brief's constraints/u);
	assert.match(task, /Not a risk: planned waits, a result just committed/u);
	assert.match(task, /Without concrete evidence report ON TRACK\./u);
	assert.equal(runtime.listWorks(teamId).find((item) => item.work.workId === ref.workId)?.kind, "review");
	runtime.assertInvariants(teamId);
});

test("the snapshot carries the Flow, Lead and Waits facts with one line saying they are not a risk by themselves", () => {
	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(runtime, teamId);
	const task = runtime.getWork(teamId, runtime.runReviewTick(teamId)!)!.current.task;
	assert.match(task, /^Flow: workers avg \S+ \(last 10m \S+\) · all 4 slots busy \S+$/mu);
	assert.match(task, /^Lead: busy \S+ · only lead \S+ · accept p50 \S+ · p90 \S+ · \d+ pending$/mu);
	assert.match(task, /^Waits: p50 \S+ · p90 \S+ · most: \S+/mu);
	assert.match(task, /^The Flow, Lead and Waits numbers locate bottlenecks .*not a risk by themselves\.$/mu);
});

test("ticks skip when nothing changed, a review is open, or the lead or reviewer is not open; review now ignores the unchanged skip", () => {
	const empty = world();
	bootIdle(empty.runtime, empty.teamId);
	assert.equal(empty.runtime.runReviewTick(empty.teamId), undefined, "no work has been created");
	const now = empty.runtime.reviewNow(empty.teamId);
	assert.equal(now.status, "applied");
	assert.throws(() => empty.runtime.reviewNow(empty.teamId), /a review is still open/u);
	assert.equal(empty.runtime.runReviewTick(empty.teamId), undefined, "a review is open");

	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(runtime, teamId);
	const root = takeFor(runtime, teamId, "w1");
	assert.ok(runtime.runReviewTick(teamId));
	answerReview(runtime, teamId, "ON TRACK: fine.");
	assert.equal(runtime.runReviewTick(teamId), undefined, "nothing changed since the review");
	assert.ok(runtime.reviewNow(teamId).work, "now ignores that skip");
	answerReview(runtime, teamId, "ON TRACK: still fine.");
	end(runtime, root, { action: "reply", result: { status: "succeeded", summary: "Root done." } });
	assert.ok(runtime.runReviewTick(teamId), "a work finished since the last review");
	answerReview(runtime, teamId, "ON TRACK: done.");

	const reviewerLeads = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(reviewerLeads.runtime, reviewerLeads.teamId);
	reviewerLeads.runtime.handoverLead(reviewerLeads.teamId, "w2");
	assert.equal(reviewerLeads.runtime.runReviewTick(reviewerLeads.teamId), undefined, "the reviewer became the lead");

	const noLead = world({ initial: [{ to: "w1", task: "Build it." }], claim: ["lead"] });
	bootIdle(noLead.runtime, noLead.teamId);
	noLead.runtime.hostStopMember(noLead.teamId, "lead", "stopped");
	assert.equal(noLead.runtime.runReviewTick(noLead.teamId), undefined, "the lead is not open");
	assert.throws(() => noLead.runtime.reviewNow(noLead.teamId), /the lead is not open/u);

	const noReviewer = world({ initial: [{ to: "w1", task: "Build it." }], claim: ["w2"] });
	bootIdle(noReviewer.runtime, noReviewer.teamId);
	noReviewer.runtime.hostStopMember(noReviewer.teamId, "w2", "stopped");
	assert.equal(noReviewer.runtime.runReviewTick(noReviewer.teamId), undefined, "the reviewer is not open");
});

test("request and control are refused inside a review work; status and reply stay available", () => {
	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(runtime, teamId);
	const ref = runtime.reviewNow(teamId).work;
	const review = takeFor(runtime, teamId, "w2");
	assert.deepEqual(review.scope.work, ref);
	for (const args of [
		{ action: "request", to: "w1", task: "Do more." },
		{ action: "control", command: "cancel_work", workId: ref.workId, expectedRevision: 1, reason: "no" },
		{ action: "control", command: "pause_member", memberId: "w1" },
	]) {
		const error = errorOf(act(runtime, review, args));
		assert.equal(error?.code, "FORBIDDEN_ACTION");
		assert.match(error!.message, /A review only advises/u);
	}
	assert.equal(act(runtime, review, { action: "status", view: "team" }).ok, true);
	assert.equal(act(runtime, review, { action: "reply", result: { status: "succeeded", summary: "OFF TRACK: nothing moves." } }).ok, true);
});

test("a committed review sends REVIEW_READY with the full result to the lead and stores a record with the parsed verdict", () => {
	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(runtime, teamId);
	runtime.runReviewTick(teamId);
	const ref = runtime.listWorks(teamId).find((work) => work.kind === "review")!.work;
	take(runtime, teamId); // w1 starts its root and stays running
	const review = takeFor(runtime, teamId, "w2");
	end(runtime, review, { action: "reply", result: { status: "partial", summary: "at risk: w1 has not reported.", findings: ["Ask w1 for a checkpoint (work:abc)."], limitations: ["Could not read its files."] } });
	const resultRef = runtime.getWork(teamId, ref)!.current.resultRef!;

	const [record] = runtime.listReviews(teamId);
	assert.match(record!.id, /^review:/u);
	assert.equal(record!.by, "w2");
	assert.deepEqual(record!.work, ref);
	assert.equal(record!.resultRef, resultRef);
	assert.equal(record!.status, "partial");
	assert.equal(record!.verdict, "at_risk", "the prefix is case-insensitive");
	assert.deepEqual(record!.findings, ["Ask w1 for a checkpoint (work:abc)."]);
	assert.deepEqual(record!.limitations, ["Could not read its files."]);
	assert.equal(record!.snapshot.works.total, 1);
	assert.ok(record!.snapshot.budget.some((entry) => entry.counter === "teamActivations"));

	const lead = takeFor(runtime, teamId, "lead");
	const events = eventsOf(lead).filter((event) => event.kind === "REVIEW_READY");
	assert.equal(events.length, 1);
	assert.equal(events[0]!.resultRef, resultRef);
	assert.deepEqual(events[0]!.work, ref);
	assert.match(events[0]!.message, /Periodic review .* from w2, result .* It is advice only:/u);
	assert.match(events[0]!.message, /at risk: w1 has not reported\.[\s\S]*Ask w1 for a checkpoint[\s\S]*Could not read its files\./u);
	assert.match(lead.input.notice, /A REVIEW_READY event is advice from the reviewer about a risk or an unclear review \(an ON TRACK review sends none\): decide whether to act on it \(request, revise_work, cancel_work, or nothing\); it needs no reply\./u);
	assert.equal(eventsOf(lead).some((event) => event.kind === "ROOT_RESULT_READY"), false, "a review is not a root result");
	assert.equal(act(runtime, lead, { action: "status", view: "work", id: ref.workId }).ok, true);
	end(runtime, lead, { action: "yield" });

	// The next review sees the previous one; a summary without a verdict prefix stores none.
	runtime.reviewNow(teamId);
	assert.match(runtime.getWork(teamId, runtime.listWorks(teamId).filter((work) => work.kind === "review")[1]!.work)!.current.task, /Previous review: AT RISK — at risk: w1 has not reported\./u);
	answerReview(runtime, teamId, "Looks fine to me.");
	assert.equal(runtime.listReviews(teamId)[1]!.verdict, undefined);
});

test("a failed review is recorded as failed and a held review's question goes to the lead", () => {
	const failed = world({ initial: [] });
	bootIdle(failed.runtime, failed.teamId);
	failed.runtime.reviewNow(failed.teamId);
	const run = takeFor(failed.runtime, failed.teamId, "w2");
	assert.equal(failed.runtime.nativeSettled(run.binding, run.scope.activationId, { status: "error", error: { code: "NATIVE_FAILURE", message: "boom" } }).ok, true);
	assert.equal(failed.runtime.cleanupFinished(run.binding, run.scope.activationId, { ok: true }).ok, true);
	assert.deepEqual(failed.runtime.listReviews(failed.teamId).map(({ status, summary, resultRef }) => ({ status, summary, resultRef })), [{ status: "failed", summary: "boom", resultRef: undefined }]);
	assert.ok(eventsOf(takeFor(failed.runtime, failed.teamId, "lead")).some((event) => event.kind === "MEMBER_FAULTED"));

	const held = world({ initial: [] });
	bootIdle(held.runtime, held.teamId);
	held.runtime.reviewNow(held.teamId);
	end(held.runtime, takeFor(held.runtime, held.teamId, "w2"), { action: "yield", attention: "Which repo?", checkpoint: "asked" });
	assert.ok(eventsOf(takeFor(held.runtime, held.teamId, "lead")).some((event) => event.kind === "WORK_HELD" && /Which repo/u.test(event.message)));
});

test("a review never blocks close_team: a running or held one is cancelled at close", () => {
	for (const running of [true, false]) {
		const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }] });
		bootIdle(runtime, teamId);
		const root = finishRoot(runtime, teamId);
		const resultRef = runtime.getWork(teamId, root)!.current.resultRef!;
		const lead = takeFor(runtime, teamId, "lead");
		assert.equal(act(runtime, lead, { action: "control", command: "accept_result", work: root, disposition: "accepted" }).ok, true);
		end(runtime, lead, { action: "yield" });
		const ref = runtime.reviewNow(teamId).work;
		const reviewer = takeFor(runtime, teamId, "w2");
		if (!running) end(runtime, reviewer, { action: "yield", attention: "Which repo?", checkpoint: "asked" });
		if (running) runtime.messageLead(teamId, "wrap up");
		const closer = takeFor(runtime, teamId, "lead");
		const closed = act(runtime, closer, { action: "control", command: "close_team", resultRefs: [resultRef], outcome: "succeeded" });
		assert.equal(closed.ok, true, JSON.stringify(closed));
		assert.equal(runtime.getWork(teamId, ref)!.current.state, "cancelled");
		assert.equal(runtime.reviewSchedule(teamId)?.nextAt, null, "the timer stops at close");
		assert.equal(runtime.getTeam(teamId).lifecycle, "closing");
		assert.deepEqual(runtime.listReviews(teamId), [], "a cancelled review stores no record");
		const closeId = closed.ok && closed.receipt?.status === "closing" ? closed.receipt.closeId : undefined;
		settle(runtime, closer);
		if (running) {
			assert.equal(runtime.nativeSettled(reviewer.binding, reviewer.scope.activationId, { status: "aborted" }).ok, true);
			assert.equal(runtime.cleanupFinished(reviewer.binding, reviewer.scope.activationId, { ok: true }).ok, true);
		}
		for (const member of ["w1", "w2", "lead"]) assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, member), closeId!, { ok: true }).ok, true);
		assert.equal(runtime.getTeam(teamId).lifecycle, "closed");
		assert.deepEqual(runtime.getTeamResult(teamId)!.roots.map((entry) => entry.work), [root], "the review is not a root of the final result");
		runtime.assertInvariants(teamId);
	}
});

test("review works are not deliverables: root counts, Waiting for, process stats and root review ignore them", () => {
	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(runtime, teamId);
	finishRoot(runtime, teamId);
	const stats = runtime.processStats(teamId);
	runtime.reviewNow(teamId);
	assert.deepEqual({ works: runtime.processStats(teamId).works, roots: runtime.processStats(teamId).roots }, { works: stats.works, roots: stats.roots });
	const view = runtime.getTeam(teamId);
	assert.deepEqual({ roots: view.works.roots, total: view.works.total }, { roots: 1, total: 2 });
	assert.equal(runtime.inspectBudget(teamId).roots.length, 1);
	const reviewRef = runtime.listWorks(teamId).find((work) => work.kind === "review")!.work;
	const reviewer = takeFor(runtime, teamId, "w2");
	assert.equal(runtime.panelFacts(teamId).waitingFor, "Lead review of 1 result", "a running review is not what the Team waits for");
	end(runtime, reviewer, { action: "reply", result: { status: "succeeded", summary: "AT RISK: w1 is slow." } });
	assert.equal(runtime.processStats(teamId).results, stats.results, "the review result is not a deliverable result");
	const lead = takeFor(runtime, teamId, "lead");
	const refused = errorOf(act(runtime, lead, { action: "control", command: "accept_result", work: reviewRef, disposition: "accepted" }));
	assert.equal(refused?.code, "INVALID_ARGUMENT");
	assert.equal(runtime.getTeam(teamId).works.rootsReviewed, 0);

	const idle = world();
	bootIdle(idle.runtime, idle.teamId);
	idle.runtime.reviewNow(idle.teamId);
	takeFor(idle.runtime, idle.teamId, "w2");
	assert.equal(idle.runtime.panelFacts(idle.teamId).waitingFor, undefined, "the reviewer running a review is not a reason the Team has not finished");
	assert.equal(idle.runtime.getTeam(idle.teamId).works.roots, 0);
});

test("review schedule changes: set, change reviewer, off, validation, and the interval restarts", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { runtime, teamId } = world({ review: null });
	assert.equal(runtime.reviewSchedule(teamId), undefined);
	assert.throws(() => runtime.setReview(teamId, { everyMinutes: 30 }), /Name the reviewer/u);
	assert.throws(() => runtime.setReview(teamId, { by: "lead", everyMinutes: 30 }), /other than the lead/u);
	assert.throws(() => runtime.setReview(teamId, { by: "w1", everyMinutes: 2000 }), /integer from 1 to 1440/u);
	assert.equal(runtime.setReview(teamId, { by: "w1", everyMinutes: 30 }).status, "applied");
	assert.deepEqual(runtime.reviewSchedule(teamId), { by: "w1", everyMinutes: 30, nextAt: 1_700_000_000_000 + 30 * 60_000 });
	assert.equal(runtime.setReview(teamId, { everyMinutes: 30 }).status, "unchanged");
	assert.equal(runtime.setReview(teamId, { everyMinutes: 10 }).status, "applied");
	assert.equal(runtime.reviewSchedule(teamId)?.by, "w1", "without by the reviewer stays");
	assert.equal(runtime.setReview(teamId, null).status, "applied");
	assert.equal(runtime.reviewSchedule(teamId), undefined);
	assert.throws(() => runtime.reviewNow(teamId), /no reviewer is set/u);
	runtime.cancelTeam(teamId, "done");
	assert.throws(() => runtime.setReview(teamId, null), /Team is cancelled/u);
});

test("the journal gives history the reviews and the schedule of a closed Team", () => {
	const records: TeamJournalRecord[] = [];
	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }], journal: new TeamJournalGeneration((record) => records.push(record)) });
	bootIdle(runtime, teamId);
	const root = finishRoot(runtime, teamId);
	const resultRef = runtime.getWork(teamId, root)!.current.resultRef!;
	runtime.reviewNow(teamId);
	answerReview(runtime, teamId, "OFF TRACK: no tests.", { findings: ["Add tests."] });
	runtime.setReview(teamId, { by: "w1", everyMinutes: 15 });
	const lead = takeFor(runtime, teamId, "lead");
	assert.equal(act(runtime, lead, { action: "control", command: "accept_result", work: root, disposition: "accepted" }).ok, true);
	const closed = act(runtime, lead, { action: "control", command: "close_team", resultRefs: [resultRef], outcome: "succeeded" });
	assert.equal(closed.ok, true);
	settle(runtime, lead);
	const closeId = closed.ok && closed.receipt?.status === "closing" ? closed.receipt.closeId : undefined;
	for (const member of ["w1", "w2", "lead"]) runtime.memberReleased(runtime.bindingForDriver(teamId, member), closeId!, { ok: true });
	assert.equal(runtime.getTeam(teamId).lifecycle, "closed");

	assert.equal(records.filter((record) => record.kind === "review").length, 1);
	assert.deepEqual(records.filter((record) => record.kind === "review_schedule").map((record) => record.kind === "review_schedule" ? record.review : undefined), [{ by: "w1", everyMinutes: 15 }]);
	assert.deepEqual(records.find((record) => record.kind === "launched")!.kind === "launched" && (records.find((record) => record.kind === "launched") as { review?: unknown }).review, { by: "w2", everyMinutes: 60 });
	const restored = restoreTeamHistory(records.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data })));
	assert.equal(restored.skipped, 0);
	const entry = restored.teams[0]!;
	assert.equal(entry.lifecycle, "closed");
	assert.deepEqual(entry.review, { by: "w1", everyMinutes: 15 });
	assert.deepEqual(entry.reviews, runtime.listReviews(teamId));
	assert.equal(entry.reviews![0]!.verdict, "off_track");

	// A damaged review record is skipped without losing the rest of the history.
	const damaged = records.map((data) => data.kind === "review" ? { ...data, review: { ...data.review, by: "stranger" } } : data);
	assert.equal(restoreTeamHistory(damaged.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data }))).skipped, 1);
});

test("only AT RISK, OFF TRACK, a review without a verdict or a failed review wake the lead; ON TRACK is only recorded", () => {
	const { runtime, teamId } = world();
	bootIdle(runtime, teamId);
	runtime.reviewNow(teamId);
	answerReview(runtime, teamId, "ON TRACK: all planned waits.");
	assert.equal(runtime.listReviews(teamId)[0]!.verdict, "on_track", "the ON TRACK review is recorded");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "and creates no lead event");
	const wakes = [["succeeded", "AT RISK: w1 has been held for 40 min."], ["succeeded", "OFF TRACK: no work covers the goal."],
		["succeeded", "No verdict at all."], ["failed", "ON TRACK: contradicts its own status."]] as const;
	for (const [status, summary] of wakes) {
		runtime.reviewNow(teamId);
		end(runtime, takeFor(runtime, teamId, "w2"), { action: "reply", result: { status, summary } });
		const lead = take(runtime, teamId);
		assert.deepEqual(eventsOf(lead).map((event) => event.kind), ["REVIEW_READY"], summary);
		end(runtime, lead, { action: "yield" });
	}
});

test("the review snapshot carries hold age, lead state, queued events, progress counters and the snapshot time", () => {
	const quiet = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(quiet.runtime, quiet.teamId);
	end(quiet.runtime, take(quiet.runtime, quiet.teamId), { action: "yield", attention: "Which repo?", checkpoint: "asked" });
	quiet.advance(7 * 60_000);
	const task = (runtime: TeamRuntime, teamId: string, ref: WorkRef) => runtime.getWork(teamId, ref)!.current.task;
	const held = task(quiet.runtime, quiet.teamId, quiet.runtime.reviewNow(quiet.teamId).work);
	assert.match(held, /Snapshot taken at \d{4}-\d\d-\d\dT[\d:.]+Z\. It may be older than your activation; status shows the current state\./u);
	assert.match(held, /Lead: idle · Team events queued for the lead: 2\n/u);
	assert.match(held, /Held works:\n- \S+ w1 held 7 min \(attention\): .*Which repo\?/u);
	assert.match(held, /Last finished non-review work: none yet · consecutive reviews without finished work, including this one: 1\n/u);

	const busy = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(busy.runtime, busy.teamId);
	finishRoot(busy.runtime, busy.teamId);
	busy.advance(3 * 60_000);
	const lead = take(busy.runtime, busy.teamId);
	assert.equal(lead.scope.kind, "events");
	const progress = task(busy.runtime, busy.teamId, busy.runtime.reviewNow(busy.teamId).work);
	assert.match(progress, /Lead: active · Team events queued for the lead: 0\n/u);
	assert.match(progress, /Last finished non-review work: 3 min ago · consecutive reviews without finished work, including this one: 0\n/u);
	assert.match(progress, /Held works:\nnone/u);

	const idle = world();
	bootIdle(idle.runtime, idle.teamId);
	idle.runtime.reviewNow(idle.teamId);
	answerReview(idle.runtime, idle.teamId, "ON TRACK: nothing to do.");
	assert.match(task(idle.runtime, idle.teamId, idle.runtime.reviewNow(idle.teamId).work), /including this one: 2\n/u, "two consecutive reviews without a finished work");
});

test("review.focus is appended after the criteria, bounded to 1 KiB, and kept by review every", () => {
	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }], review: { by: "w2", everyMinutes: 60, focus: "  Watch the migration risk.  " } });
	bootIdle(runtime, teamId);
	assert.deepEqual(runtime.reviewSchedule(teamId), { by: "w2", everyMinutes: 60, focus: "Watch the migration risk.", nextAt: 1_700_000_000_000 + 60 * 60_000 });
	const task = runtime.getWork(teamId, runtime.reviewNow(teamId).work)!.current.task;
	assert.match(task, /Without concrete evidence report ON TRACK\.[\s\S]*\n\nGuidance from the Team's plan for this review[^\n]*\nWatch the migration risk\.$/u);
	assert.equal(runtime.setReview(teamId, { everyMinutes: 30 }).status, "applied");
	assert.equal(runtime.reviewSchedule(teamId)?.focus, "Watch the migration risk.", "review every N keeps the focus");
	assert.throws(() => new TeamRuntime().prepare({ members: MEMBERS, lead: "lead", brief: { goal: "g" }, review: { by: "w2", everyMinutes: 5, focus: "x".repeat(1025) } }), /focus/u);
	assert.equal(new TeamRuntime().prepare({ members: MEMBERS, lead: "lead", brief: { goal: "g" }, review: { by: "w2", everyMinutes: 5, focus: null } }).teamId.length > 0, true);
});

test("an unprocessed REVIEW_READY never blocks close_team", () => {
	const { runtime, teamId } = world({ initial: [{ to: "w1", task: "Build it." }] });
	bootIdle(runtime, teamId);
	const root = finishRoot(runtime, teamId);
	const resultRef = runtime.getWork(teamId, root)!.current.resultRef!;
	const lead = take(runtime, teamId);
	assert.equal(act(runtime, lead, { action: "control", command: "accept_result", work: root, disposition: "accepted" }).ok, true);
	runtime.reviewNow(teamId);
	end(runtime, take(runtime, teamId), { action: "reply", result: { status: "succeeded", summary: "AT RISK: arrived while the lead was already closing." } });
	assert.equal(runtime.panelFacts(teamId).pendingEvents, 1, "the REVIEW_READY is queued outside the lead's batch");
	const closed = act(runtime, lead, { action: "control", command: "close_team", resultRefs: [resultRef], outcome: "succeeded" });
	assert.equal(closed.ok, true, JSON.stringify(closed));
	assert.equal(runtime.getTeam(teamId).lifecycle, "closing");
});
