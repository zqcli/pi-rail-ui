import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { TeamSessionHost } from "./team-host";
import type { TeamHistoryEntry } from "./team-history";
import { isTerminalWorkState, shortWorkRef, workRefKey, type TeamMemberView, type TeamTeamView, type TeamWorkSummary } from "./team-protocol";
import { statusColor } from "./transcript";

const TABS = ["Overview", "Members", "Tasks", "Timeline"] as const;
const ICONS = { running: "▶", waiting: "⧗", held: "⏸", idle: "○", completed: "✓", failed: "✗" } as const;
export interface TeamOverlayAction { teamId: string; action: "cancel" | "resume" | "grant" | "message" }
type Facts = ReturnType<TeamSessionHost["runtime"]["panelFacts"]>;
type Row = { text: string; member?: string; fold?: string };
const oneLine = (text: string) => stripTerminalSequences(text).replace(/\s+/gu, " ").trim();
const clock = (ms: number) => `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, "0")}`;
const writable = (team: TeamTeamView) => team.lifecycle === "prepared" || team.lifecycle === "active" || team.lifecycle === "closing";

function progress(works: readonly TeamWorkSummary[]): string {
	const roots = works.filter((work) => !work.parent);
	return `roots ${roots.filter((work) => work.review === "accepted").length}/${roots.length} accepted · works ${works.filter((work) => work.state === "resolved").length}/${works.length} done`;
}

function workIcon(work: TeamWorkSummary, theme: Theme): string {
	if (work.hold) return theme.fg(statusColor("held"), ICONS.held);
	if (work.state === "resolved") return theme.fg(work.review === "accepted" ? "success" : "dim", "✓");
	if (work.state === "cancelled" || work.state === "superseded") return theme.fg("muted", "–");
	const status = work.state === "blocked" ? "waiting" : work.state === "queued" ? "idle" : work.state;
	return theme.fg(statusColor(status), ICONS[status]);
}

/** Parent ownership survives revisions: keep older children under their owning work, not lost from the tree. */
export function buildTeamTaskRows(works: readonly TeamWorkSummary[], expanded: ReadonlySet<string>, theme: Theme, width?: number): Row[] {
	const children = new Map<string, TeamWorkSummary[]>();
	for (const work of works) if (work.parent) {
		const siblings = children.get(work.parent.workId) ?? [];
		siblings.push(work);
		children.set(work.parent.workId, siblings);
	}
	const rows: Row[] = [];
	const visit = (work: TeamWorkSummary, depth: number) => {
		const indent = "  ".repeat(depth);
		const prefix = `${indent}${workIcon(work, theme)} ${shortWorkRef(work.work).replace("work ", "work:")}  ${work.assignee} ← ${work.requester}  `;
		const suffix = `  ${work.hold ? "held" : work.state}${work.review ? `/${work.review}` : ""}${work.resultRef ? ` · ${work.resultRef}` : ""}`;
		const preview = oneLine(work.taskPreview);
		rows.push({ text: `${prefix}${width === undefined ? preview : truncateToWidth(preview, Math.max(1, width - visibleWidth(prefix + suffix)))}${suffix}` });
		const nested = children.get(work.work.workId) ?? [];
		if (nested.length > 5) {
			const counts = new Map<string, number>();
			for (const child of nested) counts.set(child.assignee, (counts.get(child.assignee) ?? 0) + 1);
			rows.push({ fold: work.work.workId, text: `${indent}  ✓ ${nested.length} sub-tasks (${[...counts].map(([name, count]) => `${name} ${count}`).join(" · ")}) · ${nested.filter((child) => child.state === "resolved").length} done [${expanded.has(work.work.workId) ? "−" : "+"}]` });
			if (!expanded.has(work.work.workId)) return;
		}
		for (const child of nested) visit(child, depth + 1);
	};
	for (const work of works) if (!work.parent) visit(work, 0);
	return rows;
}

