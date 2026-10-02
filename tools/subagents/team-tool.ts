import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import type { SessionBroker } from "./session-broker";
import { formatWorkResult, jsonTextBytes, normalizeTeamPlan, previewText, TEAM_PLAN_MIGRATION, truncateText } from "./team-codec";
import type { TeamHistoryEntry } from "./team-history";
import { prompt, promptList } from "../../core/prompts";
import type { TeamSessionHost } from "./team-host";
import { TeamLaunchError } from "./team-member-driver";
import {
	TEAM_BUDGET_UNLIMITED, TEAM_MAX_INITIAL_REQUESTS, TEAM_MAX_NOTE_BYTES, TEAM_MAX_REVIEW_FOCUS_BYTES, TEAM_MAX_REVIEW_MINUTES, TEAM_MAX_ROLE_BYTES, TEAM_MAX_TASK_BYTES, TEAM_MAX_TIMEOUT_SECONDS, TEAM_MAX_MEMBERS, TEAM_MAX_TOOL_NAMES, TEAM_MIN_MEMBERS, TEAM_RESERVED_TOOLS,
	workRefKey, type TeamBudgetLimits, type TeamBudgetPreset, type ResultRecord, type TeamMemberPolicy, type TeamResult, type TeamTeamView, type TeamWorkSummary, type WorkRef, isTerminalWorkState, reviewAssessment, sameWorkRef, shortWorkRef,
} from "./team-protocol";
import { capped, clock, formatTimeline, type TeamRuntime } from "./team-runtime";

export { formatTimeline };
import {
	formatContextWindowForDisplay, markdownThemeFromTheme, resolveTeamMemberPolicy, verifyPinnedTeamMemberPolicy,
	type ResolvedTeamMemberPolicy,
} from "./tool";
import { boundSubagentRunTranscripts, renderSubagentTranscript, type SubagentTranscriptRun } from "./transcript";
import { fairShares } from "./text-budget";
import { addActivationUsage } from "./usage";

const MAX_MEMBER_OUTPUT_BYTES = 16 * 1024;
const MAX_FINAL_TEXT_BYTES = 48 * 1024;
const UPDATE_INTERVAL_MS = 250;
const LIVE_LIFECYCLES = ["prepared", "active", "closing"];

function nullable(schema: TSchema) {
	return Type.Optional(Type.Union([schema, Type.Null()]));
}

const MemberSchema = Type.Object({
	alias: Type.String({ minLength: 1, maxLength: 64, description: "New persistent alias for this member" }),
	roleDescription: Type.String({ minLength: 1, maxLength: TEAM_MAX_ROLE_BYTES, description: "Standing role and responsibilities; not a task" }),
	model: nullable(Type.String({ description: "Pi model reference such as provider/model:thinking; null uses the current model" })),
	cwd: nullable(Type.String({ description: "Working directory; null uses the parent cwd" })),
	fastMode: nullable(Type.Boolean({ description: "true enables native Fast for an eligible GPT model; null means off" })),
	contextWindow: nullable(Type.Number({ description: "Child context budget; null uses the model default. Only when the user asks for one." })),
	tools: nullable(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: TEAM_MAX_TOOL_NAMES,
		description: "Allowlist of base tool names this member may use (the Team's own team tool is always added); null = every base tool. Name only tools the parent has; subagent, subagent_team and team are not selectable." })),
}, { additionalProperties: false });

const TextList = () => nullable(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 }));
const BriefSchema = Type.Object({
	goal: Type.String({ minLength: 1, description: "Shared Team goal" }),
	target: nullable(Type.String({ description: "Target URL, repository, system, or business scope" })),
	acceptanceCriteria: TextList(),
	constraints: TextList(),
	authorizations: nullable(Type.Array(Type.Object({
		member: Type.String({ minLength: 1, maxLength: 64 }),
		allowed: Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 }),
		forbidden: TextList(),
	}, { additionalProperties: false }), { maxItems: TEAM_MAX_MEMBERS })),
}, { additionalProperties: false });

const InitialRequestSchema = Type.Object({
	to: Type.String({ minLength: 1, maxLength: 64, description: "A member alias other than the lead" }),
	task: Type.String({ minLength: 1, maxLength: TEAM_MAX_TASK_BYTES, description: "Self-contained initial work for that member" }),
	inputRefs: nullable(Type.Array(Type.String(), { maxItems: 0 })),
}, { additionalProperties: false });

type Params = {
	action: "prepare" | "launch" | "status" | "cancel";
	teamId?: string | null;
	members?: unknown;
	lead?: string | null;
	brief?: unknown;
	initialRequests?: unknown;
	timeoutSeconds?: number | null;
	budget?: TeamBudgetPreset | null;
	review?: unknown;
	reason?: string | null;
	cursor?: string | null;
	resultRef?: string | null;
};

type TeamResultRefSummary = { id: string; work: { workId: string; revision: number }; author: string; status: "succeeded" | "partial" | "failed"; summaryPreview: string };
type TeamResultRefPage = { items: TeamResultRefSummary[]; cursor?: string; hasMore: boolean; total: number };

export interface TeamToolDetails {
	view?: TeamTeamView;
	works?: TeamWorkSummary[];
	resultRecord?: ResultRecord;
	resultPage?: TeamResultRefPage;
	holdsTotal?: number;
	/** launch: why the active Team has not finished yet (the header's `Waiting for:` line). */
	waitingFor?: string;
	/** launch: one grouped-subagent panel per member (bounded transcripts), and the launch wall time. */
	members?: SubagentTranscriptRun[];
	durationMs?: number;
}

export class TeamLaunchWaitAbortedError extends Error {
	readonly code = "TEAM_LAUNCH_WAIT_ABORTED";
	constructor(readonly teamId: string, readonly lifecycle: TeamTeamView["lifecycle"]) {
		super(`Launch stopped waiting for Team ${teamId} after an abort signal. The Team was not cancelled; current lifecycle is ${lifecycle}. It remains host-managed: inspect or cancel it with /rail-team ${teamId} status|cancel.`);
		this.name = "TeamLaunchWaitAbortedError";
	}
}

