import assert from "node:assert/strict";
import { test } from "node:test";
import { flowRows, flowStats, newFlow, pushFlow } from "../../tools/subagents/team-flow";
import { TEAM_JOURNAL_ENTRY_TYPE, TeamJournalGeneration, type TeamJournalRecord } from "../../tools/subagents/team-journal";
import { restoreTeamHistory } from "../../tools/subagents/team-history";
import type { TeamBudgetLimits, WorkRef } from "../../tools/subagents/team-protocol";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A Team on an injected clock: `clock.at` is milliseconds since the start. */
function world(options: { members?: string[]; initial?: Array<{ to: string; task: string }>; limits?: Partial<TeamBudgetLimits>; review?: unknown; journal?: TeamJournalGeneration; launchAt?: number } = {}) {
	let ids = 0;
	const origin = 1_700_000_000_000;
	const clock = { at: 0 };
	const runtime = new TeamRuntime({ now: () => origin + clock.at, createId: () => `id${++ids}`, ...(options.limits ? { limits: options.limits } : {}), ...(options.journal ? { journal: options.journal } : {}) });
	const { teamId } = runtime.prepare({
		members: ["lead", ...(options.members ?? ["w1", "w2", "w3"])].map((alias) => ({ alias, roleDescription: `Member ${alias}.` })), lead: "lead",
		brief: { goal: "Measure the flow." }, initialRequests: options.initial ?? [{ to: "w1", task: "Root." }], timeoutSeconds: null,
		...("review" in options ? { review: options.review } : {}),
	});
	clock.at = options.launchAt ?? 0;
	runtime.launch(teamId);
	const sequences = new WeakMap<RuntimeActivation, number>();
	const act = (activation: RuntimeActivation, args: unknown) => {
		const sequence = (sequences.get(activation) ?? 0) + 1;
		sequences.set(activation, sequence);
		const reply = runtime.handleAction(activation.binding, activation.scope, sequence, `call-${sequence}`, args, `call-${sequence}`);
		assert.equal(reply.ok, true, JSON.stringify(reply));
		return reply;
	};
	const settle = (activation: RuntimeActivation) => {
		assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: `call-${sequences.get(activation)}` }).ok, true);
		assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
	};
	const end = (activation: RuntimeActivation, args: unknown) => { act(activation, args); settle(activation); };
	const take = () => {
		const activation = runtime.takeNextActivation(teamId)!;
		assert.ok(activation);
		assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
		return activation;
	};
	/** The next activation of `member`; lead notices on the way are answered at once with a bare yield. */
	const takeFor = (member: string) => {
		for (;;) {
			const activation = take();
			if (activation.binding.memberId === member) return activation;
			assert.equal(activation.scope.kind, "events");
			end(activation, { action: "yield" });
		}
	};
	const reply = (activation: RuntimeActivation) => end(activation, { action: "reply", result: { status: "succeeded", summary: "Done." } });
	const request = (activation: RuntimeActivation, to: string): WorkRef => (act(activation, { action: "request", to, task: `Task for ${to}.` }) as any).receipt.work;
	return { runtime, teamId, clock, act, settle, end, take, takeFor, reply, request, stats: () => runtime.flowStats(teamId) };
}

test("flow shares: only-lead excludes the lead's overlap with workers, and all-slots counts time at the permit limit", () => {
	const w = world({ limits: { workPermits: 1 } });
	const boot = w.take();
	w.clock.at = 10 * SECOND;
	w.end(boot, { action: "yield" });
	const work = w.take();
	w.clock.at = 20 * SECOND;
	w.runtime.messageLead(w.teamId, "ping");
	const overlap = w.take();
	assert.equal(overlap.binding.memberId, "lead");
	w.clock.at = 30 * SECOND;
	w.end(overlap, { action: "yield" });
	w.clock.at = 40 * SECOND;
	w.reply(work);
	const closing = w.take();
	assert.equal(closing.binding.memberId, "lead");
	w.clock.at = 60 * SECOND;
	w.end(closing, { action: "yield" });
	const stats = w.stats();
	assert.equal(stats.activeMs, 60 * SECOND);
	assert.equal(stats.workersAvg, 0.5, "w1 ran 30 of 60 seconds");
	assert.equal(stats.leadBusyShare, 40 / 60, "lead: 10 + 10 + 20 seconds");
	assert.equal(stats.onlyLeadShare, 0.5, "the 10 seconds beside w1 are not only-lead: 10 + 20 seconds");
	assert.equal(stats.allSlotsShare, 0.5, "the single permit was held 30 seconds; the lead's events activation holds none");
	assert.equal(stats.slotLimit, 1);
});

