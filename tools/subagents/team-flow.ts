/**
 * Flow metrics of a running Team (host display only): where time goes between the lead, the workers and the work
 * permits. Everything is updated incrementally and in O(1) per event with the Runtime's own clock; the arrays and the
 * minute ring are bounded, and only the Progress tab, the final text and the review snapshot read the statistics.
 */

/** Warning thresholds. They only color a row; nothing here ever changes Team behaviour. */
export const TEAM_FLOW_WARN = {
	/** Share of active time with only the lead running, judged once the Team has been active this long. */
	onlyLeadShare: 0.25,
	onlyLeadAfterMs: 5 * 60_000,
	startDelayP90Ms: 2 * 60_000,
	queuedOldestMs: 5 * 60_000,
	/** One member's share of all dependency waits, judged from this many waits. */
	waitedMemberShare: 0.5,
	waitedMinCount: 6,
	contextTokens: 200_000,
};

const MINUTE = 60_000;
const BOUND = 1000;
const RECENT_MINUTES = 10;

export interface FlowState {
	lastAt: number;
	/** Running non-lead activations, running lead activations (more than one only around a lead handover) and held work permits. */
	workers: number;
	leads: number;
	slots: number;
	activeMs: number;
	leadBusyMs: number;
	leadOnlyMs: number;
	/** Sum of workers × ms. */
	workerMs: number;
	allSlotsMs: number;
	/** Ring of the last 60 minutes. */
	buckets: Array<{ minute: number; workerMs: number; activeMs: number }>;
	/** Versions that already had their first activation. */
	started: Set<string>;
	startDelays: number[];
	/** Versions that yielded on dependencies: when, and on what. */
	waiting: Map<string, { since: number; refs: Array<{ workId: string; revision: number }> }>;
	waitDurations: number[];
	waitsByMember: Map<string, { count: number; ms: number }>;
	/** Committed root results awaiting the lead's accept/waive. */
	committedAt: Map<string, number>;
	acceptLatencies: number[];
}

export const newFlow = (at: number): FlowState => ({
	lastAt: at, workers: 0, leads: 0, slots: 0, activeMs: 0, leadBusyMs: 0, leadOnlyMs: 0, workerMs: 0, allSlotsMs: 0,
	buckets: Array.from({ length: 60 }, () => ({ minute: -1, workerMs: 0, activeMs: 0 })),
	started: new Set(), startDelays: [], waiting: new Map(), waitDurations: [], waitsByMember: new Map(), committedAt: new Map(), acceptLatencies: [],
});

/** Keep the newest BOUND values. */
export function pushFlow(values: number[], value: number): void {
	values.push(value);
	if (values.length > BOUND) values.shift();
}

/** Account the time since the last change with the state as it was; call before every change of workers, leads or slots. */
export function tickFlow(flow: FlowState, now: number, counting: boolean, slotLimit: number): void {
	const from = flow.lastAt;
	flow.lastAt = Math.max(from, now);
	if (!counting || now <= from) return;
	const ms = now - from;
	flow.activeMs += ms;
	flow.workerMs += flow.workers * ms;
	if (flow.leads) {
		flow.leadBusyMs += ms;
		if (!flow.workers) flow.leadOnlyMs += ms;
	}
	if (flow.slots >= slotLimit) flow.allSlotsMs += ms;
	// Older than the ring cannot be read back, so a long idle gap costs one pass over 60 buckets at most.
	for (let at = Math.max(from, now - 60 * MINUTE); at < now;) {
		const minute = Math.floor(at / MINUTE);
		const part = Math.min(now, (minute + 1) * MINUTE) - at;
		const bucket = flow.buckets[minute % 60]!;
		if (bucket.minute !== minute) Object.assign(bucket, { minute, workerMs: 0, activeMs: 0 });
		bucket.workerMs += flow.workers * part;
		bucket.activeMs += part;
		at += part;
	}
}

export interface TeamFlowStats {
	slotLimit: number;
	activeMs: number;
	workersAvg: number | undefined;
	workersRecent: number | undefined;
	allSlotsShare: number | undefined;
	leadBusyShare: number | undefined;
	onlyLeadShare: number | undefined;
	startP50: number | undefined;
	startP90: number | undefined;
	queued: { count: number; oldestMs: number; reason: string } | undefined;
	waitP50: number | undefined;
	waitP90: number | undefined;
	/** Top 3 by count. */
	waited: Array<{ member: string; count: number; ms: number }>;
	acceptP50: number | undefined;
	acceptP90: number | undefined;
	pendingEvents: number;
	tokensPerWork: number | undefined;
	context: { member: string; tokens: number } | undefined;
	/** The threshold of the Lead, Queue, Waits and Cost rows is crossed. */
	warn: { lead: boolean; queue: boolean; waits: boolean; cost: boolean };
}

function percentile(values: readonly number[], share: number): number | undefined {
	if (!values.length) return undefined;
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];
}