// ---------------------------------------------------------------------------------------------
// Bounded text views shared by the tool panel, tool results and /rail-team.

const upper = (value: string) => value.replaceAll("_", " ").toUpperCase();
export const formatBudgetLimit = (value: number): string => value >= TEAM_BUDGET_UNLIMITED ? "unlimited" : String(value);
const limit = (used: number, max: number) => `${used}/${formatBudgetLimit(max)}`;
const budgetLimitsText = (limits: TeamBudgetLimits) => `activations ${formatBudgetLimit(limits.teamActivations)} · lead ${formatBudgetLimit(limits.leadActivations)} · model requests ${formatBudgetLimit(limits.teamModelRequests)} · tool calls ${formatBudgetLimit(limits.teamToolCalls)} · works ${formatBudgetLimit(limits.teamWorks)}`;

type PanelFacts = ReturnType<TeamRuntime["panelFacts"]>;

/** Team state of one member: lifecycle, activity and current work, queues, pause, Team events, results, error. */
function memberStateText(member: TeamTeamView["members"][number], works: readonly TeamWorkSummary[], lead: string, facts?: PanelFacts,
	refText: (ref: WorkRef) => string = workRefKey): string {
	// Idle is a live state, never "done": say what the member is waiting on instead.
	const current = member.currentWork ? works.find((work) => workRefKey(work.work) === workRefKey(member.currentWork!)) : undefined;
	const activity = member.activity === "idle" && !member.currentWork && member.queued + member.blocked + member.held === 0
		? "IDLE · no assigned work"
		: `${upper(member.activity)}${member.currentWork ? ` ${refText(member.currentWork)}` : ""}${current ? ` "${previewText(current.taskPreview, 80)}"` : ""} · queued ${member.queued} · blocked ${member.blocked} · held ${member.held}`;
	const pause = member.pause === "none" ? "" : ` · pause ${member.pause}`;
	const events = facts && member.id === lead ? ` · pending events ${facts.pendingEvents}` : "";
	const results = facts?.results.get(member.id)?.count;
	const error = member.error ? ` · ${member.error.code}: ${previewText(member.error.message, 160)}` : "";
	return `${upper(member.lifecycle)} · ${activity}${pause}${events}${results ? ` · results ${results}` : ""}${error}`;
}

export function formatTeamView(view: TeamTeamView, works: readonly TeamWorkSummary[] = [], totalHolds = works.filter((work) => work.hold).length,
	facts?: PanelFacts): string[] {
	const label = (member: TeamTeamView["members"][number]) => member.id === view.lead ? `${member.id} (lead)` : member.id;
	const width = Math.max(...view.members.map((member) => label(member).length));
	const members = view.members.map((member) => {
		const policy = `${member.policy.model ?? "model ?"} · FAST ${member.policy.fastMode ? "on" : "off"} · SEARCH ${member.policy.searchMode ?? "off"}`;
		return `${label(member).padEnd(width)} · ${memberStateText(member, works, view.lead, facts)} · ${policy}`;
	});
	const usage = view.usage;
	return [...teamLines(view, works, totalHolds, members, facts?.waitingFor),
		`Usage: ${usage.turns} turns · input ${usage.input} · output ${usage.output} · cache ${usage.cacheRead}/${usage.cacheWrite} · cost ${usage.cost.toFixed(4)}`];
}

/** Team-level lines; the launch panel passes no member lines because each member has its own panel. */
function teamLines(view: TeamTeamView, works: readonly TeamWorkSummary[], totalHolds: number, memberLines: readonly string[], waitingFor?: string): string[] {
	const openIncidents = view.incidents.filter((incident) => incident.state === "open");
	const health = view.health === "needs_attention" ? `needs attention ${openIncidents.length}` : "ok";
	const lines = [
		`Team ${view.teamId} · ${upper(view.lifecycle)} · ${health}${view.outcome ? ` · outcome ${view.outcome}` : ""}`,
		`Goal: ${previewText(view.brief.goal, 240)}`,
	];
	// Whole: the close reason is already bounded by the note limit (one line; the collapsed panel cuts it to a row).
	if (view.reason) lines.push(`Reason: ${previewText(view.reason, TEAM_MAX_NOTE_BYTES)}`);
	const w = view.works;
	lines.push(`Works: ${w.total} total · queued ${w.queued} · running ${w.running} · blocked ${w.blocked} · held ${w.held} · resolved ${w.resolved} · failed ${w.failed} · cancelled/superseded ${w.cancelled} · roots reviewed ${w.rootsReviewed}/${w.roots}`);
	if (waitingFor) lines.push(`Waiting for: ${waitingFor}`);
	lines.push(...memberLines);
	const holds = works.filter((work) => work.hold);
	if (holds.length) {
		lines.push(`Holds: ${holds.slice(0, 8).map((work) => `${workRefKey(work.work)} ${work.hold} (${work.assignee})`).join(" · ")}${totalHolds > holds.length ? ` · +${totalHolds - holds.length} more` : ""}`);
	}
	for (const incident of openIncidents.slice(0, 5)) {
		lines.push(`Incident ${incident.id} [${incident.code}]${incident.work ? ` ${workRefKey(incident.work)}` : ""}: ${previewText(incident.message, 200)}`);
	}
	if (openIncidents.length > 5) lines.push(`+${openIncidents.length - 5} more open incidents`);
	const { limits, used } = view.budget;
	lines.push(`Budget${view.budget.exhausted ? " EXHAUSTED" : ""}: activations ${limit(used.teamActivations, limits.teamActivations)} · lead ${limit(used.leadActivations, limits.leadActivations)} · model requests ${limit(used.teamModelRequests, limits.teamModelRequests)} · tool calls ${limit(used.teamToolCalls, limits.teamToolCalls)} · works ${limit(used.teamWorks, limits.teamWorks)}${view.budget.rootsOmitted ? ` · ${view.budget.rootsOmitted} roots omitted (see /rail-team ${view.teamId} budget)` : ""}`);
	return lines;
}