test("start delay is recorded once per version (not on resume) and never for review works", () => {
	const w = world({ review: { by: "w3", everyMinutes: 60 } });
	w.end(w.take(), { action: "yield" });
	w.clock.at = 7 * SECOND;
	const root = w.takeFor("w1");
	const child = w.request(root, "w2");
	w.end(root, { action: "yield", waitingFor: [child], checkpoint: "Wait for w2." });
	w.clock.at = 8 * SECOND;
	w.reply(w.takeFor("w2"));
	w.clock.at = 58 * SECOND;
	w.reply(w.takeFor("w1"));
	const stats = w.stats();
	assert.equal(stats.startP50, 1 * SECOND, "the child started 1s after its creation");
	assert.equal(stats.startP90, 7 * SECOND, "the root 7s; the resumed activation 58s later is no new start");
	w.clock.at = 100 * SECOND;
	assert.ok(w.runtime.reviewNow(w.teamId).work);
	w.clock.at = 190 * SECOND;
	w.reply(w.takeFor("w3"));
	assert.equal(w.stats().startP90, 7 * SECOND, "the review started 90s after its creation and is not measured");
});

test("dependency waits end at outcome readiness; resume queueing is separate from the last dependency", () => {
	const w = world();
	w.end(w.take(), { action: "yield" });
	const root = w.takeFor("w1");
	const [a, b] = [w.request(root, "w2"), w.request(root, "w3")];
	w.clock.at = 10 * SECOND;
	w.end(root, { action: "yield", waitingFor: [a, b], checkpoint: "Wait for both." });
	const [second, third] = [w.takeFor("w2"), w.takeFor("w3")];
	w.clock.at = 100 * SECOND;
	w.reply(second);
	w.clock.at = 200 * SECOND;
	w.reply(third);
	assert.equal(w.stats().waitP90, 190 * SECOND, "the sample is complete before w1 restarts");
	w.clock.at = 215 * SECOND;
	assert.equal(w.stats().queued?.oldestMs, 15 * SECOND);
	w.clock.at = 230 * SECOND;
	const resumed = w.takeFor("w1");
	const c = w.request(resumed, "w2");
	w.end(resumed, { action: "yield", waitingFor: [c], checkpoint: "Wait for w2." });
	const again = w.takeFor("w2");
	w.clock.at = 260 * SECOND;
	w.reply(again);
	w.clock.at = 270 * SECOND;
	w.reply(w.takeFor("w1"));
	const stats = w.stats();
	assert.deepEqual(stats.waited, [{ member: "w3", count: 1, ms: 190 * SECOND }, { member: "w2", count: 1, ms: 30 * SECOND }],
		"w3 finished last at 200s, 190s after yield; the extra 30s to restart belongs to the ready queue");
	assert.equal(stats.waitP50, 30 * SECOND);
	assert.equal(stats.waitP90, 190 * SECOND);
	assert.equal(stats.resumeP50, 10 * SECOND);
	assert.equal(stats.resumeP90, 30 * SECOND);
});

test("accept latency runs from the committed root result to accept_result", () => {
	const w = world({ initial: [{ to: "w1", task: "First." }, { to: "w1", task: "Second." }] });
	w.end(w.take(), { action: "yield" });
	w.clock.at = 10 * SECOND;
	const first = w.takeFor("w1");
	w.reply(first);
	w.clock.at = 20 * SECOND;
	const second = w.takeFor("w1");
	w.reply(second);
	w.clock.at = 70 * SECOND;
	const lead = w.take();
	assert.equal(lead.binding.memberId, "lead");
	w.act(lead, { action: "control", command: "accept_result", work: first.scope.work, disposition: "accepted", reason: "ok" });
	w.clock.at = 170 * SECOND;
	w.act(lead, { action: "control", command: "accept_result", work: second.scope.work, disposition: "accepted", reason: "ok" });
	const stats = w.stats();
	assert.equal(stats.acceptP50, 60 * SECOND, "10s → 70s");
	assert.equal(stats.acceptP90, 150 * SECOND, "20s → 170s");
});