/** `extra` is what only the Runtime knows at read time: the queue, the pending events, the cost and the largest context. */
export function flowStats(flow: FlowState, now: number, extra: Pick<TeamFlowStats, "slotLimit" | "queued" | "pendingEvents" | "tokensPerWork" | "context">): TeamFlowStats {
	const share = (ms: number) => flow.activeMs ? ms / flow.activeMs : undefined;
	const recent = flow.buckets.filter((bucket) => bucket.minute > Math.floor(now / MINUTE) - RECENT_MINUTES);
	const recentActive = recent.reduce((sum, bucket) => sum + bucket.activeMs, 0);
	const waited = [...flow.waitsByMember].map(([member, { count, ms }]) => ({ member, count, ms })).sort((a, b) => b.count - a.count || b.ms - a.ms);
	const waits = waited.reduce((sum, item) => sum + item.count, 0);
	const startP90 = percentile(flow.startDelays, 0.9);
	const onlyLeadShare = share(flow.leadOnlyMs);
	return {
		...extra, activeMs: flow.activeMs,
		workersAvg: share(flow.workerMs),
		workersRecent: recentActive ? recent.reduce((sum, bucket) => sum + bucket.workerMs, 0) / recentActive : undefined,
		allSlotsShare: share(flow.allSlotsMs), leadBusyShare: share(flow.leadBusyMs), onlyLeadShare,
		startP50: percentile(flow.startDelays, 0.5), startP90,
		waitP50: percentile(flow.waitDurations, 0.5), waitP90: percentile(flow.waitDurations, 0.9),
		waited: waited.slice(0, 3),
		acceptP50: percentile(flow.acceptLatencies, 0.5), acceptP90: percentile(flow.acceptLatencies, 0.9),
		warn: {
			lead: (onlyLeadShare ?? 0) > TEAM_FLOW_WARN.onlyLeadShare && flow.activeMs >= TEAM_FLOW_WARN.onlyLeadAfterMs,
			queue: (startP90 ?? 0) > TEAM_FLOW_WARN.startDelayP90Ms || (extra.queued?.oldestMs ?? 0) > TEAM_FLOW_WARN.queuedOldestMs,
			waits: waits >= TEAM_FLOW_WARN.waitedMinCount && waited[0]!.count / waits > TEAM_FLOW_WARN.waitedMemberShare,
			cost: (extra.context?.tokens ?? 0) > TEAM_FLOW_WARN.contextTokens,
		},
	};
}

/** `40s`, `1.2m`, `42m`. */
export function flowDuration(ms: number | undefined): string {
	if (ms === undefined) return "—";
	if (ms < MINUTE) return `${Math.round(ms / 1000)}s`;
	return ms < 10 * MINUTE ? `${(ms / MINUTE).toFixed(1)}m` : `${Math.round(ms / MINUTE)}m`;
}
const percent = (value: number | undefined) => value === undefined ? "—" : `${Math.round(100 * value)}%`;
const decimal = (value: number | undefined) => value === undefined ? "—" : value.toFixed(1);
const tokens = (value: number) => value < 1000 ? String(value) : value < 1_000_000 ? `${Math.round(value / 1000)}k` : `${(value / 1_000_000).toFixed(1)}M`.replace(/\.0M$/u, "M");

/** The Progress rows (without their labels), each within 69 columns; also the Flow, Lead and Waits facts of a review snapshot. */
export function flowRows(stats: TeamFlowStats): { flow: string; lead: string; queue: string; waits: string; cost: string } {
	const waited = stats.waited.slice(0, 2).map(({ member, count, ms }) => `${member} ${count}× ${flowDuration(ms)}`).join(" · ") || "—";
	return {
		flow: `workers avg ${decimal(stats.workersAvg)} (last 10m ${decimal(stats.workersRecent)}) · all ${stats.slotLimit} slots busy ${percent(stats.allSlotsShare)}`,
		lead: `busy ${percent(stats.leadBusyShare)} · only lead ${percent(stats.onlyLeadShare)} · accept p50 ${flowDuration(stats.acceptP50)} · p90 ${flowDuration(stats.acceptP90)} · ${stats.pendingEvents} pending`,
		queue: `start p50 ${flowDuration(stats.startP50)} · p90 ${flowDuration(stats.startP90)} · ${stats.queued ? `${stats.queued.count} queued, oldest ${flowDuration(stats.queued.oldestMs)} (${stats.queued.reason})` : "none queued"}`,
		waits: `p50 ${flowDuration(stats.waitP50)} · p90 ${flowDuration(stats.waitP90)} · most: ${waited}`,
		cost: `${stats.tokensPerWork === undefined ? "—" : tokens(Math.round(stats.tokensPerWork))} tokens/finished work · largest context ${stats.context ? `${stats.context.member} ${tokens(stats.context.tokens)}` : "—"}`,
	};
}

/** The one-line summary kept in the final text and in history. */
export function flowSummary(stats: TeamFlowStats): string {
	const top = stats.waited[0];
	return `workers avg ${decimal(stats.workersAvg)} · only lead ${percent(stats.onlyLeadShare)} · start delay p90 ${flowDuration(stats.startP90)} · waits p90 ${flowDuration(stats.waitP90)} · most waited: ${top ? `${top.member} ${top.count}×` : "—"}`;
}

/** The legend row, from the thresholds; the popup wraps it where it is wider than the popup. */
export const flowLegend = (): string => `Warn: only lead >${percent(TEAM_FLOW_WARN.onlyLeadShare)} · start p90 >${TEAM_FLOW_WARN.startDelayP90Ms / MINUTE}m, oldest >${TEAM_FLOW_WARN.queuedOldestMs / MINUTE}m · top waited >${percent(TEAM_FLOW_WARN.waitedMemberShare)} · context >${TEAM_FLOW_WARN.contextTokens / 1000}k`;