/** What the lead has handed out that is still open: unfinished work, or a finished root awaiting its review. */
function dispatchedText(lead: string, works: readonly TeamWorkSummary[]): string | undefined {
	const open = works.flatMap((work) => work.requester !== lead || work.kind ? []
		: !isTerminalWorkState(work.state) ? [`${work.assignee} (${work.hold ? "held" : work.state === "blocked" ? "waiting" : work.state})`]
			: !work.parent && !work.review ? [`${work.assignee} (awaiting review)`] : []);
	return open.length ? `dispatched: ${capped(open, 3)}` : undefined;
}

/** A member's panel state line: plain words, only the facts that matter now. */
export function memberDetail(member: TeamTeamView["members"][number], facts: PanelFacts, works: readonly TeamWorkSummary[], lead: string): string {
	const results = facts.results.get(member.id)?.count ?? 0;
	const resultText = results ? `${results} ${results === 1 ? "result" : "results"}` : "";
	if (member.lifecycle === "closed") return ["closed", resultText].filter(Boolean).join(" · ");
	const now = member.currentWork ? `running ${shortWorkRef(member.currentWork)}`
		: member.id === lead && facts.leadHandling ? facts.leadHandling
			: member.held || member.blocked ? facts.stalled.get(member.id) ?? "waiting on other work"
				: member.queued ? "queued for a work slot"
					: (member.id === lead ? dispatchedText(member.id, works) : undefined) ?? "no assigned work";
	return [
		member.lifecycle === "open" ? "" : member.lifecycle,
		now,
		member.currentWork && member.queued ? `${member.queued} queued` : "",
		member.pause === "none" ? "" : `pause ${member.pause}`,
		member.id === lead && facts.pendingEvents ? `${facts.pendingEvents} pending events` : "",
		resultText,
		member.error ? `${member.error.code}: ${previewText(member.error.message, 160)}` : "",
	].filter(Boolean).join(" · ");
}

/** Title of a member's task line: who asked, which work and revision, and whether it is still open. */
function taskLabel(work: TeamWorkSummary): string {
	return `${isTerminalWorkState(work.state) ? "last task" : "task"} from ${work.requester}${work.parent ? " (sub-task)" : ""}`
		+ ` · ${shortWorkRef(work.work)}${work.work.revision > 1 ? " · revised" : ""}`;
}

/** Destination of the shown task, never the result of a different work. */
function resultTarget(work: TeamWorkSummary, latest?: ResultRecord): string {
	const superseded = latest?.work.workId === work.work.workId && latest.work.revision < work.work.revision;
	const fate = work.review ?? (work.resultRef ? work.parent ? "" : "awaiting review"
		: work.state === "cancelled" || work.state === "failed" ? work.state : "in progress");
	return `↳ result → ${work.requester}${fate ? ` · ${fate}` : ""}${work.resultRef ? ` · ${work.resultRef}` : ""}`
		+ (superseded ? ` · @${latest.work.revision} result superseded` : "");
}

/**
 * One grouped-subagent run per member: its Team state, the task it is (or was last) working on and who
 * asked for it, its latest submitted result and where it went, native activity across activations, and
 * settled plus in-flight usage.
 */
function memberRuns(host: TeamSessionHost, teamId: string, facts: PanelFacts): SubagentTranscriptRun[] {
	const view = host.runtime.getTeam(teamId);
	const works = host.runtime.listWorks(teamId);
	return boundSubagentRunTranscripts(view.members.map((member, slot): SubagentTranscriptRun => {
		const activity = host.driver.memberActivity(teamId, member.id);
		const usage = { ...member.usage };
		if (activity?.liveUsage) addActivationUsage(usage, activity.liveUsage);
		const latest = facts.results.get(member.id)?.latest;
		const currentKey = member.currentWork ? workRefKey(member.currentWork) : undefined;
		// The lead's Team-level job is the goal in the Team header; a task line is only for assigned work.
		const assigned = works.filter((work) => work.assignee === member.id);
		const task = assigned.find((work) => workRefKey(work.work) === currentKey) ?? assigned.find((work) => !isTerminalWorkState(work.state)) ?? assigned.at(-1);
		const entries = activity?.transcript.entries ?? [];
		return {
			slot, alias: member.id, member: { lead: member.id === view.lead }, model: member.policy.model ?? "model unavailable", persistent: true,
			status: member.lifecycle === "faulted" ? "failed" : member.lifecycle === "closed" ? "completed"
				: member.activity !== "idle" || member.lifecycle === "starting" || member.lifecycle === "closing" ? "running"
					: member.held ? "held" : member.blocked || member.queued ? "waiting" : "idle",
			// Like a grouped subagent's final answer: the member's latest result in full, or the lead's close decision.
			output: latest ? truncateText(formatWorkResult(latest.result), MAX_MEMBER_OUTPUT_BYTES).text
				: member.id === view.lead && view.outcome ? view.reason ?? `outcome ${view.outcome}`
					: activity?.output ?? "",
			usage, ...(activity ? { durationMs: activity.durationMs } : {}),
			contextWindowText: formatContextWindowForDisplay(member.policy.contextWindow),
			fastModeText: member.policy.fastMode ? "on" : "off", searchModeText: member.policy.searchMode === "on" ? "on" : "off",
			detail: memberDetail(member, facts, works, view.lead),
			transcript: {
				entries: task ? [
					{ id: "initial-task", kind: "user", initial: true, label: taskLabel(task), text: task.taskPreview, order: 0 },
					{ id: "result-destination", kind: "note", initial: true, text: resultTarget(task, latest), order: 0 },
					...entries,
				] : entries,
				omittedEntries: activity?.transcript.omittedEntries ?? 0,
			},
			...(activity?.isCompacting ? { isCompacting: true } : {}),
			...(member.error ? { errorMessage: member.error.message } : {}),
		};
	}));
}

