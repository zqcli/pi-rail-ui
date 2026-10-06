import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { TeamMemberSession, TeamSessionHost } from "./team-host";
import type { SubagentUsage } from "./session-broker";
import { normalizeTitle } from "./team-codec";
import { railModelReference } from "./models";
import { COMPACT_THRESHOLD_CHOICES, readCompactThreshold, writeCompactThreshold } from "./team-compaction-settings";
import { flowRows } from "./team-flow";
import type { TeamHistoryEntry } from "./team-history";
import { TEAM_BUDGET_UNLIMITED, isTerminalWorkState, reviewAssessment, shortWorkRef, workRefKey, type TeamMemberView, type TeamOutcome, type TeamReviewPlan, type TeamReviewRecord, type TeamTeamView, type TeamWorkSummary } from "./team-protocol";
import { formatBytes, memberContextText, memberDetail } from "./team-tool";
import { statusColor } from "./transcript";

const TABS = ["Teams", "Overview", "Progress", "Tasks", "Timeline"] as const;
const ICONS = { running: "▶", waiting: "⧗", held: "⏸", idle: "○", completed: "✓", failed: "✗" } as const;
export type TeamOverlayAction = { action: "delete"; teamIds: string[] }
	| { teamId: string; action: "title" }
	| { teamId: string; action: "cancel" | "resume" | "grant" | "message" | "revive" | "compact" | "lead" | "pause" | "continue"; memberId?: string };