test("the last-10-minutes average reads minute buckets and survives an idle gap longer than the ring", () => {
	const w = world({ initial: [{ to: "w1", task: "a" }, { to: "w1", task: "b" }, { to: "w2", task: "c" }] });
	w.end(w.take(), { action: "yield" });
	const a = w.takeFor("w1");
	w.clock.at = 20 * MINUTE;
	w.reply(a);
	const [b, c] = [w.takeFor("w1"), w.takeFor("w2")];
	w.clock.at = 30 * MINUTE;
	let stats = w.stats();
	assert.equal(stats.workersAvg, (20 + 2 * 10) / 30, "w1 alone for 20 minutes, then two workers for 10");
	assert.equal(stats.workersRecent, 2, "the last 10 minutes only saw two workers");
	w.reply(b);
	w.reply(c);
	w.clock.at = 30 * MINUTE + 3 * 60 * MINUTE;
	stats = w.stats();
	assert.equal(stats.workersRecent, 0, "three idle hours later the ring holds nothing but idle minutes");
	assert.equal(stats.workersAvg, 40 / 210);
});

test("the bounded arrays keep the newest 1000 values", () => {
	const flow = newFlow(0);
	for (let value = 1; value <= 1005; value++) pushFlow(flow.startDelays, value);
	assert.equal(flow.startDelays.length, 1000);
	const stats = flowStats(flow, 0, { slotLimit: 4, pausedMs: 0, queued: undefined, pendingEvents: 0, tokensPerWork: undefined, context: undefined });
	assert.equal(stats.startP50, 505, "newest 6..1005, not the oldest 1..1000 (500)");
	assert.equal(stats.startP90, 905);
});

test("the terminal journal record carries the flow summary and history restores it; records without it still load", () => {
	const records: TeamJournalRecord[] = [];
	const w = world({ journal: new TeamJournalGeneration((record) => records.push(record)) });
	w.end(w.take(), { action: "yield" });
	w.clock.at = 10 * SECOND;
	const root = w.takeFor("w1");
	w.reply(root);
	w.clock.at = 20 * SECOND;
	const lead = w.take();
	const resultRef = w.runtime.getWork(w.teamId, root.scope.work!)!.current.resultRef!;
	w.act(lead, { action: "control", command: "accept_result", work: root.scope.work, disposition: "accepted" });
	const closed = w.act(lead, { action: "control", command: "close_team", resultRefs: [resultRef], outcome: "succeeded" });
	w.settle(lead);
	const closeId = closed.ok && closed.receipt?.status === "closing" ? closed.receipt.closeId : undefined;
	for (const member of ["lead", "w1", "w2", "w3"]) w.runtime.memberReleased(w.runtime.bindingForDriver(w.teamId, member), closeId!, { ok: true });
	assert.equal(w.runtime.getTeam(w.teamId).lifecycle, "closed");
	const terminal = records.find((record) => record.kind === "terminal")!;
	assert.ok(terminal && terminal.kind === "terminal");
	assert.match(terminal.flow ?? "", /^workers avg \S+ · only lead \S+ · ready first p90 \S+ · ready resume p90 \S+ · deps p90 \S+ · last dependency: /u);
	const entries = (list: TeamJournalRecord[]) => list.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data }));
	assert.equal(restoreTeamHistory(entries(records)).teams[0]?.flow, terminal.flow);
	const { flow: _flow, ...bare } = terminal;
	const history = restoreTeamHistory(entries(records.map((record) => record === terminal ? bare : record)));
	assert.equal(history.skipped, 0);
	assert.equal(history.teams[0]?.lifecycle, "closed");
	assert.equal(history.teams[0]?.flow, undefined);
});


test("first-ready time excludes preparation and host pauses, including a live pause with no intermediate reads", () => {
	const w = world({ launchAt: 10 * MINUTE });
	w.end(w.take(), { action: "yield" });
	w.clock.at += 10 * SECOND;
	w.runtime.pauseTeam(w.teamId);
	w.clock.at += 20 * MINUTE;
	const paused = w.stats();
	assert.equal(paused.queued?.oldestMs, 10 * SECOND);
	assert.equal(paused.queued?.reason, "host paused");
	assert.equal(paused.pausedMs, 20 * MINUTE);
	assert.equal(paused.warn.queue, false, "a pause cannot create a queue warning");
	w.runtime.continueTeam(w.teamId);
	w.clock.at += 10 * SECOND;
	w.reply(w.takeFor("w1"));
	assert.equal(w.stats().startP90, 20 * SECOND);
	assert.match(w.runtime.panelFacts(w.teamId).timeline.map((item) => item.text).join("\n"), /started .*\(ready 0:20\)/u);
});