export function formatHistorySummary(entry: TeamHistoryEntry): string {
	const roster = entry.lead ? ` · lead ${entry.lead} · members ${entry.members.join(", ")}` : "";
	return `${entry.teamId} · ${upper(entry.lifecycle)}${entry.outcome ? ` · outcome ${entry.outcome}` : ""}${entry.version === 1 ? " · legacy v1 (read-only)" : " · history (read-only)"}${roster} · ${entry.results.length} results`;
}

export function formatHistoryEntry(entry: TeamHistoryEntry, cursor?: string): string {
	const offset = resultPageOffset(cursor);
	const items = entry.results.slice(offset, offset + 20);
	const lines = [formatHistorySummary(entry)];
	for (const record of items) lines.push(`  ${record.id} · ${record.author} · ${workRefKey(record.work)} · ${record.result.status}: ${previewText(record.result.summary, 512)}`);
	const next = offset + items.length;
	if (next < entry.results.length) lines.push(`Next result refs: /rail-team ${entry.teamId} results page:${next}`);
	if (offset > 0 && items.length === 0) throw new Error(`Result page ${cursor} is past the end for Team ${entry.teamId}`);
	return lines.join("\n");
}

function resultPageOffset(cursor?: string | null): number {
	if (!cursor) return 0;
	const match = /^page:(0|[1-9][0-9]*)$/u.exec(cursor);
	const offset = match ? Number(match[1]) : NaN;
	if (!Number.isSafeInteger(offset)) throw new Error(`Invalid result page cursor ${cursor}`);
	return offset;
}

function formatResultRecord(record: ResultRecord): string {
	return [`${record.id} · ${record.author} · ${workRefKey(record.work)} · ${record.result.status}`, formatWorkResult(record.result)].join("\n");
}

function formatResultRefPage(page: TeamResultRefPage): string[] {
	const lines = [`Result refs ${page.items.length ? `${page.items[0]!.id}…${page.items.at(-1)!.id}` : "(empty)"} · ${page.total} total`];
	for (const item of page.items) lines.push(`  ${item.id} · ${item.author} · ${workRefKey(item.work)} · ${item.status}: ${previewText(item.summaryPreview, 240)}`);
	if (page.cursor) lines.push(`Next page cursor: ${page.cursor}`);
	return lines;
}

function hasPayload(value: unknown): boolean {
	return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)
		&& !(typeof value === "string" && value.trim() === "");
}

/** Enforce the action whitelist before projecting parameters into the shared plan codec. */
function assertActionParams(params: Params, action: Params["action"]): void {
	if (["manager", "workers", "coordinator"].some((key) => hasPayload((params as Record<string, unknown>)[key]))) throw new Error(TEAM_PLAN_MIGRATION);
	const known = ["action", "teamId", "members", "lead", "brief", "initialRequests", "timeoutSeconds", "budget", "review", "reason", "cursor", "resultRef"];
	const unknown = Object.keys(params).filter((key) => !known.includes(key));
	if (unknown.length) throw new Error(`${action} contains unsupported field(s): ${unknown.join(", ")}`);
	const allowed: Record<Params["action"], readonly string[]> = {
		prepare: ["action", "teamId", "members", "lead", "brief", "initialRequests", "timeoutSeconds", "budget", "review"],
		launch: ["action", "teamId"],
		status: ["action", "teamId", "cursor", "resultRef"],
		cancel: ["action", "teamId", "reason"],
	};
	const extra = Object.keys(params).filter((key) => !allowed[action].includes(key) && hasPayload((params as Record<string, unknown>)[key]));
	if (extra.length) throw new Error(`${action} does not accept field(s): ${extra.join(", ")}`);
}

/**
 * Final launch text: deliverables, process and members, then the lead-selected results in full.
 * Only oversized results are truncated; the timeline is available through status.
 */
