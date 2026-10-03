import assert from "node:assert/strict";
import { test } from "node:test";
import { flowStats, newFlow, pushFlow } from "../../tools/subagents/team-flow";
import { TEAM_JOURNAL_ENTRY_TYPE, TeamJournalGeneration, type TeamJournalRecord } from "../../tools/subagents/team-journal";
import { restoreTeamHistory } from "../../tools/subagents/team-history";
import type { TeamBudgetLimits, WorkRef } from "../../tools/subagents/team-protocol";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A Team on an injected clock: `clock.at` is milliseconds since the start. */
function world(options: { members?: string[]; initial?: Array<{ to: string; task: string }>; limits?: Partial<TeamBudgetLimits>; review?: unknown; journal?: TeamJournalGeneration } = {}) {
	let ids = 0;
	const origin = 1_700_000_000_000;
	const clock = { at: 0 };
	const runtime = new TeamRuntime({ now: () => origin + clock.at, createId: () => `id${++ids}`, ...(options.limits ? { limits: options.limits } : {}), ...(options.journal ? { journal: options.journal } : {}) });
	const { teamId } = runtime.prepare({
		members: ["lead", ...(options.members ?? ["w1", "w2", "w3"])].map((alias) => ({ alias, roleDescription: `Member ${alias}.` })), lead: "lead",
		brief: { goal: "Measure the flow." }, initialRequests: options.initial ?? [{ to: "w1", task: "Root." }], timeoutSeconds: null,
		...("review" in options ? { review: options.review } : {}),
	});
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

test("a dependency wait is charged to the waited member that finished last, from the yield to the next start", () => {
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
	assert.deepEqual(stats.waited, [{ member: "w3", count: 1, ms: 220 * SECOND }, { member: "w2", count: 1, ms: 40 * SECOND }],
		"w3 finished last of the first pair (220s from the yield at 10s to the restart at 230s); the second wait was on w2 alone");
	assert.equal(stats.waitP50, 40 * SECOND);
	assert.equal(stats.waitP90, 220 * SECOND);
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
	const stats = flowStats(flow, 0, { slotLimit: 4, queued: undefined, pendingEvents: 0, tokensPerWork: undefined, context: undefined });
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
	assert.match(terminal.flow ?? "", /^workers avg \S+ · only lead \S+ · start delay p90 \S+ · waits p90 \S+ · most waited: /u);
	const entries = (list: TeamJournalRecord[]) => list.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data }));
	assert.equal(restoreTeamHistory(entries(records)).teams[0]?.flow, terminal.flow);
	const { flow: _flow, ...bare } = terminal;
	const history = restoreTeamHistory(entries(records.map((record) => record === terminal ? bare : record)));
	assert.equal(history.skipped, 0);
	assert.equal(history.teams[0]?.lifecycle, "closed");
	assert.equal(history.teams[0]?.flow, undefined);
});