test("ready wait excludes member pauses without resetting time already queued; current reason is not slots full", () => {
	const w = world({ limits: { workPermits: 1 } });
	const lead = w.take();
	w.clock.at = 10 * SECOND;
	w.act(lead, { action: "control", command: "pause_member", memberId: "w1" });
	// A different member occupies the only work permit while w1 is explicitly paused.
	w.request(lead, "w2");
	const busy = w.takeFor("w2");
	w.clock.at = 20 * MINUTE;
	assert.equal(w.stats().queued?.oldestMs, 10 * SECOND);
	assert.equal(w.stats().queued?.reason, "member paused");
	w.act(lead, { action: "control", command: "resume_member", memberId: "w1" });
	w.clock.at += 10 * SECOND;
	w.reply(busy);
	w.reply(w.takeFor("w1"));
	assert.equal(w.stats().startP90, 20 * SECOND);
});

test("a queued work's budget hold is not ready time and a grant preserves its earlier ready wait", () => {
	const w = world({ limits: { teamActivations: 1 } });
	w.end(w.take(), { action: "yield" });
	w.clock.at = 10 * SECOND;
	assert.equal(w.runtime.takeNextActivation(w.teamId), undefined);
	assert.equal(w.runtime.listWorks(w.teamId)[0]!.hold, "budget");
	w.clock.at = 20 * MINUTE;
	w.runtime.hostControl(w.teamId).grant({ kind: "team" }, { teamActivations: 10 }, "Continue.");
	w.clock.at += 10 * SECOND;
	w.reply(w.takeFor("w1"));
	assert.equal(w.stats().startP90, 20 * SECOND);
});

test("host pauses are excluded from dependency, resumed-ready and acceptance elapsed times", () => {
	const w = world();
	w.end(w.take(), { action: "yield" });
	const root = w.takeFor("w1");
	const child = w.request(root, "w2");
	w.clock.at = 10 * SECOND;
	w.end(root, { action: "yield", waitingFor: [child], checkpoint: "Wait." });
	const worker = w.takeFor("w2");
	w.clock.at = 30 * SECOND;
	w.runtime.pauseTeam(w.teamId);
	w.clock.at = 1030 * SECOND;
	w.runtime.continueTeam(w.teamId);
	w.clock.at = 1050 * SECOND;
	w.reply(worker);
	w.clock.at = 1070 * SECOND;
	w.reply(w.takeFor("w1"));
	w.clock.at = 1080 * SECOND;
	w.runtime.pauseTeam(w.teamId);
	w.clock.at = 2080 * SECOND;
	w.runtime.continueTeam(w.teamId);
	w.clock.at = 2090 * SECOND;
	const lead = w.take();
	w.act(lead, { action: "control", command: "accept_result", work: root.scope.work, disposition: "accepted" });
	const stats = w.stats();
	assert.equal(stats.waitP90, 40 * SECOND);
	assert.equal(stats.resumeP90, 20 * SECOND);
	assert.equal(stats.acceptP90, 20 * SECOND);
	assert.equal(stats.pausedMs, 2000 * SECOND);
	assert.match(flowRows(stats).lead, /accept active p50 20s/u);
	assert.match(flowRows(stats).waits, /deps p50 40s.*last: w2/u);
});

test("a result committed while the host is paused starts acceptance time at the frozen active clock", () => {
	const w = world();
	w.end(w.take(), { action: "yield" });
	const root = w.takeFor("w1");
	w.clock.at = 10 * SECOND;
	w.runtime.pauseTeam(w.teamId);
	w.clock.at = 500 * SECOND;
	w.reply(root); // Already-issued work may settle while the host is paused.
	w.clock.at = 1010 * SECOND;
	w.runtime.continueTeam(w.teamId);
	w.clock.at = 1020 * SECOND;
	const lead = w.take();
	w.act(lead, { action: "control", command: "accept_result", work: root.scope.work, disposition: "accepted" });
	assert.equal(w.stats().acceptP90, 10 * SECOND);
});

test("reviewing an earlier dependency cannot change which dependency became deliverable last", () => {
	const w = world({ initial: [{ to: "w1", task: "Consumer." }, { to: "w2", task: "First dependency." }, { to: "w3", task: "Last dependency." }] });
	const lead = w.take();
	const [consumer, first, last] = [w.takeFor("w1"), w.takeFor("w2"), w.takeFor("w3")];
	w.clock.at = 10 * SECOND;
	w.end(consumer, { action: "yield", waitingFor: [first.scope.work, last.scope.work], checkpoint: "Wait." });
	w.clock.at = 100 * SECOND;
	w.reply(first);
	w.clock.at = 200 * SECOND;
	w.reply(last);
	w.clock.at = 220 * SECOND;
	w.act(lead, { action: "control", command: "accept_result", work: first.scope.work, disposition: "accepted" });
	w.clock.at = 230 * SECOND;
	w.reply(w.takeFor("w1"));
	assert.deepEqual(w.stats().waited, [{ member: "w3", count: 1, ms: 190 * SECOND }]);
});