function finalTeamText(host: TeamSessionHost, result: TeamResult, startedAt: number): string {
	const view = host.runtime.getTeam(result.teamId);
	const facts = host.runtime.panelFacts(result.teamId);
	const stats = host.runtime.processStats(result.teamId);
	const roots = host.runtime.listWorks(result.teamId).filter((work) => !work.parent && !work.kind);
	const lastReview = host.runtime.listReviews(result.teamId).at(-1);
	const reviewOf = (work: TeamWorkSummary) => result.roots.find((root) => sameWorkRef(root.work, work.work))?.review;
	const accepted = roots.filter((work) => (reviewOf(work)?.disposition ?? work.review) === "accepted").length;
	const waived = roots.filter((work) => (reviewOf(work)?.disposition ?? work.review) === "waived").length;
	const unresolved = result.unresolvedIncidents.length + (result.unresolvedIncidentsOmitted ?? 0);
	const lines = [
		`Team ${result.teamId} ${upper(result.lifecycle)}${result.outcome ? ` · outcome ${result.outcome}` : ""} · ${clock(Date.now() - startedAt)}${result.reason ? ` · ${previewText(result.reason, TEAM_MAX_NOTE_BYTES)}` : ""}`,
		`Deliverables (${roots.length} roots · ${accepted} accepted · ${waived} waived):`,
		...roots.slice(0, 20).map((work) => {
			const record = work.resultRef ? host.runtime.getResult(result.teamId, work.resultRef) : undefined;
			const review = reviewOf(work);
			const verdict = review?.disposition ?? work.review ?? (work.resultRef ? "awaiting review" : work.state);
			return `- ${workRefKey(work.work)} ${work.assignee} ← ${work.requester} · ${verdict}${review?.disposition === "waived" && review.reason ? `: ${previewText(review.reason, 300)}` : ""} · ${work.resultRef ?? "no result"} · ${record ? previewText(record.result.summary, 160) : ""}`;
		}),
		...(roots.length > 20 ? [`+${roots.length - 20} more roots`] : []),
		"Process:",
		`- works ${stats.works} (${stats.roots} roots, ${stats.works - stats.roots} sub-tasks) · results ${stats.results}`,
		`- activations ${stats.activations} · model turns ${stats.modelTurns} · dependency waits ${stats.dependencyWaits} · questions ${stats.questions}`,
		`- revisions ${stats.revisions} · cancelled/superseded ${stats.cancelled} · tool errors ${stats.toolErrors} (${unresolved ? `${unresolved} unresolved incidents` : "all recovered"})`,
		`- tokens input ${result.usage.input} · output ${result.usage.output} · cache ${result.usage.cacheRead}/${result.usage.cacheWrite} · cost ${result.usage.cost.toFixed(4)}`,
		`- Budget: ${budgetLimitsText(view.budget.limits)}`,
		...(lastReview ? [`- Last review ${clock(lastReview.snapshot.elapsedMs)} ${lastReview.verdict?.replace("_", " ") ?? "no verdict"}: ${previewText(reviewAssessment(lastReview.summary), 160)}`] : []),
		"Members:",
		...view.members.map((member) => {
			const activity = host.driver.memberActivity(result.teamId, member.id);
			return `- ${member.id}${member.id === view.lead ? " (lead)" : ""} · ${member.policy.model ?? "model ?"}${member.policy.fastMode ? " +FAST" : ""}`
				+ ` · results ${facts.results.get(member.id)?.count ?? 0} · activations ${stats.memberActivations.get(member.id) ?? 0} · active ${clock(activity?.durationMs ?? 0)}`;
		}),
	];
	for (const incident of result.unresolvedIncidents.slice(0, 5)) lines.push(`Unresolved ${incident.code}: ${previewText(incident.message, 200)}`);
	if (result.unresolvedIncidentsOmitted) lines.push(`${result.unresolvedIncidentsOmitted} additional unresolved incidents omitted from the bounded terminal snapshot.`);
	lines.push("", "Final results selected by the lead (in full):");
	const details = `Details on demand: subagent_team status {teamId: "${result.teamId}", resultRef} reads any result in full; subagent_team status {teamId: "${result.teamId}"} returns the Team view and the timeline.`;
	const blocks = result.finalResultRefs.map((ref) => {
		const record = host.runtime.getResult(result.teamId, ref);
		// The author's own status says nothing about the lead's verdict on a root.
		const review = record && result.roots.find((root) => sameWorkRef(root.work, record.work))?.review?.disposition;
		const heading = record ? `### ${record.author} · ${workRefKey(record.work)} · ${record.result.status}${review ? ` · ${review}` : ""} · ${ref}` : `### ${ref} · result not retained in this runtime`;
		const body = record ? formatWorkResult(record.result) : "";
		const truncated = `[Result truncated for the parent; full record: subagent_team status teamId ${result.teamId} resultRef ${ref}]`;
		// Fixed cost of a block: blank separator, heading, and room for the truncation note.
		return { heading, body, overhead: Buffer.byteLength(`\n\n${heading}\n\n${truncated}`, "utf8"), truncated };
	});
	// Shorter results stay complete, and only the largest ones share what is left.
	const available = MAX_FINAL_TEXT_BYTES - Buffer.byteLength(`${lines.join("\n")}\n\n${details}`, "utf8") - blocks.reduce((sum, block) => sum + block.overhead, 0);
	const shares = fairShares(blocks.map((block) => jsonTextBytes(block.body)), available, 512);
	for (const [index, block] of blocks.entries()) {
		const body = truncateText(block.body, shares[index]!);
		lines.push("", [block.heading, body.text, ...(body.truncated ? [block.truncated] : [])].join("\n"));
	}
	lines.push("", details);
	return lines.join("\n");
}

function textResult(text: string, details: TeamToolDetails): AgentToolResult<TeamToolDetails> {
	return { content: [{ type: "text", text }], details };
}

function liveView(host: TeamSessionHost, teamId: string): { view: TeamTeamView; works: TeamWorkSummary[]; holdsTotal: number } {
	const all = host.runtime.listWorks(teamId);
	const view = host.runtime.getTeam(teamId);
	const held = all.filter((work) => work.hold);
	// Bounded details: at most 8 holds plus each member's current work (for its task preview).
	const current = new Set(view.members.flatMap((member) => member.currentWork ? [workRefKey(member.currentWork)] : []));
	const works = [...held.slice(0, 8), ...all.filter((work) => current.has(workRefKey(work.work)) && !work.hold)];
	return { view, works, holdsTotal: held.length };
}

// ---------------------------------------------------------------------------------------------