type Facts = ReturnType<TeamSessionHost["runtime"]["panelFacts"]>;
/** `header` rows (task group titles) cannot be selected; `field` marks the first line of a selectable Overview field. */
type Row = { text: string; lines?: string[]; teamId?: string; member?: string; fold?: string; work?: TeamWorkSummary; milestone?: string; review?: string; result?: string; header?: boolean; field?: string };
const oneLine = (text: string) => stripTerminalSequences(text).replace(/\s+/gu, " ").trim();
const compact = (text: string, width: number) => truncateToWidth(oneLine(text), Math.max(1, width), "…");
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "", true);
const column = (text: string, width: number) => fit(truncateToWidth(text, Math.max(1, width), "…"), width);
const clock = (ms: number) => {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	const minutes = Math.floor(seconds / 60);
	return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}` : minutes}:${String(seconds % 60).padStart(2, "0")}`;
};
const tokens = (value: number) => value < 1000 ? String(value) : value < 1_000_000 ? `${Math.round(value / 1000)}k` : `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 1 : 2).replace(/\.?0+$/u, "")}M`;
const usageText = (usage: SubagentUsage) => `in ${tokens(usage.input)} · out ${tokens(usage.output)} · cache ${tokens(usage.cacheRead)}${usage.cacheWrite ? `/${tokens(usage.cacheWrite)}` : ""}`;
const teamTitle = (entry: { title?: string }, goal?: string) => entry.title ?? normalizeTitle(undefined, goal ?? "not retained");
const workTitle = (work: TeamWorkSummary) => work.title ?? normalizeTitle(undefined, work.taskPreview);
const stamp = (at: number | undefined) => {
	if (at === undefined) return "—";
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const OUTCOME_ICONS = { succeeded: ["✓", "success"], partial: ["⚠", "warning"], failed: ["✗", "error"] } as const;
const outcomeIcon = (theme: Theme, outcome: TeamOutcome) => theme.fg(OUTCOME_ICONS[outcome][1], OUTCOME_ICONS[outcome][0]);
const teamIcon = (theme: Theme, lifecycle: TeamHistoryEntry["lifecycle"], outcome?: TeamOutcome): string => lifecycle === "active" || lifecycle === "closing" ? theme.fg("accent", "▶")
	: lifecycle === "prepared" ? theme.fg("muted", "○") : outcomeIcon(theme, lifecycle === "closed" || lifecycle === "completed" ? outcome ?? "succeeded" : "failed");
const stateText = (entry: { lifecycle: string; outcome?: string }) => `${entry.lifecycle.toUpperCase()}${entry.outcome ? ` ${entry.outcome === "succeeded" ? "ok" : entry.outcome}` : ""}`;
/** What the Team came to: `active` while it runs, then its outcome and the reason it closed with. */
const outcomeText = (entry: { lifecycle: string; outcome?: string; reason?: string }) => ["prepared", "active", "closing"].includes(entry.lifecycle) ? entry.lifecycle
	: `${entry.outcome ?? entry.lifecycle}${entry.reason ? ` · ${entry.reason}` : ""}`;
const firstSentence = (summary: string) => oneLine(summary).split(/(?<=[.!?])\s/u)[0]!;
const rootCounts = (works: readonly TeamWorkSummary[]) => {
	const roots = works.filter((work) => !work.kind && !work.parent);
	return { accepted: roots.filter((work) => work.review === "accepted").length, waived: roots.filter((work) => work.review === "waived").length, total: roots.length };
};
const writable = (team: TeamTeamView) => team.lifecycle === "prepared" || team.lifecycle === "active" || team.lifecycle === "closing";
const VERDICTS = { on_track: ["on track", "success"], at_risk: ["at risk", "warning"], off_track: ["off track", "error"] } as const;
const verdictOf = (review: TeamReviewRecord) => review.verdict ? VERDICTS[review.verdict] : ["no verdict", "muted"] as const;
const BUDGET_COUNTERS = [["activations", "teamActivations"], ["lead", "leadActivations"], ["model requests", "teamModelRequests"], ["tool calls", "teamToolCalls"], ["works", "teamWorks"]] as const;
const OVERVIEW_LABEL = 10;
type Fact = [label: string, value: string, color?: "warning" | undefined];
const rootsText = (counts: { accepted: number; waived: number; total: number }) => `${counts.accepted}/${counts.total} accepted · ${counts.waived} waived`;
const timeText = (activeMs: number, wallMs: number, pausedMs: number) => `${clock(activeMs)}${pausedMs ? ` active · ${clock(wallMs)} wall (paused ${clock(pausedMs)})` : ""}`;
const workState = (work: TeamWorkSummary) => `${work.hold ? "held" : work.state}${work.review ? `/${work.review}` : ""}`;

function progress(works: readonly TeamWorkSummary[], done = true): string {
	works = works.filter((work) => !work.kind);
	const roots = works.filter((work) => !work.parent);
	return `roots ${roots.filter((work) => work.review === "accepted").length}/${roots.length} accepted · works ${works.filter((work) => work.state === "resolved").length}/${works.length}${done ? " done" : ""}`;
}

function memberStatus(member: TeamMemberView): keyof typeof ICONS {
	return member.lifecycle === "faulted" ? "failed" : member.lifecycle === "closed" ? "completed"
		: member.activity !== "idle" || member.lifecycle === "starting" || member.lifecycle === "closing" ? "running"
			: member.held ? "held" : member.blocked || member.queued ? "waiting" : "idle";
}

function workIcon(work: TeamWorkSummary, theme: Theme): string {
	if (work.hold) return theme.fg(statusColor("held"), ICONS.held);
	if (work.state === "resolved") return work.review === "waived" ? theme.fg("warning", "✗") : theme.fg(work.review === "accepted" ? "success" : "dim", !work.parent && !work.review ? "◐" : "✓");
	if (work.state === "cancelled" || work.state === "superseded") return theme.fg("muted", "–");
	const status = work.state === "blocked" ? "waiting" : work.state === "queued" ? "idle" : work.state;
	return theme.fg(statusColor(status), ICONS[status]);
}

/** The latest revision of every deliverable and sub-task (review works excluded), and each work's children. */
function workTree(works: readonly TeamWorkSummary[]) {
	const latest = new Map<string, TeamWorkSummary>();
	for (const work of works) if (!work.kind && (latest.get(work.work.workId)?.work.revision ?? 0) < work.work.revision) latest.set(work.work.workId, work);
	const children = new Map<string, TeamWorkSummary[]>();
	for (const work of latest.values()) if (work.parent) {
		const siblings = children.get(work.parent.workId) ?? [];
		siblings.push(work);
		children.set(work.parent.workId, siblings);
	}
	return { latest, children };
}

/** Parent ownership survives revisions: keep older children under their owning work. `only` limits the rows to that root's subtree. */
export function buildTeamTaskRows(works: readonly TeamWorkSummary[], expanded: ReadonlySet<string>, theme: Theme, width = 120,
	describe: (work: TeamWorkSummary) => string = workState, only?: string): Row[] {
	const { latest, children } = workTree(works);
	const rows: Row[] = [];
	const titleWidth = Math.max(10, Math.floor(width * 0.42));
	const assigneeWidth = Math.min(Math.floor(width * 0.2), Math.max(1, ...[...latest.values()].map((work) => visibleWidth(work.assignee))));
	const visit = (work: TeamWorkSummary, depth: number) => {
		const label = `${"  ".repeat(depth)}${workIcon(work, theme)} ${workTitle(work)}`;
		const revision = work.work.revision > 1 ? ` @${work.work.revision} (rev ${work.work.revision - 1}×)` : "";
		const state = describe(work);
		const stateWidth = work.state === "resolved" && !work.parent && !work.review ? visibleWidth(state) : 15;
		const prefix = `${column(label, Math.min(titleWidth, width - assigneeWidth - revision.length - stateWidth - 4))}  ${column(work.assignee, assigneeWidth)}  `;
		rows.push({ work, text: `${prefix}${compact(state, width - visibleWidth(prefix + revision))}${revision}` });
		const nested = children.get(work.work.workId) ?? [];
		const cancelled = nested.filter((child) => child.state === "cancelled" || child.state === "superseded");
		const finished = nested.filter((child) => child.state === "resolved");
		for (const child of nested) if (!cancelled.includes(child) && !(finished.length > 5 && finished.includes(child))) visit(child, depth + 1);
		const fold = (items: TeamWorkSummary[], kind: string, label: string) => {
			if (!items.length) return;
			const key = `${work.work.workId}:${kind}`;
			rows.push({ work, fold: key, text: `${"  ".repeat(depth + 1)}${label} [${expanded.has(key) ? "−" : "+"}]` });
			if (expanded.has(key)) for (const child of items) visit(child, depth + 1);
		};
		fold(cancelled, "cancelled", `– ${cancelled.length} cancelled/superseded`);
		if (finished.length > 5) fold(finished, "done", `✓ ${finished.length} sub-tasks done`);
	};
	for (const work of latest.values()) if (!work.parent && (!only || work.work.workId === only)) visit(work, 0);
	return rows;
}

function assignedWork(member: TeamMemberView, works: readonly TeamWorkSummary[]): TeamWorkSummary | undefined {
	const assigned = works.filter((work) => work.assignee === member.id);
	return assigned.find((work) => member.currentWork && workRefKey(work.work) === workRefKey(member.currentWork))
		?? assigned.find((work) => !isTerminalWorkState(work.state)) ?? assigned.at(-1);
}

function latestResult(memberId: string, works: TeamWorkSummary[], facts: Facts): string {
	const latest = facts.results.get(memberId)?.latest;
	if (!latest) return "Latest result: none";
	const work = works.find((work) => work.work.workId === latest.work.workId)!;
	const fate = work.work.revision !== latest.work.revision ? `superseded by @${work.work.revision}` : work.parent ? "" : work.review ?? "awaiting acceptance";
	return `Latest result: ${latest.result.status} · "${oneLine(latest.result.summary)}"${fate ? ` · ${fate}` : ""}`;
}

export class TeamOverlayComponent implements Focusable {
	focused = false;
	private teamId: string | undefined;
	private tab = 0;
	private selected = 0;
	private offset = 0;
	private pageSize = 1;
	private maxSelected = 0;
	private rows: Row[] = [];
	private detail: string | undefined;
	private reviewing = false;
	private expanded = new Set<string>();
	/** The deliverable whose sub-tasks are listed, the Tasks filter and the selected Overview field. */
	private root: string | undefined;
	/** The deliverable whose row the cursor follows after a fold change moved rows above it. */
	private follow: string | undefined;
	private view: "all" | "active" = "all";
	private field = 0;
	private marked = new Set<string>();
	private readonly sessions = new Map<string, Map<string, TeamMemberSession>>();
	private followTimeline = true;
	private timelineCursor: string | undefined;
	private notice = "";
	private disposed = false;
	private readonly unsubscribe: Array<() => void>;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (action: TeamOverlayAction | undefined) => void,
		private readonly host: TeamSessionHost,
		private readonly now: () => number = Date.now,
	) {
		const teams = host.runtime.listTeams();
		const active = teams.find((team) => team.lifecycle === "active");
		this.teamId = active?.teamId ?? this.teamIds()[0];
		this.tab = active || this.teamIds().length === 1 ? 1 : 0;
		const refresh = () => { if (!this.disposed) this.tui.requestRender(); };
		this.unsubscribe = [host.runtime.onChange(refresh), host.driver.onActivity(refresh)];
		this.timer = setInterval(refresh, 1000);
		this.timer.unref();
	}

	invalidate(): void {}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
		for (const unsubscribe of this.unsubscribe) unsubscribe();
	}

	private teamIds(): string[] {
		const live = this.host.runtime.listTeams().map((team) => team.teamId);
		return [...live, ...this.host.history.teams.filter((entry) => !live.includes(entry.teamId)).toSorted((a, b) => b.at - a.at).map((entry) => entry.teamId)];
	}

	/** Only Teams of this session keep their work ledger; history has just the retained results. */
	private ledger(): boolean {
		return this.host.runtime.listTeams().some((team) => team.teamId === this.teamId);
	}

	/** Group headers cannot be selected: step past them in the direction of travel, or back the other way at an edge. */
	private skipHeaders(direction: number): void {
		for (const by of [direction, -direction]) {
			while (this.rows[this.selected]?.header) this.selected += by;
			this.selected = Math.max(0, Math.min(this.selected, this.rows.length - 1));
		}
	}

	/** A different Team starts with every Tasks fold and filter reset. */
	private openTeam(teamId: string | undefined): void {
		this.teamId = teamId;
		this.expanded.clear();
		this.root = undefined;
		this.view = "all";
		this.reviewing = false;
		this.field = 0;
		this.resetPosition();
	}

	private resetPosition(): void {
		this.selected = 0;
		this.offset = 0;
		this.detail = undefined;
		this.followTimeline = true;
		this.timelineCursor = undefined;
		this.notice = "";
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.detail) this.resetPosition();
			else if (this.reviewing) { this.reviewing = false; this.resetPosition(); }
			else if (this.tab !== 0) { this.tab = 0; this.resetPosition(); }
			else { this.dispose(); this.done(undefined); return; }
		} else if (this.tab === 3 && !this.detail && this.ledger() && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
			const row = this.rows[this.selected];
			if (matchesKey(data, Key.right)) {
				if (row?.fold) this.expanded.add(row.fold);
				else if (row?.work && !row.work.parent) this.follow = this.root = row.work.work.workId;
			} else if (row?.fold) this.expanded.delete(row.fold);
			else if (this.root) {
				this.follow = this.root;
				this.root = undefined;
			}
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const back = matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"));
			this.tab = (this.tab + (back ? TABS.length - 1 : 1)) % TABS.length;
			this.reviewing = false;
			this.field = 0;
			this.resetPosition();
		} else if (data === "f" && this.tab === 3 && !this.detail && this.ledger()) {
			this.view = this.view === "all" ? "active" : "all";
			this.resetPosition();
		} else if (data === " " && this.tab === 0) {
			const teamId = this.rows[this.selected]?.teamId;
			if (teamId && !this.marked.delete(teamId)) this.marked.add(teamId);
		} else if (data === "d") {
			const teamIds = this.tab === 0 ? this.marked.size ? this.teamIds().filter((id) => this.marked.has(id)) : [this.rows[this.selected]?.teamId].filter((id): id is string => !!id)
				: this.teamId ? [this.teamId] : [];
			if (teamIds.length) { this.dispose(); this.done({ action: "delete", teamIds }); return; }
		} else if (data === "n" && (this.tab === 0 || this.tab === 1 && !this.reviewing && !this.detail)) {
			const teamId = this.tab === 0 ? this.rows[this.selected]?.teamId : this.teamId;
			if (teamId) { this.dispose(); this.done({ action: "title", teamId }); return; }
		} else if (data === "t") {
			const choices = COMPACT_THRESHOLD_CHOICES;
			const threshold = readCompactThreshold();
			try { writeCompactThreshold(choices[(choices.findIndex((choice) => choice === threshold) + 1) % choices.length]!); }
			catch (error) { this.notice = error instanceof Error ? error.message : String(error); }
		} else if (data === "[" || data === "]") {
			const ids = this.teamIds();
			this.openTeam(ids[(ids.indexOf(this.teamId!) + (data === "[" ? -1 : 1) + ids.length) % ids.length]);
			if (this.tab === 0) this.selected = ids.indexOf(this.teamId!);
		} else if (this.tab === 1 && !this.reviewing && !this.detail && (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down"))) {
			// The Overview cursor moves between its fields; the scroll offset follows the field's first line.
			const starts = this.rows.flatMap((row, index) => row.field ? [index] : []);
			this.field = Math.max(0, Math.min(starts.length - 1, this.field + (this.keybindings.matches(data, "tui.select.up") ? -1 : 1)));
			this.selected = starts[this.field] ?? 0;
		} else if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown) || matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
			const step = this.keybindings.matches(data, "tui.select.up") ? -1 : this.keybindings.matches(data, "tui.select.down") ? 1 : matchesKey(data, Key.pageUp) ? -this.pageSize : this.pageSize;
			this.selected = matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? this.rows.length - 1 : this.selected + step;
			this.selected = Math.max(0, Math.min(this.maxSelected, this.selected));
			this.skipHeaders(step < 0 || matchesKey(data, Key.end) ? -1 : 1);
			this.followTimeline = this.selected === this.rows.length - 1;
			this.timelineCursor = this.rows[this.selected]?.milestone;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			const row = this.rows[this.selected];
			if (row?.teamId) { this.openTeam(row.teamId); this.tab = 1; }
			else if (this.tab === 1 && !this.reviewing && !this.detail) {
				const field = this.rows.filter((item) => item.field)[this.field]?.field;
				if (field === "review") this.reviewing = true;
				this.resetPosition();
				if (field && field !== "review") this.detail = field;
			}
			else if (row?.member ?? row?.review ?? row?.result) { this.resetPosition(); this.detail = row.member ?? row.review ?? row.result; }
			else if (row?.fold) {
				if (!this.expanded.delete(row.fold)) this.expanded.add(row.fold);
			}
			else if (row?.work) { this.resetPosition(); this.detail = workRefKey(row.work.work); }
		} else {
			const team = this.host.runtime.listTeams().find((team) => team.teamId === this.teamId);
			const action = ({ c: "cancel", r: "resume", g: "grant", m: "message", v: "revive", z: "compact", l: "lead", p: team?.paused ? "continue" : "pause" } as const)[data as "c" | "r" | "g" | "m" | "v" | "z" | "l" | "p"];
			if (action && team && writable(team) && this.host.active) {
				this.dispose();
				const memberId = action === "compact" && this.tab === 2 ? this.detail ?? this.rows[this.selected]?.member : undefined;
				this.done({ teamId: team.teamId, action, ...(memberId ? { memberId } : {}) });
				return;
			}
			if (action) this.notice = "This Team is read-only.";
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const ids = this.teamIds();
		this.teamId ??= ids[0];
		const team = this.host.runtime.listTeams().find((team) => team.teamId === this.teamId);
		const history = this.host.history.teams.find((entry) => entry.teamId === this.teamId);
		const works = team ? this.host.runtime.listWorks(team.teamId) : [];
		const facts = team ? this.host.runtime.panelFacts(team.teamId) : undefined;
		const reviews = team ? this.host.runtime.listReviews(team.teamId) : history?.reviews ?? [];
		let rows: Row[] = [];
		if (this.tab === 0) rows = ids.length ? this.teams(inner - 3) : [{ text: "No teams" }];
		else if (this.reviewing && (team || history)) rows = this.detail ? this.reviewDetail(reviews, inner - 1) : this.reviewRows(reviews, inner - 3);
		else if (this.tab === 1 && this.detail && (team || history)) rows = this.fullText(team ?? history!, team?.brief.goal ?? history?.goal ?? "", inner - 1);
		else if (team && facts) {
			if (this.detail) rows = this.tab === 3 ? this.taskDetail(team, works, facts, inner - 1) : this.memberDetail(team, works, facts, inner - 1);
			else if (this.tab === 1) rows = this.overview(team, works, facts, inner - 1);
			else if (this.tab === 2) rows = this.members(team, works, facts, inner - 3);
			else if (this.tab === 3) rows = this.taskRows(team, works, inner - 3);
			else rows = this.timeline(facts, works);
		} else if (history) rows = this.historyRows(history, inner - ((this.tab === 2 || this.tab === 3) && !this.detail ? 3 : 1));
		else rows = [{ text: "No teams" }];
		this.rows = rows;
		if (this.tab === 4) {
			if (this.followTimeline) this.selected = rows.length - 1;
			else if (this.timelineCursor) {
				const index = rows.findIndex((row) => row.milestone === this.timelineCursor);
				if (index >= 0) this.selected = index;
			}
		}
		if (this.follow) {
			// The cursor stays where it is when that row is hidden (a folded Done group).
			const index = rows.findIndex((row) => row.work?.work.workId === this.follow && !row.fold);
			if (index >= 0) this.selected = index;
			this.follow = undefined;
		}
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		this.skipHeaders(1);
		this.timelineCursor = rows[this.selected]?.milestone;
		// Overview already shows Waiting for in its body.
		const notice = this.tab > 1 && /^Lead (decision|failed)/u.test(facts?.waitingFor ?? "") ? `Waiting for: ${facts!.waitingFor}`
			: this.notice;
		const omitted = this.tab === 4 && facts?.timelineOmitted ? `… ${facts.timelineOmitted} earlier milestones omitted …` : "";
		const summary = this.tab === 0 ? `${ids.length} Team${ids.length === 1 ? "" : "s"} · ${this.host.runtime.listTeams().filter((item) => writable(item) && item.lifecycle !== "prepared").length} active`
			: !team && !history ? "No teams" : this.tab === 1 ? this.overviewHeader(team, history, inner - 1)
				: this.tab === 3 && team ? this.tasksSummary(works, inner - 1) : team && facts ? this.summaryText(team, works)
					: `${history!.lifecycle.toUpperCase()} · history (read-only) · ${history!.results.length} results${this.tab === 3 ? " · ledger not retained" : ""}`;
		const summaryLines = this.tab === 3 && team ? [summary] : wrapTextWithAnsi(summary, inner - 1);
		const height = Math.max(1, Math.min(this.tui.terminal.rows - 2, Math.floor(this.tui.terminal.rows * 0.88)));
		const live = !!team && writable(team) && this.host.active;
		const help = this.helpLines(live, ids.length > 1, !!team?.paused, !!team, inner - 1).flatMap((text) => wrapTextWithAnsi(text, inner - 1));
		const room = height - 5 - summaryLines.length - help.length - (notice ? 1 : 0) - (omitted ? 1 : 0);
		const schedule = team ? this.host.runtime.reviewSchedule(team.teamId) : history?.review;
		const head = (!this.detail && this.reviewing ? [this.reviewHeading(reviews, schedule), ""]
			: !this.detail && this.tab === 2 ? team ? this.progressHead(team, inner - 1) : history ? this.historyProgressHead(history, inner - 1) : [] : []).slice(0, Math.max(0, room - 3));
		const available = Math.max(1, room - head.length);
		const selectable = !this.detail && (this.reviewing ? reviews.length > 0 : this.tab === 0 ? ids.length > 0 : this.tab !== 1 && !!team || this.tab === 2 && !!history?.members.length || this.tab === 3 && !!history?.results.length);
		const rowHeight = Math.max(1, ...rows.map((row) => 1 + (row.lines?.length ?? 0)));
		const cap = this.tab === 4 ? 12 : this.tab === 0 ? available : Math.min(8, this.tui.terminal.rows - 13);
		const rowsFor = (lines: number) => Math.max(1, Math.min(cap, Math.floor(lines / rowHeight)));
		// Progress and Tasks mark the rows hidden above and below the page, which costs up to two lines.
		const markers = selectable && (this.tab === 2 || this.tab === 3) && rows.length > rowsFor(available) ? 2 : 0;
		this.pageSize = selectable ? rowsFor(available - markers) : available;
		const details = this.detail || this.tab === 0 ? [] : this.reviewing ? this.reviewDetails(reviews, inner - 1) : team && facts ? this.selectionDetails(team, works, facts, inner - 1) : this.tab === 2 && history ? this.historyMembers(history).filter((text) => text.startsWith(`${this.rows[this.selected]?.member} ·`)).map((text) => compact(text, inner - 1)) : [];
		const showDetails = details.length > 0 && available >= Math.min(rows.length, this.pageSize) * rowHeight + markers + details.length + 1;
		this.offset = Math.max(0, Math.min(this.offset, rows.length - this.pageSize));
		// Without a visible cursor the hidden cursor is the scroll offset, so every key scrolls at once.
		this.maxSelected = selectable ? rows.length - 1 : Math.max(0, rows.length - this.pageSize);
		if (!selectable) this.offset = this.selected = Math.min(this.selected, this.maxSelected);
		// A group header stays visible above its first row.
		if (this.selected < this.offset) this.offset = this.selected - (rows[this.selected - 1]?.header ? 1 : 0);
		if (this.selected >= this.offset + this.pageSize) this.offset = this.selected - this.pageSize + 1;
		const more = (count: number, arrow: string) => markers && count > 0 ? [`   ${this.theme.fg("dim", `${arrow} ${count} more`)}`] : [];
		const body = [...more(this.offset, "↑"), ...rows.slice(this.offset, this.offset + this.pageSize).flatMap((row, index) => {
			const prefix = !selectable ? " " : index + this.offset === this.selected ? this.theme.fg("accent", " → ") : "   ";
			return [`${prefix}${row.text}`, ...(row.lines ?? []).map((text) => `     ${text}`)];
		}), ...more(rows.length - this.offset - this.pageSize, "↓")];
		if (this.tab === 4 && !this.detail) while (body.length < this.pageSize) body.push("");
		const selector = ids.length > 1 ? `‹ ${ids.indexOf(this.teamId!) + 1}/${ids.length} ›` : "";
		const title = `${this.theme.fg("accent", this.theme.bold("Rail Team"))}  ${this.renderTabs(inner - 12 - (selector ? visibleWidth(selector) + 2 : 0))}`;
		const header = selector ? `${fit(title, inner - visibleWidth(selector) - 2)} ${this.theme.fg("dim", selector)}` : title;
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const line = (text = "") => `${this.theme.fg("border", "│")}${fit(text, inner)}${this.theme.fg("border", "│")}`;
		return [border(`╭${"─".repeat(inner)}╮`), line(` ${header}`), ...summaryLines.map((text) => line(` ${this.theme.fg("dim", text)}`)), line(),
			...(omitted ? [line(` ${this.theme.fg("dim", omitted)}`)] : []), ...head.map((text) => line(` ${text}`)), ...body.map(line),
			...(showDetails ? [line(), ...details.map((text) => line(` ${text}`))] : []), line(),
			...(notice ? [line(` ${this.theme.fg("warning", compact(notice, inner - 1))}`)] : []),
			...help.map((text) => line(` ${this.theme.fg("dim", text)}`)), border(`╰${"─".repeat(inner)}╯`)];
	}

	private renderTabs(width: number): string {
		const tabs = TABS.map((tab, index) => index === this.tab ? this.theme.fg("accent", `[${tab}]`) : this.theme.fg("dim", tab));
		let start = 0, end = tabs.length;
		while (end - start > 1 && visibleWidth(tabs.slice(start, end).join(" ")) > width) {
			if (this.tab - start > end - this.tab - 1) start++;
			else end--;
		}
		return tabs.slice(start, end).join(" ");
	}

	private summaryText(team: TeamTeamView, works: TeamWorkSummary[]): string {
		const counts = (["running", "held", "waiting"] as const).flatMap((status) => {
			const count = team.members.filter((member) => memberStatus(member) === status).length;
			return count ? [`${count} ${status}`] : [];
		});
		return [team.lifecycle.toUpperCase(), ...(team.paused ? ["PAUSED"] : []), team.health === "ok" ? "ok" : "needs attention", clock(this.host.runtime.teamTime(team.teamId).activeMs), progress(works, false), ...counts,
			...(!writable(team) || !this.host.active ? ["read-only"] : [])].join(" · ");
	}

	private teams(width: number): Row[] {
		const live = this.host.runtime.listTeams();
		return this.teamIds().map((teamId) => {
			const team = live.find((item) => item.teamId === teamId);
			const history = this.host.history.teams.find((item) => item.teamId === teamId);
			const source = team ?? history!;
			const time = team ? this.host.runtime.teamTime(teamId) : undefined;
			const duration = time ? clock(time.activeMs) : history!.activeMs !== undefined ? clock(history!.activeMs) : history!.startedAt !== undefined ? clock(history!.at - history!.startedAt) : "—";
			const counts = team ? rootCounts(this.host.runtime.listWorks(teamId)) : history!.rootCounts;
			const facts = [teamId.slice(0, 8), stateText(source), duration, stamp(time?.startedAt ?? history?.startedAt)];
			const roots = `roots ${counts ? `${counts.accepted}/${counts.total}` : "—"}`;
			// The member count is the first fact to go when the line is too narrow.
			const full = [...facts, `${team?.members.length ?? history!.members.length} members`, roots].join(" · ");
			const meta = visibleWidth(full) <= width - 4 ? full : [...facts, roots].join(" · ");
			return { teamId, text: `${this.marked.has(teamId) ? "*" : teamIcon(this.theme, source.lifecycle, source.outcome)} ${compact(teamTitle(source, team?.brief.goal ?? history?.goal), width - 2)}`,
				lines: [`  ${this.theme.fg("dim", compact(meta, width - 4))}`] };
		});
	}

	/** Navigation for the current view, then (live Teams only) every action key with its name; the caller wraps rows wider than the popup. */
	private helpLines(live: boolean, multiple: boolean, paused: boolean, ledger: boolean, width: number): string[] {
		if (this.tab === 0) return ["↑↓ select · enter open · n rename · space mark · d delete · esc close", "←→/tab views" + (multiple ? " · [ ] teams" : "")];
		if (this.reviewing) return [this.detail ? "↑↓/pgup/dn scroll · esc reviews" : "↑↓ select · enter details · esc overview"];
		if (this.detail) return [`↑↓/pgup/dn scroll · esc ${["", "overview", "progress", "tasks"][this.tab]}`];
		const view = this.tab === 1 ? "↑↓ select · enter open · n rename" : this.tab === 2 ? "↑↓ select · enter details" : this.tab === 3 ? `↑↓ select · enter details${ledger ? " · → expand · f filter" : ""}`
			: "↑↓ cursor · pgup/dn page · home/end";
		// ← and → fold the Tasks list, so only Tab switches views there; that hint moves to a second row.
		const folding = this.tab === 3 && ledger;
		const navigation = [view, ...(live && this.tab === 2 ? ["z compact"] : []), ...(folding ? [] : ["←→/tab views"]), "esc teams"].join(" · ");
		// Whole keys per row: a key is never split or left with a dangling separator.
		const threshold = readCompactThreshold();
		const keys = [paused ? "p continue" : "p pause", "c cancel", "r resume hold", "g grant", "m message", "v revive", "l new lead", "z compact", `t compact at ${threshold === null ? "off" : `${threshold}%`}`, "d delete"];
		const rows = keys.reduce<string[]>((packed, key) => packed.length && packed.at(-1)!.length + 3 + key.length <= width ? [...packed.slice(0, -1), `${packed.at(-1)} · ${key}`] : [...packed, key], []);
		return live && this.tab === 1 ? [navigation, ...rows] : folding ? [navigation, "← collapse · tab views"] : [navigation];
	}

	/** Budget meters: a bar with eighth-cell resolution, so even a small share of a large limit is visible. */
	private budget(teamId: string, cells: number): Array<{ label: string; meter: string }> {
		const { used, limits } = this.host.runtime.inspectBudget(teamId);
		return BUDGET_COUNTERS.map(([label, key]) => {
			const value = used[key], limit = limits[key];
			if (limit >= TEAM_BUDGET_UNLIMITED) return { label, meter: `${value} · unlimited` };
			const share = limit ? Math.min(1, value / limit) : 1;
			const eighths = value > 0 ? Math.max(1, Math.round(share * cells * 8)) : 0;
			const full = Math.floor(eighths / 8), partial = eighths % 8;
			const bar = `${"█".repeat(full)}${partial ? "▏▎▍▌▋▊▉"[partial - 1] : ""}`;
			const color = share >= 1 ? "error" : share >= 0.8 ? "warning" : "accent";
			return { label, meter: `${this.theme.fg(color, bar)}${this.theme.fg("dim", "░".repeat(cells - full - (partial ? 1 : 0)))}  ${value}/${limit} · ${Math.floor(share * 100)}%` };
		});
	}

	/** Two header lines for the summary slot: the title, then short id · state · start → end. */
	private overviewHeader(team: TeamTeamView | undefined, history: TeamHistoryEntry | undefined, width: number): string {
		const source = team ?? history!;
		const time = team ? this.host.runtime.teamTime(team.teamId) : undefined;
		const startedAt = time?.startedAt ?? history?.startedAt;
		const endedAt = time ? time.endedAt : history!.at;
		const range = startedAt === undefined ? [] : [`${stamp(startedAt)} → ${endedAt === undefined ? "now" : stamp(endedAt).slice(6)}`];
		return `${compact(teamTitle(source, team?.brief.goal ?? history?.goal), width)}\n${[source.shortId ?? source.teamId.slice(0, 8), `${stateText(source)}${team?.paused ? " · PAUSED" : ""}`, ...range].join(" · ")}`;
	}

	/** At most two wrapped lines of a long value; a cut ends in … and a right-aligned dim ›. */
	private clip(text: string, width: number): string[] {
		const lines = wrapTextWithAnsi(oneLine(text), width);
		return lines.length <= 2 ? lines : [lines[0]!, this.more(truncateToWidth(`${lines[1]}…`, width - 2, "…"), width)];
	}

	private more(line: string, width: number): string {
		return `${fit(line, width - 1)}${this.theme.fg("dim", "›")}`;
	}

	private nextReview(schedule: { nextAt?: number | null } | undefined): string {
		return schedule?.nextAt ? ` · next in ${Math.max(0, Math.ceil((schedule.nextAt - this.now()) / 60_000))}m` : "";
	}

	/** The latest verdict on one line, then the review count; › when the review list can be opened. */
	private reviewLines(reviews: readonly TeamReviewRecord[], schedule: (TeamReviewPlan & { nextAt?: number | null }) | undefined, width: number): string[] {
		const review = reviews.at(-1);
		const [verdict, color] = review ? verdictOf(review) : ["", "muted"] as const;
		const latest = review ? `${clock(review.snapshot.elapsedMs)} ${review.by} ${this.theme.fg(review.verdict === "off_track" ? "warning" : color, verdict.toUpperCase())} · ${oneLine(reviewAssessment(review.summary))}` : schedule ? `No reviews yet · ${schedule.by} every ${schedule.everyMinutes} min${this.nextReview(schedule)}` : "off";
		const count = `${reviews.length} review${reviews.length === 1 ? "" : "s"} · ${reviews.filter((item) => item.verdict === "at_risk" || item.verdict === "off_track").length} at risk${this.nextReview(schedule)}`;
		const lines = [truncateToWidth(latest, width, "…"), ...(review ? [count] : [])];
		return review ? [...lines.slice(0, -1), this.more(lines.at(-1)!, width)] : lines;
	}

	/** The foldable fields (` → ` marks the selected one) and the plain facts below them, one row per line with a hanging indent under the value column. */
	private overviewRows(width: number, fields: Array<{ field: string; label: string; lines: string[] }>, facts: Fact[]): Row[] {
		const labeled = (marker: string, label: string, lines: string[], color?: "warning") => lines.map((line, index) => {
			const text = `${index ? "  " : `${marker} `}${(index ? "" : label).padEnd(OVERVIEW_LABEL)}${line}`;
			return { text: color ? this.theme.fg(color, text) : text };
		});
		this.field = Math.min(this.field, fields.length - 1);
		return [...fields.flatMap(({ field, label, lines }, index) => labeled(index === this.field ? this.theme.fg("accent", "→") : " ", label, lines).map((row, line) => line ? row : { ...row, field })),
			...(facts.length ? [{ text: "" }] : []), ...facts.flatMap(([label, value, color]) => labeled(" ", label, wrapTextWithAnsi(value, width - OVERVIEW_LABEL - 2), color))];
	}

	private overview(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		const value = width - OVERVIEW_LABEL - 2;
		const time = this.host.runtime.teamTime(team.teamId);
		const holds = this.host.runtime.listHolds(team.teamId);
		const incidents = team.incidents.filter((incident) => incident.state === "open");
		const { used, limits } = this.host.runtime.inspectBudget(team.teamId);
		const budget: Fact[] = BUDGET_COUNTERS.slice(0, 4).every(([, key]) => limits[key] >= TEAM_BUDGET_UNLIMITED)
			? [["Budget", `all counters unlimited · works ${used.teamWorks}/${limits.teamWorks >= TEAM_BUDGET_UNLIMITED ? "unlimited" : limits.teamWorks}`]]
			: this.budget(team.teamId, Math.max(6, Math.min(20, value - 16 - 22))).map(({ label, meter }, index) => [index ? "" : "Budget", `${label.padEnd(15)} ${meter}`]);
		return this.overviewRows(width, [
			{ field: "goal", label: "Goal", lines: this.clip(team.brief.goal, value) },
			{ field: "outcome", label: "Outcome", lines: this.clip(outcomeText(team), value) },
			{ field: "review", label: "Review", lines: this.reviewLines(this.host.runtime.listReviews(team.teamId), this.host.runtime.reviewSchedule(team.teamId), value) },
		], [
			["Time", timeText(time.activeMs, time.wallMs, time.pausedMs)], ["Tokens", usageText(team.usage)], ["Roots", rootsText(rootCounts(works))],
			["Waiting", this.overviewWaitingFor(team, works, facts), /^Lead (decision|failed)/u.test(facts.waitingFor ?? "") ? "warning" : undefined],
			["Attention", holds.length || incidents.length ? `${holds.length} open holds · ${incidents.length} open incidents` : "none", holds.length || incidents.length ? "warning" : undefined],
			...holds.map((hold): Fact => ["", `${hold.assignee} · ${shortWorkRef(hold.work)} · ${oneLine(hold.message)}`, "warning"]),
			...incidents.filter((incident) => !holds.some((hold) => hold.incidentId === incident.id)).map((incident): Fact => ["", `${incident.code}: ${oneLine(incident.message)}`, "warning"]),
			...budget,
		]);
	}

	private historyOverview(entry: TeamHistoryEntry, width: number): Row[] {
		const value = width - OVERVIEW_LABEL - 2;
		const wall = entry.startedAt === undefined ? undefined : entry.at - entry.startedAt;
		const active = entry.activeMs ?? wall;
		return this.overviewRows(width, [
			...(entry.goal ? [{ field: "goal", label: "Goal", lines: this.clip(entry.goal, value) }] : []),
			{ field: "outcome", label: "Outcome", lines: this.clip(outcomeText(entry), value) },
			{ field: "review", label: "Review", lines: this.reviewLines(entry.reviews ?? [], entry.review, value) },
		], [
			...(active === undefined ? [] : [["Time", timeText(active, wall ?? active, wall === undefined || entry.activeMs === undefined ? 0 : Math.max(0, wall - entry.activeMs))] as Fact]),
			...(entry.usage ? [["Tokens", usageText(entry.usage)] as Fact] : []), ...(entry.rootCounts ? [["Roots", rootsText(entry.rootCounts)] as Fact] : []),
		]);
	}

	/** The full Goal or Outcome text on a scrollable page. */
	private fullText(source: TeamTeamView | TeamHistoryEntry, goal: string, width: number): Row[] {
		return [this.detail === "goal" ? "Goal · Esc back" : "Outcome · Esc back", "", this.detail === "goal" ? goal : outcomeText(source)]
			.flatMap((text) => wrapTextWithAnsi(stripTerminalSequences(text), width).map((line) => ({ text: line })));
	}

	private overviewWaitingFor(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts): string {
		const text = facts.waitingFor ?? "—";
		if (/^(Lead|Paused)/u.test(text)) return text;
		return this.workReferences(text.replace(/([^·]+) \(running\)/gu, (_match, names: string) => names.trim().split(", ").map((name) => {
			const member = team.members.find((member) => member.id === name);
			const work = member?.currentWork && works.find((work) => work.work.workId === member.currentWork!.workId);
			return work ? `${name} on ${shortWorkRef(work.work)} «${workTitle(work)}» (running ${clock(this.host.runtime.workStats(team.teamId, work.work).activeMs)})` : `${name} (running)`;
		}).join(", ")), works);
	}

	private members(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		const label = (member: TeamMemberView) => member.id === team.lead ? `${member.id} (lead)` : member.id;
		const aliasWidth = Math.min(Math.floor(width * 0.27), Math.max(...team.members.map((member) => visibleWidth(label(member)))));
		const activeMs = this.host.runtime.teamTime(team.teamId).activeMs;
		return team.members.map((member) => {
			const status = memberStatus(member);
			const context = memberContextText(member);
			const prefix = `${this.theme.fg(statusColor(status), ICONS[status])} ${column(label(member), aliasWidth)}  `;
			const stats = this.host.runtime.memberStats(team.teamId, member.id);
			const busy = activeMs ? Math.round(stats.activeMs / activeMs * 100) : 0;
			const state = member.currentWork && member.lifecycle === "open" ? `running ${shortWorkRef(member.currentWork)}` : oneLine(memberDetail(member, facts, works, team.lead)).replace(/waiting on \d+ sub-tasks?: /u, "waiting for ");
			const now = member.currentWork ? ` · now ${clock(this.host.runtime.workStats(team.teamId, member.currentWork).activeMs)}` : "";
			const contextText = member.context && !member.compacting && !member.lastCompaction ? `ctx ${Math.round(member.context.percent)}%` : context;
			const ctx = contextText ? `  ${member.context && member.context.percent >= 80 ? this.theme.fg("warning", contextText) : contextText}` : "";
			const detail = `active ${clock(stats.activeMs)} · ${busy >= 90 ? this.theme.fg("warning", `busy ${busy}%`) : `busy ${busy}%`} · ${usageText(stats.usage)}`;
			return { member: member.id, text: `${prefix}${column(state + now, width - visibleWidth(prefix + ctx))}${ctx}`,
				lines: wrapTextWithAnsi(detail, width - 2) };
		});
	}

	private selectionDetails(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): string[] {
		const row = this.rows[this.selected];
		const title = (text: string) => this.theme.fg("toolTitle", this.theme.bold(text));
		const dim = (text: string) => this.theme.fg("dim", compact(text, width));
		if (this.tab === 2 && row?.member) {
			const member = team.members.find((member) => member.id === row.member)!;
			const work = assignedWork(member, works);
			return [...wrapTextWithAnsi(`${member.id}${work ? ` · ${workTitle(work)} · from ${work.requester} · ${shortWorkRef(work.work)}` : ` · ${member.id === team.lead ? team.brief.goal : "No assigned work"}`}`, width).map(title),
				dim(latestResult(member.id, works, facts))];
		}
		if (this.tab === 3 && row?.work) {
			const work = row.work;
			const stats = this.host.runtime.workStats(team.teamId, work.work);
			const result = work.resultRef ? this.host.runtime.getResult(team.teamId, work.resultRef)?.result : undefined;
			// Two lines: a long title is cut so the route and work ref stay visible.
			const route = ` · ${work.requester} → ${work.assignee} · ${shortWorkRef(work.work)}${work.work.revision > 1 ? ` (rev ${work.work.revision - 1}×)` : ""}`;
			return [title(`${compact(workTitle(work), width - visibleWidth(route))}${route}`),
				dim(`active ${clock(stats.activeMs)} · ${usageText(stats.usage)}${result ? ` · "${firstSentence(result.summary)}"` : ""}`)];
		}
		return [];
	}

	private memberDetail(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		const member = team.members.find((member) => member.id === this.detail)!;
		const work = assignedWork(member, works);
		const task = work ? this.host.runtime.getWork(team.teamId, work.work)?.current.task : undefined;
		const lines = [`Member ${member.id} · Esc back`, ...(memberContextText(member) ? [memberContextText(member)] : []), `Task: ${task ?? (member.id === team.lead ? team.brief.goal : "No assigned work")}`, "Outbound works:",
			...works.filter((work) => work.requester === member.id).map((work) => `  ${shortWorkRef(work.work)} → ${work.assignee} · ${work.hold ? "held" : work.state}`)];
		const latest = facts.results.get(member.id)?.latest;
		if (latest) lines.push(`Latest result: ${latest.result.status} · ${latest.id}`, latestResult(member.id, works, facts), latest.result.summary);
		else lines.push("Latest result: none");
		return lines.flatMap((text) => wrapTextWithAnsi(stripTerminalSequences(text), width).map((text) => ({ text })));
	}

	private progressHead(team: TeamTeamView, width: number): string[] {
		const stats = this.host.runtime.flowStats(team.teamId);
		const count = (state: keyof typeof ICONS) => team.members.filter((member) => memberStatus(member) === state).length;
		const lines = wrapTextWithAnsi(`Σ Team ${clock(stats.activeMs)} · ${count("running")} running · ${count("waiting")} waiting · ${count("idle")} idle · workers avg ${stats.workersAvg?.toFixed(1) ?? "—"}`, width);
		lines.push(...wrapTextWithAnsi(`     ${usageText(team.usage)} · lead busy ${stats.leadBusyShare === undefined ? "—" : `${Math.round(stats.leadBusyShare * 100)}%`} · only lead ${stats.onlyLeadShare === undefined ? "—" : `${Math.round(stats.onlyLeadShare * 100)}%`}`, width));
		const rows = flowRows(stats);
		for (const key of ["lead", "queue", "waits", "cost"] as const) if (stats.warn[key]) {
			lines.push(...wrapTextWithAnsi(`⚠ ${key[0]!.toUpperCase()}${key.slice(1)} ${rows[key]}`, width).map((line) => this.theme.fg("warning", line)));
		}
		return [...lines, ""];
	}

	private reviewHeading(reviews: readonly TeamReviewRecord[], schedule: (TeamReviewPlan & { nextAt?: number | null }) | undefined): string {
		return `Reviews · ${reviews.length} · ${schedule ? `${schedule.by} every ${schedule.everyMinutes} min${this.nextReview(schedule)}` : "off"}`;
	}

	/** Deliverable counts with the list filter right-aligned. */
	private tasksSummary(works: readonly TeamWorkSummary[], width: number): string {
		const plain = works.filter((work) => !work.kind);
		const roots = plain.filter((work) => !work.parent);
		const counts = `${roots.length} deliverables · ${plain.length - roots.length} sub-task${plain.length - roots.length === 1 ? "" : "s"} · ${roots.filter((work) => work.state === "running" && !work.hold).length} running · ${roots.filter((work) => work.review === "waived").length} waived`;
		const view = `view: ${this.view} (f)`;
		return visibleWidth(counts) + 2 + visibleWidth(view) <= width ? `${fit(counts, width - visibleWidth(view))}${view}` : `${counts} · ${view}`;
	}

	/** One row per deliverable under Needs attention / In progress / Done (folded); the expanded deliverable lists its sub-tasks. */
	private taskRows(team: TeamTeamView, works: TeamWorkSummary[], width: number): Row[] {
		const { latest, children } = workTree(works);
		const describe = (work: TeamWorkSummary) => this.taskState(team.teamId, work, works, true);
		const descendants = (work: TeamWorkSummary): TeamWorkSummary[] => (children.get(work.work.workId) ?? []).flatMap((child) => [child, ...descendants(child)]);
		const roots = [...latest.values()].filter((work) => !work.parent);
		const rank = (work: TeamWorkSummary) => work.hold || work.state === "failed" || work.review === "waived" || work.state === "resolved" && !work.review ? 0
			: work.state === "running" || work.state === "blocked" || work.state === "queued" ? 1 : 2;
		const groups = ([["⚠", "warning", "Needs attention"], ["▶", "accent", "In progress"], ["✓", "success", "Done"]] as const)
			.map(([icon, color, label], index) => ({ icon, color, label, done: index === 2, items: roots.filter((work) => rank(work) === index) }))
			.filter((group) => group.items.length && !(group.done && this.view === "active"));
		const listed = groups.flatMap((group) => group.done && !this.expanded.has("done") ? [] : group.items);
		const cells = new Map(listed.map((work) => {
			const sub = descendants(work);
			return [work, { state: describe(work), suffix: sub.length ? ` · ${sub.filter((item) => item.state === "resolved").length}/${sub.length} sub-tasks ${this.root === work.work.workId ? "‹" : "›"}` : "" }];
		}));
		// The columns fit the listed rows: assignee, then the longest state up to 55% of the width, and the title gets the rest.
		const assigneeWidth = Math.min(Math.floor(width * 0.2), Math.max(1, ...listed.map((work) => visibleWidth(work.assignee))));
		const stateWidth = Math.min(Math.floor(width * 0.55), Math.max(0, ...[...cells.values()].map(({ state, suffix }) => visibleWidth(state + suffix))));
		const titleWidth = Math.max(10, width - assigneeWidth - stateWidth - 4);
		// A deliverable's row, followed by its sub-tasks while it is the expanded one.
		const listing = (work: TeamWorkSummary): Row[] => {
			const { state, suffix } = cells.get(work)!;
			return [{ work, text: `${column(` ${workIcon(work, this.theme)} ${workTitle(work)}`, titleWidth)}  ${column(work.assignee, assigneeWidth)}  ${compact(state, width - titleWidth - assigneeWidth - 4 - visibleWidth(suffix))}${suffix}` },
				...(this.root === work.work.workId ? buildTeamTaskRows(works, this.expanded, this.theme, width - 1, describe, work.work.workId).slice(1).map((child) => ({ ...child, text: ` ${child.text}` })) : [])];
		};
		return groups.flatMap((group) => {
			const open = !group.done || this.expanded.has("done");
			const title = `${this.theme.fg(group.color, group.icon)} ${group.label} · ${group.items.length}`;
			return [group.done ? { fold: "done", text: `${fit(title, width - 3)}[${open ? "−" : "+"}]` } : { header: true, text: title }, ...(open ? group.items.flatMap(listing) : [])];
		});
	}

	private taskState(teamId: string, work: TeamWorkSummary, works: readonly TeamWorkSummary[], brief = false): string {
		const version = this.host.runtime.getWork(teamId, work.work)!.current;
		if (work.hold) return `held: ${{ attention: "attention", budget: "budget", protocol: "loop", lead_unavailable: "lead fault" }[work.hold]}`;
		if (work.review) {
			const summary = work.resultRef && !brief ? this.host.runtime.getResult(teamId, work.resultRef)?.result.summary : undefined;
			const reason = version.review?.reason;
			return `${work.review}${reason ? ` · ${oneLine(reason)}` : summary ? ` · "${firstSentence(summary)}"` : ""}`;
		}
		if (work.state === "failed") return `failed: ${version.error?.code ?? "unknown"}`;
		if (work.state === "blocked") {
			const waits = [...version.waitingFor, ...this.host.runtime.getWork(teamId, work.work)!.children];
			const names = [...new Set(waits.map((ref) => works.find((item) => item.work.workId === ref.workId)).filter((item) => item && !isTerminalWorkState(item.state)).map((item) => item!.assignee))];
			return `waiting for ${names.join(", ") || "sub-tasks"}`;
		}
		if (work.state === "queued") {
			const ahead = works.slice(0, works.indexOf(work)).filter((item) => item.assignee === work.assignee && item.state === "queued").length;
			return ahead ? `queued (${ahead} ahead)` : works.some((item) => item.assignee === work.assignee && item.state === "running") ? "queued · member busy" : "queued (0 ahead)";
		}
		if (work.state === "resolved") {
			if (!work.parent) return "delivered · awaiting acceptance";
			const result = work.resultRef && !brief ? this.host.runtime.getResult(teamId, work.resultRef)?.result : undefined;
			return `done ${clock(this.host.runtime.workStats(teamId, work.work).activeMs)}${result ? ` · "${firstSentence(result.summary)}"` : ""}`;
		}
		return work.state === "running" ? `running ${clock(this.host.runtime.workStats(teamId, work.work).activeMs)}` : work.state;
	}

	private taskDetail(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		const work = works.find((item) => item.work.workId === this.detail!.slice(0, this.detail!.lastIndexOf("@")))!;
		const view = this.host.runtime.getWork(team.teamId, work.work)!;
		const ref = shortWorkRef(work.work).replace(/@\d+$/u, "");
		const milestones = this.timeline(facts, works).filter((row) => row.text.includes(`${ref}@`) || row.text.includes(work.work.workId));
		const children = works.filter((item) => item.parent?.workId === work.work.workId && !item.kind);
		const result = work.resultRef ? this.host.runtime.getResult(team.teamId, work.resultRef)?.result : undefined;
		const stats = this.host.runtime.workStats(team.teamId, work.work);
		const lines = [`${workTitle(work)} · ${shortWorkRef(work.work)}${work.work.revision > 1 ? ` (revised ${work.work.revision - 1}×)` : ""}`,
			`${work.requester} → ${work.assignee} · ${this.taskState(team.teamId, work, works)} · ${usageText(stats.usage)}`, `Task: ${view.current.task}`, "Lifecycle:",
			...(facts.timelineOmitted ? ["  … earlier steps omitted"] : []), ...milestones.map((row) => `  ${row.text}`),
			`Sub-tasks: ${children.length} · ${children.filter((item) => item.state === "resolved").length} done · ${children.filter((item) => item.state === "blocked").length} waiting`,
			`Result: ${result?.summary ?? "—"}`, ...(result?.findings ?? []).map((line) => `Finding: ${line}`), ...(result?.evidence ?? []).map((item) => `Evidence: ${item.source}${item.locator ? ` · ${item.locator}` : ""} · ${item.basis}`)];
		return lines.flatMap((text) => wrapTextWithAnsi(stripTerminalSequences(text), width).map((text) => ({ text })));
	}

	private reviewRows(reviews: readonly TeamReviewRecord[], width: number): Row[] {
		if (!reviews.length) return [{ text: "No reviews yet" }];
		const newest = reviews.toReversed();
		const clockWidth = Math.max(...newest.map((review) => clock(review.snapshot.elapsedMs).length));
		const byWidth = Math.min(Math.floor(width * 0.2), Math.max(...newest.map((review) => visibleWidth(review.by))));
		return newest.map((review) => {
			const [label, color] = verdictOf(review);
			const prefix = `${clock(review.snapshot.elapsedMs).padStart(clockWidth)}  ${column(review.by, byWidth)}  ${this.theme.fg(color, column(label, 10))}  `;
			return { review: review.id, text: `${prefix}${compact(reviewAssessment(review.summary), width - visibleWidth(prefix))}` };
		});
	}

	private snapshotLines(review: TeamReviewRecord): string[] {
		const { elapsedMs, works, finishedSinceLast, budget } = review.snapshot;
		return [`Snapshot: ${clock(elapsedMs)} · ${finishedSinceLast} finished since last review`,
			`Works: ${works.resolved}/${works.total} resolved · ${works.running} running · ${works.blocked} blocked · ${works.held} held · ${works.failed} failed · ${works.cancelled} cancelled`,
			`Budget: ${budget.map(({ counter, used, limit }) => `${counter} ${used}/${limit >= TEAM_BUDGET_UNLIMITED ? "unlimited" : limit}`).join(" · ")}`];
	}

	private reviewDetails(reviews: readonly TeamReviewRecord[], width: number): string[] {
		const review = reviews.find((review) => review.id === this.rows[this.selected]?.review);
		if (!review) return [];
		const [label] = verdictOf(review);
		const works = review.snapshot.works;
		return [this.theme.fg("toolTitle", this.theme.bold(`${clock(review.snapshot.elapsedMs)} · ${review.by} · ${label}`)),
			this.theme.fg("dim", compact(`Summary: ${reviewAssessment(review.summary)}`, width)),
			this.theme.fg("dim", compact(`Snapshot: works ${works.resolved}/${works.total} resolved · ${works.running} running · ${works.held} held · ${works.failed} failed`, width))];
	}

	private reviewDetail(reviews: readonly TeamReviewRecord[], width: number): Row[] {
		const review = reviews.find((review) => review.id === this.detail);
		if (!review) return [{ text: "Review no longer retained · Esc back" }];
		const list = (title: string, items: readonly string[] | undefined) => items ? [`${title}:`, ...items.map((item) => `  - ${item}`)] : [];
		const lines = [`Review ${review.id} · Esc back`, `By: ${review.by} · ${verdictOf(review)[0]} · ${workRefKey(review.work)} ${review.status}${review.resultRef ? ` · ${review.resultRef}` : ""}`,
			"Summary:", review.summary, ...list("Findings", review.findings), ...list("Limitations", review.limitations), ...this.snapshotLines(review)];
		return lines.flatMap((text) => wrapTextWithAnsi(stripTerminalSequences(text), width).map((text) => ({ text })));
	}

	private workReferences(text: string, works: readonly TeamWorkSummary[]): string {
		return text.replace(/work ([\w-]+)@\d+(?!\d)(?! «)/gu, (ref, id: string) => {
			const work = works.find((work) => shortWorkRef(work.work).split(" ")[1]!.split("@")[0] === id);
			return work ? `${ref} «${workTitle(work)}»` : ref;
		});
	}

	private timeline(facts: Facts, works: readonly TeamWorkSummary[]): Row[] {
		const origin = facts.timeline[0]?.at ?? 0;
		return facts.timeline.map((entry) => ({ text: `${clock(entry.at - origin).padStart(7)}  ${this.workReferences(oneLine(entry.text), works)}`, milestone: `${entry.at}:${entry.text}` }));
	}

	private historyMembers(entry: TeamHistoryEntry): string[] {
		if (!this.sessions.has(entry.teamId)) {
			this.sessions.set(entry.teamId, new Map());
			void this.host.memberSessions(entry.teamId, entry.members).then((sessions) => {
				this.sessions.set(entry.teamId, sessions);
			}, (error: unknown) => { this.notice = error instanceof Error ? error.message : String(error); })
				.then(() => { if (!this.disposed) this.tui.requestRender(); });
		}
		return entry.members.map((name) => {
			const session = this.sessions.get(entry.teamId)!.get(name);
			const lifecycle = entry.memberStates?.find((member) => member.id === name)?.lifecycle ?? "activity not retained";
			const saved = !session ? "checking session…" : session.instance ? `${railModelReference(session.instance.model)} · ${formatBytes(session.size)}` : "session deleted";
			return `${name} · ${lifecycle} · ${entry.results.filter((result) => result.author === name).length} results · ${saved}`;
		});
	}

	private historyRows(entry: TeamHistoryEntry, width: number): Row[] {
		if (this.tab === 2) {
			if (this.detail) return this.historyMembers(entry).filter((text) => text.startsWith(`${this.detail} ·`)).flatMap((text) => wrapTextWithAnsi(text, width).map((text) => ({ text })));
			return entry.members.map((id) => {
				const state = entry.memberStates?.find((member) => member.id === id)?.lifecycle ?? "activity not retained";
				const stats = entry.memberStats?.find((member) => member.id === id);
				const busy = entry.activeMs && stats ? Math.round(stats.activeMs / entry.activeMs * 100) : undefined;
				const status = state === "faulted" ? "failed" : state === "closed" ? "completed" : "idle";
				// Members without retained stats are one line each; the Σ row says so once.
				return { member: id, text: `${this.theme.fg(statusColor(status), ICONS[status])} ${id}${id === entry.lead ? " (lead)" : ""}  ${state}`,
					...(stats ? { lines: wrapTextWithAnsi(`active ${clock(stats.activeMs)} · ${busy !== undefined && busy >= 90 ? this.theme.fg("warning", `busy ${busy}%`) : `busy ${busy ?? "—"}%`} · ${usageText(stats.usage)}`, width - 2) } : {}) };
			});
		}
		if (this.tab === 1) return this.historyOverview(entry, width);
		if (this.tab === 3) {
			if (!this.detail) return entry.results.map((record) => ({ result: record.id, text: `${outcomeIcon(this.theme, record.result.status)} ${compact(`${shortWorkRef(record.work).slice(5)} · ${record.author} · "${firstSentence(record.result.summary)}"`, width - 2)}` }));
			const { work, author, id, result } = entry.results.find((record) => record.id === this.detail)!;
			return [`${shortWorkRef(work)} · ${author} · ${result.status} · ${id} · Esc back`, "", `Result: ${result.summary}`, ...(result.findings ?? []).map((line) => `Finding: ${line}`),
				...(result.evidence ?? []).map((item) => `Evidence: ${item.source}${item.locator ? ` · ${item.locator}` : ""} · ${item.basis}`)]
				.flatMap((text) => wrapTextWithAnsi(stripTerminalSequences(text), width).map((line) => ({ text: line })));
		}
		return [{ text: "Timeline not retained in history" }];
	}

	private historyProgressHead(entry: TeamHistoryEntry, width: number): string[] {
		return [`Σ Team ${entry.activeMs === undefined ? "—" : clock(entry.activeMs)} · history · ${entry.members.length} members${entry.memberStats ? "" : " · stats not retained"}`,
			...(entry.usage ? wrapTextWithAnsi(`     ${usageText(entry.usage)}`, width) : []), ...(entry.flow ? wrapTextWithAnsi(entry.flow.split(" · ").slice(0, 2).join(" · "), width) : []), ""];
	}
}

export function showTeamOverlay(ctx: ExtensionCommandContext, host: TeamSessionHost): Promise<TeamOverlayAction | undefined> {
	return ctx.ui.custom<TeamOverlayAction | undefined>((tui, theme, keybindings, done) => new TeamOverlayComponent(tui, theme, keybindings, done, host), {
		overlay: true,
		overlayOptions: { width: "92%", minWidth: 60, maxHeight: "88%", anchor: "center", margin: 1 },
	});
}