test("a child issue interrupts a dependency wait without inventing a completed wait or charging resume queueing to the child", () => {
	const w = world();
	w.end(w.take(), { action: "yield" });
	const root = w.takeFor("w1");
	const child = w.request(root, "w2");
	w.clock.at = 10 * SECOND;
	w.end(root, { action: "yield", waitingFor: [child], checkpoint: "Wait." });
	const worker = w.takeFor("w2");
	w.clock.at = 50 * SECOND;
	w.end(worker, { action: "yield", attention: "Need a decision.", checkpoint: "Blocked." });
	w.clock.at = 70 * SECOND;
	const resumed = w.takeFor("w1");
	assert.equal(w.stats().waitP90, undefined);
	assert.equal(w.stats().resumeP90, 20 * SECOND);
	w.end(resumed, { action: "yield", attention: "Ask lead.", checkpoint: "Need help." });
});

test("parked member activations do not count as workers busy and resuming counts exactly once", async () => {
	const w = world({ limits: { workPermits: 1 } });
	const lead = w.take();
	const root = w.takeFor("w1");
	w.clock.at = 10 * SECOND;
	w.act(lead, { action: "control", command: "pause_member", memberId: "w1" });
	const gate = w.runtime.waitAtProviderGate(root.binding, root.scope);
	w.clock.at = 110 * SECOND;
	assert.equal(w.stats().workersAvg, 10 / 110);
	assert.equal(w.stats().allSlotsShare, 10 / 110);
	w.act(lead, { action: "control", command: "resume_member", memberId: "w1" });
	assert.equal((await gate).allow, true);
	w.clock.at = 120 * SECOND;
	w.reply(root);
	const stats = w.stats();
	assert.equal(stats.workersAvg, 20 / 120);
	assert.equal(stats.allSlotsShare, 20 / 120);
	assert.equal(stats.onlyLeadShare, 100 / 120);
});


test("dependency readiness includes native cleanup after cancellation, not just the terminal timestamp", () => {
	const w = world();
	const lead = w.take();
	const root = w.takeFor("w1");
	const child = w.request(root, "w2");
	w.clock.at = 10 * SECOND;
	w.end(root, { action: "yield", waitingFor: [child], checkpoint: "Wait." });
	const worker = w.takeFor("w2");
	w.clock.at = 50 * SECOND;
	w.act(lead, { action: "control", command: "cancel_work", workId: child.workId, expectedRevision: child.revision, reason: "Stop." });
	w.clock.at = 60 * SECOND;
	assert.equal(w.runtime.nativeSettled(worker.binding, worker.scope.activationId, { status: "aborted" }).ok, true);
	assert.equal(w.stats().waitP90, undefined, "a terminal but uncleaned dependency is not deliverable");
	w.clock.at = 100 * SECOND;
	assert.equal(w.runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true }).ok, true);
	assert.equal(w.stats().waitP90, 90 * SECOND);
});

test("an outcome-unknown dependency is not presented as an ordinary completed dependency wait", () => {
	const w = world();
	w.end(w.take(), { action: "yield" });
	const root = w.takeFor("w1");
	const child = w.request(root, "w2");
	w.clock.at = 10 * SECOND;
	w.end(root, { action: "yield", waitingFor: [child], checkpoint: "Wait." });
	const worker = w.takeFor("w2");
	w.clock.at = 50 * SECOND;
	assert.equal(w.runtime.activationLost(worker.binding, worker.scope.activationId, {
		code: "NATIVE_OUTCOME_UNKNOWN", message: "Connection lost.", outcomeUnknown: true,
	}, true).ok, true);
	assert.equal(w.stats().waitP90, undefined);
	assert.deepEqual(w.stats().waited, []);
});

test("host pause totals freeze at Team termination instead of growing on history reads", () => {
	const w = world();
	w.clock.at = 10 * SECOND;
	w.runtime.pauseTeam(w.teamId);
	w.clock.at = 100 * SECOND;
	w.runtime.cancelTeam(w.teamId, "Stop.");
	assert.equal(w.stats().pausedMs, 90 * SECOND);
	w.clock.at = 1000 * SECOND;
	assert.equal(w.stats().pausedMs, 90 * SECOND);
});