export function installTeamTool(pi: ExtensionAPI, deps: { host: () => TeamSessionHost; broker: () => SessionBroker }): void {
	const prepare = async (params: Params, ctx: ExtensionContext): Promise<AgentToolResult<TeamToolDetails>> => {
		assertActionParams(params, "prepare");
		const host = deps.host();
		if (!host.active) throw new Error("The Team runtime for this session branch has ended; nothing was prepared");
		if (params.teamId?.trim()) throw new Error("prepare creates a new Team and does not accept teamId");
		const raw: Record<string, unknown> = {};
		for (const key of ["members", "lead", "brief", "initialRequests", "timeoutSeconds", "budget", "review"] as const) {
			if (params[key] !== undefined) raw[key] = params[key];
		}
		const plan = normalizeTeamPlan(raw);
		const { members } = plan;
		const baseTools = new Set(pi.getAllTools().map((tool) => tool.name).filter((name) => !TEAM_RESERVED_TOOLS.includes(name)));
		for (const member of members) {
			const unknown = member.policy.tools?.filter((name) => !baseTools.has(name));
			if (unknown?.length) throw new Error(`${member.alias}: unknown tool name(s) ${unknown.join(", ")}; available base tools: ${[...baseTools].join(", ") || "none"} (the team tool is always added; ${TEAM_RESERVED_TOOLS.join(", ")} are not selectable)`);
		}
		const resolved = new Map<string, ResolvedTeamMemberPolicy>();
		for (const member of members) {
			try { resolved.set(member.alias, await resolveTeamMemberPolicy(member.policy, ctx)); }
			catch (error) { throw new Error(`${member.alias}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		const aliases = members.map((member) => member.alias);
		const liveOwners = host.runtime.listTeams().filter((team) => LIVE_LIFECYCLES.includes(team.lifecycle));
		const taken = aliases.filter((alias) => liveOwners.some((team) => team.members.some((member) => member.id === alias)));
		if (taken.length) throw new Error(`Alias already belongs to an unfinished Team: ${taken.join(", ")}. Choose new aliases.`);
		await deps.broker().assertAliasesAvailable(aliases);
		if (!host.active) throw new Error("The Team runtime for this session branch has ended; nothing was prepared");
		const policies = new Map<string, TeamMemberPolicy>(members.map(({ alias, policy: planned }) => {
			const policy = resolved.get(alias)!;
			return [alias, {
				model: policy.modelReference, cwd: policy.cwd, fastMode: policy.fastMode, searchMode: policy.searchMode,
				...(policy.contextWindow !== undefined ? { contextWindow: policy.contextWindow } : {}),
				...(planned.tools ? { tools: planned.tools } : {}),
			}];
		}));
		const view = host.runtime.prepare(raw, policies);
		host.pin(view.teamId, resolved);
		const works = host.runtime.listWorks(view.teamId);
		const lines = [
			`Prepared Team ${view.teamId} (nothing has started: no provider, no tool).`,
			...members.map((member) => {
				const policy = resolved.get(member.alias)!;
				const contextWindow = policy.contextWindow === undefined ? `native default ${policy.nativeContextWindow}` : `${policy.contextWindow} (explicit)`;
				return `- ${member.alias}${member.alias === plan.lead ? " (lead)" : ""} · ${policy.modelReference} · FAST ${policy.fastMode ? "on" : "off"} · SEARCH ${policy.searchMode} · ContextWindow ${contextWindow} · reserve ${policy.compactionReserveTokens} · cwd ${policy.cwd} · tools ${member.policy.tools ? `${member.policy.tools.join(", ") || "none"} + team` : "all + team"} · role: ${previewText(member.roleDescription, 200)}`;
			}),
			`Lead ${plan.lead} handles Team events, reviews the results and closes the Team; the other members are assigned work by it.`,
			`Initial work: ${works.map((work) => `${workRefKey(work.work)} → ${work.assignee}`).join(" · ") || "none (members start idle; the lead assigns work)"}`,
			`Deadline: ${plan.timeoutSeconds === null ? "no Team deadline" : `${plan.timeoutSeconds}s from launch`}`,
			`Budget (${plan.budget ?? "long"}): ${budgetLimitsText(view.budget.limits)}; the host can grant more with /rail-team.`,
			`Review: ${plan.review ? `${plan.review.by} every ${plan.review.everyMinutes} min${plan.review.focus ? ` · focus: ${previewText(plan.review.focus, 200)}` : ""}` : "none"}`,
			`Next: in your next message call subagent_team {"action":"launch","teamId":"${view.teamId}"}. It returns when the whole Team has ended. Do not start members with the subagent tool.`,
		];
		return textResult(lines.join("\n"), { view, works });
	};

	const launch = async (params: Params, signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TeamToolDetails> | undefined, ctx: ExtensionContext): Promise<AgentToolResult<TeamToolDetails>> => {
		assertActionParams(params, "launch");
		const host = deps.host();
		const teamId = params.teamId?.trim();
		if (!teamId) throw new Error("launch requires the teamId returned by prepare");
		let view: TeamTeamView;
		try { view = host.runtime.getTeam(teamId); }
		catch { throw new Error(`Unknown teamId ${JSON.stringify(teamId.slice(0, 128))}: use the exact teamId returned by prepare in this session.`); }
		if (view.lifecycle !== "prepared") throw new Error(`Team ${teamId} is ${view.lifecycle} and cannot be launched again; use status, or prepare a new Team.`);
		const pinned = host.pinnedPolicies(teamId);
		if (!pinned) throw new Error(`Team ${teamId} is already launching.`);
		if (!host.active) throw new Error("The Team runtime for this session branch has ended; nothing was started");
		if (signal?.aborted) throw new Error(`Launch was aborted before opening Team ${teamId}; no member resources or providers were started. The Team remains prepared and can be retried or cancelled.`);
		for (const policy of pinned.values()) verifyPinnedTeamMemberPolicy(policy, ctx);
		// Consumed synchronously, so a concurrent second launch cannot pass this point.
		host.unpin(teamId);
		const requests = view.members.map((member) => {
			const policy = pinned.get(member.id)!;
			return { teamId, memberId: member.id, model: policy.model, cwd: policy.cwd, fastMode: policy.fastMode,
				...(policy.contextWindow !== undefined ? { contextWindow: policy.contextWindow } : {}) };
		});

		let finished = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const startedAt = Date.now();
		const panel = (): TeamToolDetails => {
			const facts = host.runtime.panelFacts(teamId);
			return { ...liveView(host, teamId), members: memberRuns(host, teamId, facts), ...(facts.waitingFor ? { waitingFor: facts.waitingFor } : {}), durationMs: Date.now() - startedAt };
		};
		const publish = () => {
			timer = undefined;
			// No update after the call settled, or from a generation whose branch has ended.
			if (finished || !host.active || !onUpdate) return;
			const current = panel();
			onUpdate(textResult(formatTeamView(current.view!, current.works, current.holdsTotal, host.runtime.panelFacts(teamId)).join("\n"), current));
		};
		// Team state and member native activity share one throttled panel update.
		const schedule = (changed: string) => {
			if (changed === teamId && !timer && !finished) timer = setTimeout(publish, UPDATE_INTERVAL_MS);
		};
		const unsubscribe = host.runtime.onChange(schedule);
		const unsubscribeActivity = host.driver.onActivity(schedule);
		publish();
		let detach: (() => void) | undefined;
		const detached = new Promise<{ kind: "detached" }>((resolve) => {
			if (!signal) return;
			const onAbort = () => resolve({ kind: "detached" });
			if (signal.aborted) { onAbort(); return; }
			signal.addEventListener("abort", onAbort, { once: true });
			detach = () => signal.removeEventListener("abort", onAbort);
		});
		const lifetime = host.driver.openAndLaunch(teamId, requests).then(({ lifetime: completion }) => completion);
		try {
			const outcome = await Promise.race([
				lifetime.then((result) => ({ kind: "result" as const, result }), (error: unknown) => ({ kind: "error" as const, error })),
				detached,
			]);
			if (outcome.kind === "detached") {
				// This call has no authority to infer a user cancellation. Keep the Team host-managed,
				// but report the aborted launch as a tool error rather than a successful active result.
				void lifetime.catch((error: unknown) => {
					if (ctx.hasUI && host.active && deps.host() === host) {
						ctx.ui.notify(`Team ${teamId} lifecycle failed after launch stopped waiting: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				});
				throw new TeamLaunchWaitAbortedError(teamId, host.runtime.getTeam(teamId).lifecycle);
			}
			if (outcome.kind === "error") {
				const error = outcome.error;
				if (error instanceof TeamLaunchError) {
					const members = error.cleanup?.members.map((member) => `${member.id} ${member.resourceState}`).join(" · ");
					throw new Error(`${error.message}${members ? `\nMember resources: ${members}` : ""}${error.cleanupError ? `\nCleanup is incomplete: ${error.cleanupError instanceof Error ? error.cleanupError.message : String(error.cleanupError)}` : ""}\nPrepare a new Team with new aliases for members that started.`);
				}
				throw error;
			}
			const text = finalTeamText(host, outcome.result, startedAt);
			if (outcome.result.lifecycle !== "closed") throw new Error(text);
			return textResult(text, panel());
		} finally {
			finished = true;
			if (timer) clearTimeout(timer);
			unsubscribe();
			unsubscribeActivity();
			detach?.();
		}
	};

	const status = (params: Params): AgentToolResult<TeamToolDetails> => {
		assertActionParams(params, "status");
		const host = deps.host();
		const teamId = params.teamId?.trim();
		const resultRef = params.resultRef?.trim();
		if (resultRef && !teamId) throw new Error("status resultRef requires teamId");
		if (resultRef && params.cursor?.trim()) throw new Error("status accepts either resultRef or cursor, not both");
		if (teamId) {
			const live = host.runtime.listTeams().find((team) => team.teamId === teamId);
			if (resultRef) {
				const record = live ? host.runtime.getResult(teamId, resultRef) : host.history.teams.find((team) => team.teamId === teamId)?.results.find((item) => item.id === resultRef);
				if (!record) throw new Error(`Unknown resultRef ${resultRef} for Team ${teamId}`);
				return textResult(formatResultRecord(record), { resultRecord: record });
			}
			if (live) {
				const current = liveView(host, teamId);
				const page = host.runtime.listResultRefsPage(teamId, params.cursor?.trim() || undefined);
				const facts = host.runtime.panelFacts(teamId);
				const lines = [...formatTeamView(current.view, current.works, current.holdsTotal, facts), ...formatResultRefPage(page)];
				if (!params.cursor?.trim()) lines.push("Timeline (m:ss from launch):", ...formatTimeline(facts.timeline, facts.timelineOmitted, facts.timeline[0]?.at ?? 0));
				return textResult(lines.join("\n"), { ...current, resultPage: page });
			}
			const entry = host.history.teams.find((team) => team.teamId === teamId);
			if (entry) return textResult(formatHistoryEntry(entry, params.cursor?.trim() || undefined), {});
			throw new Error(`Unknown teamId ${JSON.stringify(teamId.slice(0, 128))}`);
		}
		if (params.cursor?.trim()) throw new Error("status cursor requires teamId");
		const teams = host.runtime.listTeams();
		const liveIds = new Set(teams.map((team) => team.teamId));
		const history = host.history.teams.filter((entry) => !liveIds.has(entry.teamId));
		const lines = [
			...teams.map((team) => `${team.teamId} · ${upper(team.lifecycle)} · ${team.health === "ok" ? "ok" : "needs attention"} · lead ${team.lead} · ${team.members.length} members · works ${team.works.total}`),
			...history.map(formatHistorySummary),
			...(host.history.skipped ? [`${host.history.skipped} malformed history entries skipped`] : []),
		];
		return textResult(lines.join("\n") || "No teams", {});
	};

	const cancel = async (params: Params): Promise<AgentToolResult<TeamToolDetails>> => {
		assertActionParams(params, "cancel");
		const host = deps.host();
		const teamId = params.teamId?.trim();
		if (!teamId) throw new Error("cancel requires teamId");
		const reason = params.reason?.trim() || "Cancelled by the parent";
		host.runtime.getTeam(teamId);
		host.unpin(teamId);
		const result = await host.driver.stopTeam(teamId, reason);
		const failures: unknown[] = [];
		for (const member of result.members.filter((item) => item.resourceState !== "released")) {
			try { await host.driver.closeMember(teamId, member.id); }
			catch (error) { failures.push(error); }
		}
		const unreleased = host.runtime.getTeam(teamId).members.filter((member) => member.resourceState !== "released");
		if (unreleased.length || failures.length) {
			const details = unreleased.map((member) => `${member.id}=${member.resourceState}`);
			details.push(...failures.map((error) => error instanceof Error ? error.message : String(error)));
			throw new Error(`Team ${teamId} cancellation is incomplete; member exits are not all confirmed: ${details.join("; ")}`);
		}
		const current = liveView(host, teamId);
		return textResult(formatTeamView(current.view, current.works, current.holdsTotal, host.runtime.panelFacts(teamId)).join("\n"), current);
	};

	pi.registerTool({
		name: "subagent_team",
		label: "Subagent Team",
		description: prompt("team", "subagent_team_description"),
		promptGuidelines: promptList("team", "subagent_team_guidelines"),
		executionMode: "parallel",
		parameters: Type.Object({
			action: StringEnum(["prepare", "launch", "status", "cancel"]),
			teamId: nullable(Type.String({ description: "launch/status/cancel: the teamId returned by prepare (status without it lists Teams). For a resultRef lookup, provide the owning teamId." })),
			cursor: nullable(Type.String({ description: "status: next result-ref page cursor returned by the prior status page; requires teamId" })),
			resultRef: nullable(Type.String({ description: "status: fetch exactly one complete ResultRecord by its resultRef; requires teamId and cannot be combined with cursor" })),
			members: nullable(Type.Array(MemberSchema, { minItems: TEAM_MIN_MEMBERS, maxItems: TEAM_MAX_MEMBERS })),
			lead: nullable(Type.String({ minLength: 1, maxLength: 64, description: "prepare: alias of the member that is the Team's lead; must be one of members" })),
			brief: nullable(BriefSchema),
			initialRequests: nullable(Type.Array(InitialRequestSchema, { maxItems: TEAM_MAX_INITIAL_REQUESTS })),
			budget: nullable(StringEnum(["standard", "long", "unlimited"], { description: "prepare: null = long. unlimited removes activation, model-request and tool-call caps (works stay capped at 20000)." })),
			review: nullable(Type.Object({
				by: Type.String({ minLength: 1, maxLength: 64, description: "A member alias other than the lead" }),
				everyMinutes: Type.Integer({ minimum: 1, maximum: TEAM_MAX_REVIEW_MINUTES }),
				focus: nullable(Type.String({ maxLength: TEAM_MAX_REVIEW_FOCUS_BYTES, description: "Optional guidance for the reviewer, at most 1 KiB, added after the review criteria" })),
			}, { additionalProperties: false, description: "prepare: periodic progress review by that member, reported to the lead; null = none" })),
			timeoutSeconds: nullable(Type.Number({ exclusiveMinimum: 0, maximum: TEAM_MAX_TIMEOUT_SECONDS, description: "null = no Team deadline. Only for a user-requested deadline, counted from launch." })),
			reason: nullable(Type.String({ description: "cancel: why the Team is cancelled" })),
		}, { additionalProperties: false }),
		prepareArguments(raw) {
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				const action = (raw as Record<string, unknown>)["action"];
				if (action === "prepare" || action === "launch" || action === "status" || action === "cancel") assertActionParams(raw as Params, action);
			}
			return raw as Params;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input = params as Params;
			if (input.action === "prepare") return prepare(input, ctx);
			if (input.action === "launch") return launch(input, signal, onUpdate, ctx);
			if (input.action === "cancel") return cancel(input);
			return status(input);
		},
		renderCall(args, theme) {
			const action = String(args.action ?? "");
			const team = typeof args.teamId === "string" && args.teamId.trim() ? ` · ${args.teamId.trim().slice(0, 12)}` : "";
			const members = action === "prepare" && Array.isArray(args.members) ? ` · ${args.members.length} members` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_team "))}${theme.fg("accent", `${action}${team}${members}`)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as TeamToolDetails | undefined;
			if (details?.members && details.view) {
				// launch: Team-level state, then the same grouped panels as a grouped subagent call. Problems
				// are colored; collapsed, the goal and reason keep one row each.
				const view = details.view;
				const [title, ...rest] = teamLines(view, details.works ?? [], details.holdsTotal ?? 0, [], details.waitingFor);
				const titleColor = view.lifecycle === "failed" || view.outcome === "failed" ? "error"
					: view.health === "needs_attention" || view.outcome === "partial" || view.lifecycle === "cancelled" || view.lifecycle === "interrupted" ? "warning"
						: view.outcome === "succeeded" ? "success" : "accent";
				const panel = new Container();
				panel.addChild(new TruncatedText(theme.fg(titleColor, theme.bold(title!)), 0, 0));
				for (const line of rest) {
					const color = /^Budget EXHAUSTED/u.test(line) ? "error" : /^(Holds|Incident|\+\d+ more open incidents|Waiting for: Lead decisions? on )/u.test(line) ? "warning" : "dim";
					const styled = theme.fg(color, line);
					panel.addChild(!expanded && /^(Goal|Reason):/u.test(line) ? new TruncatedText(styled, 0, 0) : new Text(styled, 0, 0));
				}
				panel.addChild(renderSubagentTranscript(details.members, expanded, theme, {
					isPartial, mode: "parallel", unit: "member", ...(details.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
					markdownTheme: markdownThemeFromTheme(theme),
				}));
				return panel;
			}
			// Every other action's text is exactly what the model received (prepare keeps its policy/plan lines).
			const text = result.content.flatMap((item) => item.type === "text" ? item.text.split("\n") : []);
			const shown = expanded ? text : text.slice(0, 16);
			const [header, ...rest] = shown;
			return new Text([theme.fg("accent", header ?? ""), ...rest, ...(shown.length < text.length ? [theme.fg("dim", `… ${text.length - shown.length} more lines`)] : [])].join("\n"), 0, 0);
		},
	});
}