function assignedWork(member: TeamMemberView, works: readonly TeamWorkSummary[]): TeamWorkSummary | undefined {
	const assigned = works.filter((work) => work.assignee === member.id);
	return assigned.find((work) => member.currentWork && workRefKey(work.work) === workRefKey(member.currentWork))
		?? assigned.find((work) => !isTerminalWorkState(work.state)) ?? assigned.at(-1);
}

export class TeamOverlayComponent implements Focusable {
	focused = false;
	private teamId: string | undefined;
	private tab = 0;
	private selected = 0;
	private offset = 0;
	private pageSize = 1;
	private rows: Row[] = [];
	private detail: string | undefined;
	private expanded = new Set<string>();
	private followTimeline = true;
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
		this.teamId = teams.find((team) => team.lifecycle === "active")?.teamId ?? this.teamIds()[0];
		const refresh = () => { if (!this.disposed) this.tui.requestRender(); };
		this.unsubscribe = [host.runtime.onChange(refresh), host.driver.onActivity(refresh)];
		// Refresh elapsed/active times even between runtime and native activity events.
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

	private resetPosition(): void {
		this.selected = 0;
		this.offset = 0;
		this.detail = undefined;
		this.followTimeline = true;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.detail) this.resetPosition();
			else { this.dispose(); this.done(undefined); return; }
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.tab = (this.tab + (matchesKey(data, Key.tab) ? 1 : TABS.length - 1)) % TABS.length;
			this.resetPosition();
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || data === "[" || data === "]") {
			const ids = this.teamIds();
			const step = matchesKey(data, Key.left) || data === "[" ? -1 : 1;
			this.teamId = ids[(ids.indexOf(this.teamId!) + step + ids.length) % ids.length];
			this.expanded.clear();
			this.resetPosition();
		} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const step = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : matchesKey(data, Key.pageUp) ? -this.pageSize : this.pageSize;
			this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + step));
			this.followTimeline = this.selected === this.rows.length - 1;
		} else if (matchesKey(data, Key.enter)) {
			const row = this.rows[this.selected];
			if (row?.member) { this.resetPosition(); this.detail = row.member; }
			else if (row?.fold) {
				if (!this.expanded.delete(row.fold)) this.expanded.add(row.fold);
			}
		} else {
			const action = ({ c: "cancel", r: "resume", g: "grant", m: "message" } as const)[data as "c" | "r" | "g" | "m"];
			const team = this.host.runtime.listTeams().find((team) => team.teamId === this.teamId);
			if (action && team && writable(team) && this.host.active) {
				this.dispose();
				this.done({ teamId: team.teamId, action });
				return;
			}
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const ids = this.teamIds();
		this.teamId ??= ids[0];
		const team = this.host.runtime.listTeams().find((team) => team.teamId === this.teamId);
		const history = this.host.history.teams.find((entry) => entry.teamId === this.teamId);
		const headers = [TABS.map((tab, index) => index === this.tab ? this.theme.fg("accent", `[${tab}]`) : tab).join(" · ")];
		if (ids.length > 1) headers.unshift(`Teams ${ids.indexOf(this.teamId!) + 1}/${ids.length} · ${this.teamId} · ←/→ or [ ]`);
		let rows: Row[] = [];
		if (team) {
			const works = this.host.runtime.listWorks(team.teamId);
			const facts = this.host.runtime.panelFacts(team.teamId);
			if (this.detail) {
				headers.push(`Member ${this.detail} · Esc back`);
				rows = this.memberDetail(team, works, facts, inner - 3);
			} else if (this.tab === 0) rows = this.overview(team, works, facts, inner - 3);
			else if (this.tab === 1) {
				headers.push("Members · state · from → to · active time");
				rows = this.members(team, works, facts, inner - 2);
			} else if (this.tab === 2) {
				headers.push(`Tasks · ${progress(works)}`);
				rows = buildTeamTaskRows(works, this.expanded, this.theme, inner - 2);
			} else rows = this.timeline(facts);
		} else if (history) rows = this.historyRows(history, inner - 3);
		else rows = [{ text: "No teams" }];
		this.rows = rows;
		if (this.tab === 3 && this.followTimeline) this.selected = rows.length - 1;
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		const height = Math.max(1, Math.min(this.tui.terminal.rows - 2, Math.floor(this.tui.terminal.rows * 0.88)));
		this.pageSize = Math.max(1, height - headers.length - 4);
		this.offset = Math.max(0, Math.min(this.offset, rows.length - this.pageSize));
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + this.pageSize) this.offset = this.selected - this.pageSize + 1;
		const selectable = !this.detail && (this.tab === 1 || this.tab === 2);
		const body = rows.slice(this.offset, this.offset + this.pageSize).map((row, index) =>
			`${selectable && index + this.offset === this.selected ? "›" : " "} ${row.text}`);
		const controls = team && writable(team) && this.host.active ? "c cancel · r resume · g grant · m message" : "read-only";
		const footer = [`${controls}${rows.length > this.pageSize ? ` · ${this.offset + 1}–${Math.min(rows.length, this.offset + this.pageSize)}/${rows.length}` : ""}`,
			"Tab/Shift+Tab views · ↑/↓ PgUp/PgDn · Enter detail/expand · Esc back/close"];
		const frame = (text: string) => `│${truncateToWidth(text, inner, "…", true)}│`;
		return [`╭${"─".repeat(inner)}╮`, ...headers.map(frame), ...body.map(frame), ...footer.map(frame), `╰${"─".repeat(inner)}╯`]
			.slice(0, height).map((line) => truncateToWidth(line, width));
	}

	private overview(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		const start = facts.timeline[0]?.at ?? this.now();
		const end = writable(team) ? this.now() : facts.timeline.at(-1)?.at ?? start;
		const lines = [`Team ${team.teamId} · ${team.lifecycle.toUpperCase()} · ${team.health === "ok" ? "ok" : "needs attention"} · elapsed ${clock(end - start)}`,
			...wrapTextWithAnsi(`Goal: ${oneLine(team.brief.goal)}`, width).slice(0, 3),
			`Progress: ${progress(works)} · ${team.works.cancelled} cancelled`,
			this.theme.fg(facts.waitingFor?.startsWith("Manager decision") ? "warning" : "muted", `Waiting for: ${facts.waitingFor ?? "—"}`)];
		const holds = this.host.runtime.listHolds(team.teamId);
		const incidents = team.incidents.filter((incident) => incident.state === "open");
		lines.push(holds.length || incidents.length ? this.theme.fg("warning", `Attention: ${holds.length} open holds · ${incidents.length} open incidents`) : "Attention: none");
		for (const hold of holds) lines.push(this.theme.fg("warning", `  ${hold.assignee} · ${shortWorkRef(hold.work)} · ${oneLine(hold.message)}`));
		for (const incident of incidents) if (!holds.some((hold) => hold.incidentId === incident.id)) lines.push(this.theme.fg("warning", `  ${incident.code}: ${oneLine(incident.message)}`));
		const { used, limits } = this.host.runtime.inspectBudget(team.teamId);
		lines.push(`Budget: activations ${used.teamActivations}/${limits.teamActivations} · model requests ${used.teamModelRequests}/${limits.teamModelRequests} · tool calls ${used.teamToolCalls}/${limits.teamToolCalls}`,
			"Recent milestones:", ...this.timeline(facts).slice(-5).map((row) => row.text));
		return lines.map((text) => ({ text }));
	}

	private members(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		return team.members.map((member) => {
			const status = member.lifecycle === "faulted" ? "failed" : member.lifecycle === "closed" ? "completed"
				: member.activity !== "idle" || member.lifecycle === "starting" || member.lifecycle === "closing" ? "running"
					: member.held ? "held" : member.blocked || member.queued ? "waiting" : "idle";
			const state = member.currentWork ? `running ${shortWorkRef(member.currentWork)}`
				: member.role === "manager" && facts.managerHandling ? facts.managerHandling
					: facts.stalled.get(member.id) ?? (member.queued ? "queued for a worker slot" : `idle · ${facts.results.get(member.id)?.count ?? 0} results`);
			const work = assignedWork(member, works);
			const route = member.role === "manager" || !work ? "—" : `${work.requester} → ${member.id} → ${work.requester}`;
			const prefix = `${this.theme.fg(statusColor(status), ICONS[status])} ${member.id} · `;
			const suffix = ` · ${route} · ${clock(this.host.driver.memberActivity(team.teamId, member.id)?.durationMs ?? 0)}`;
			return { member: member.id, text: `${prefix}${truncateToWidth(oneLine(state), Math.max(1, width - visibleWidth(prefix + suffix)))}${suffix}` };
		});
	}

	private memberDetail(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		const member = team.members.find((member) => member.id === this.detail)!;
		const work = assignedWork(member, works);
		const task = work ? this.host.runtime.getWork(team.teamId, work.work)?.current.task : undefined;
		const lines = [`Task: ${task ?? (member.role === "manager" ? team.brief.goal : "No assigned work")}`, "Outbound works:",
			...works.filter((work) => work.requester === member.id).map((work) => `  ${shortWorkRef(work.work)} → ${work.assignee} · ${work.hold ? "held" : work.state}`)];
		const latest = facts.results.get(member.id)?.latest;
		if (latest) {
			const source = works.find((work) => work.work.workId === latest.work.workId)!;
			const fate = source.work.revision !== latest.work.revision ? `superseded by @${source.work.revision}` : source.parent ? "" : source.review ?? "awaiting review";
			lines.push(`Latest result: ${latest.result.status} · ${latest.id}`, `result → ${source.requester}${fate ? ` · ${fate}` : ""}`, latest.result.summary);
		} else lines.push("Latest result: none");
		return lines.flatMap((text) => wrapTextWithAnsi(stripTerminalSequences(text), width).map((text) => ({ text })));
	}

	private timeline(facts: Facts): Row[] {
		const origin = facts.timeline[0]?.at ?? 0;
		return [...(facts.timelineOmitted ? [{ text: `… ${facts.timelineOmitted} earlier milestones omitted …` }] : []),
			...facts.timeline.map((entry) => ({ text: `${clock(entry.at - origin)} ${oneLine(entry.text)}` }))];
	}

	private historyRows(entry: TeamHistoryEntry, width: number): Row[] {
		const heading = `Team ${entry.teamId} · ${entry.lifecycle.toUpperCase()} · ${entry.version === 1 ? "legacy · " : ""}history (read-only)`;
		const lines = this.tab === 0 ? [heading, `Goal: ${entry.goal ?? "not retained"}`, `Outcome: ${entry.outcome ?? entry.lifecycle}`, entry.reason ?? "", `${entry.results.length} retained results`]
			: this.tab === 1 ? [heading, ...[entry.manager, ...entry.workers].filter(Boolean).map((name) => `${name} · ${entry.results.filter((result) => result.author === name).length} results · activity not retained`)]
				: this.tab === 2 ? [heading, "Work ledger not retained; retained results:", ...entry.results.map((result) => `${shortWorkRef(result.work)} · ${result.author} · ${result.result.status} · ${result.id}: ${oneLine(result.result.summary)}`)]
					: [heading, "Timeline not retained in history"];
		return lines.flatMap((text) => wrapTextWithAnsi(oneLine(text), width).map((text) => ({ text })));
	}
}

export function showTeamOverlay(ctx: ExtensionCommandContext, host: TeamSessionHost): Promise<TeamOverlayAction | undefined> {
	return ctx.ui.custom<TeamOverlayAction | undefined>((tui, theme, keybindings, done) => new TeamOverlayComponent(tui, theme, keybindings, done, host), {
		overlay: true,
		overlayOptions: { width: "92%", minWidth: 60, maxHeight: "88%", anchor: "center", margin: 1 },
	});
}
