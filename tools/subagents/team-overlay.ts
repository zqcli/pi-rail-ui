import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { TeamSessionHost } from "./team-host";
import type { TeamHistoryEntry } from "./team-history";
import { TEAM_BUDGET_UNLIMITED, isTerminalWorkState, shortWorkRef, workRefKey, type TeamMemberView, type TeamTeamView, type TeamWorkSummary } from "./team-protocol";
import { memberDetail } from "./team-tool";
import { statusColor } from "./transcript";

const TABS = ["Overview", "Members", "Tasks", "Timeline"] as const;
const ICONS = { running: "▶", waiting: "⧗", held: "⏸", idle: "○", completed: "✓", failed: "✗" } as const;
export interface TeamOverlayAction { teamId: string; action: "cancel" | "resume" | "grant" | "message" }
type Facts = ReturnType<TeamSessionHost["runtime"]["panelFacts"]>;
type Row = { text: string; member?: string; fold?: string; work?: TeamWorkSummary; milestone?: string };
const oneLine = (text: string) => stripTerminalSequences(text).replace(/\s+/gu, " ").trim();
const compact = (text: string, width: number) => truncateToWidth(oneLine(text), Math.max(1, width));
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "", true);
const column = (text: string, width: number) => fit(truncateToWidth(text, Math.max(1, width)), width);
const clock = (ms: number) => `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, "0")}`;
const writable = (team: TeamTeamView) => team.lifecycle === "prepared" || team.lifecycle === "active" || team.lifecycle === "closing";
const workState = (work: TeamWorkSummary) => `${work.hold ? "held" : work.state}${work.review ? `/${work.review}` : ""}`;

function progress(works: readonly TeamWorkSummary[], done = true): string {
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
	if (work.state === "resolved") return theme.fg(work.review === "accepted" ? "success" : "dim", "✓");
	if (work.state === "cancelled" || work.state === "superseded") return theme.fg("muted", "–");
	const status = work.state === "blocked" ? "waiting" : work.state === "queued" ? "idle" : work.state;
	return theme.fg(statusColor(status), ICONS[status]);
}

/** Parent ownership survives revisions: keep older children under their owning work. */
export function buildTeamTaskRows(works: readonly TeamWorkSummary[], expanded: ReadonlySet<string>, theme: Theme, width = 120): Row[] {
	const children = new Map<string, TeamWorkSummary[]>();
	for (const work of works) if (work.parent) {
		const siblings = children.get(work.parent.workId) ?? [];
		siblings.push(work);
		children.set(work.parent.workId, siblings);
	}
	const tree: Array<{ work: TeamWorkSummary; depth: number; fold?: string }> = [];
	const visit = (work: TeamWorkSummary, depth: number) => {
		tree.push({ work, depth });
		const nested = children.get(work.work.workId) ?? [];
		if (nested.length > 5) {
			tree.push({ work, depth: depth + 1, fold: work.work.workId });
			if (!expanded.has(work.work.workId)) return;
		}
		for (const child of nested) visit(child, depth + 1);
	};
	for (const work of works) if (!work.parent) visit(work, 0);
	const ref = (work: TeamWorkSummary, depth: number) => `${"  ".repeat(depth)}${workIcon(work, theme)} ${shortWorkRef(work.work).replace("work ", "work:")}`;
	const route = (work: TeamWorkSummary) => `${work.assignee} ← ${work.requester}`;
	const refWidth = Math.min(Math.floor(width * 0.28), Math.max(1, ...tree.map(({ work, depth }) => visibleWidth(ref(work, depth)))));
	const routeWidth = Math.min(Math.floor(width * 0.28), Math.max(1, ...works.map((work) => visibleWidth(route(work)))));
	const stateWidth = Math.max(1, ...works.map((work) => workState(work).length));
	return tree.map(({ work, depth, fold }) => {
		if (fold) {
			const nested = children.get(fold)!;
			const counts = new Map<string, number>();
			for (const child of nested) counts.set(child.assignee, (counts.get(child.assignee) ?? 0) + 1);
			return { work, fold, text: `${"  ".repeat(depth)}✓ ${nested.length} sub-tasks (${[...counts].map(([name, count]) => `${name} ${count}`).join(" · ")}) · ${nested.filter((child) => child.state === "resolved").length} done [${expanded.has(fold) ? "−" : "+"}]` };
		}
		const prefix = `${column(ref(work, depth), refWidth)}  ${column(route(work), routeWidth)}  ${column(workState(work), stateWidth)}  `;
		const suffix = work.resultRef ? ` · ${work.resultRef}` : "";
		return { work, text: truncateToWidth(`${prefix}${compact(work.taskPreview, width - visibleWidth(prefix + suffix))}${suffix}`, width) };
	});
}

function assignedWork(member: TeamMemberView, works: readonly TeamWorkSummary[]): TeamWorkSummary | undefined {
	const assigned = works.filter((work) => work.assignee === member.id);
	return assigned.find((work) => member.currentWork && workRefKey(work.work) === workRefKey(member.currentWork))
		?? assigned.find((work) => !isTerminalWorkState(work.state)) ?? assigned.at(-1);
}

function memberRoute(member: TeamMemberView, work: TeamWorkSummary | undefined): string {
	return !work ? "—" : `${work.requester} → ${member.id} → ${work.requester}`;
}

function latestResult(memberId: string, works: TeamWorkSummary[], facts: Facts): string {
	const latest = facts.results.get(memberId)?.latest;
	if (!latest) return "Latest result: none";
	const work = works.find((work) => work.work.workId === latest.work.workId)!;
	const fate = work.work.revision !== latest.work.revision ? `superseded by @${work.work.revision}` : work.parent ? "" : work.review ?? "awaiting review";
	return `result → ${work.requester} · ${latest.result.status}${fate ? ` · ${fate}` : ""} · ${latest.id}`;
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
	private expanded = new Set<string>();
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
		this.teamId = teams.find((team) => team.lifecycle === "active")?.teamId ?? this.teamIds()[0];
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
			else { this.dispose(); this.done(undefined); return; }
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const back = matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"));
			this.tab = (this.tab + (back ? TABS.length - 1 : 1)) % TABS.length;
			this.resetPosition();
		} else if (data === "[" || data === "]") {
			const ids = this.teamIds();
			this.teamId = ids[(ids.indexOf(this.teamId!) + (data === "[" ? -1 : 1) + ids.length) % ids.length];
			this.expanded.clear();
			this.resetPosition();
		} else if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown) || matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
			const step = this.keybindings.matches(data, "tui.select.up") ? -1 : this.keybindings.matches(data, "tui.select.down") ? 1 : matchesKey(data, Key.pageUp) ? -this.pageSize : this.pageSize;
			this.selected = matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? this.rows.length - 1 : this.selected + step;
			this.selected = Math.max(0, Math.min(this.maxSelected, this.selected));
			this.followTimeline = this.selected === this.rows.length - 1;
			this.timelineCursor = this.rows[this.selected]?.milestone;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
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
		let rows: Row[] = [];
		if (team && facts) {
			if (this.detail) rows = this.memberDetail(team, works, facts, inner - 1);
			else if (this.tab === 0) rows = this.overview(team, works, facts, inner - 1);
			else if (this.tab === 1) rows = this.members(team, works, facts, inner - 3);
			else if (this.tab === 2) rows = buildTeamTaskRows(works, this.expanded, this.theme, inner - 3);
			else rows = this.timeline(facts);
		} else if (history) rows = this.historyRows(history, inner - 1);
		else rows = [{ text: "No teams" }];
		this.rows = rows;
		if (this.tab === 3) {
			if (this.followTimeline) this.selected = rows.length - 1;
			else if (this.timelineCursor) {
				const index = rows.findIndex((row) => row.milestone === this.timelineCursor);
				if (index >= 0) this.selected = index;
			}
		}
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		this.timelineCursor = rows[this.selected]?.milestone;
		const live = !!team && writable(team) && this.host.active;
		// Overview already shows Waiting for in its body.
		const notice = this.tab !== 0 && facts?.waitingFor?.startsWith("Lead decision") ? `Waiting for: ${facts.waitingFor}`
			: this.notice;
		const omitted = this.tab === 3 && facts?.timelineOmitted ? `… ${facts.timelineOmitted} earlier milestones omitted …` : "";
		const height = Math.max(1, Math.min(this.tui.terminal.rows - 2, Math.floor(this.tui.terminal.rows * 0.88)));
		const available = Math.max(1, height - 7 - (notice ? 1 : 0) - (omitted ? 1 : 0));
		const selectable = !!team && !this.detail && this.tab !== 0;
		// The cap keeps the selection details under Members/Tasks; the Timeline has none.
		const cap = this.tab === 3 ? available : Math.min(8, this.tui.terminal.rows - 13);
		this.pageSize = selectable ? Math.max(1, Math.min(cap, available)) : available;
		const details = team && facts && !this.detail ? this.selectionDetails(team, works, facts, inner - 1) : [];
		const showDetails = details.length > 0 && available >= Math.min(rows.length, this.pageSize) + details.length + 1;
		this.offset = Math.max(0, Math.min(this.offset, rows.length - this.pageSize));
		// Without a visible cursor the hidden cursor is the scroll offset, so every key scrolls at once.
		this.maxSelected = selectable ? rows.length - 1 : Math.max(0, rows.length - this.pageSize);
		if (!selectable) this.offset = this.selected = Math.min(this.selected, this.maxSelected);
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + this.pageSize) this.offset = this.selected - this.pageSize + 1;
		const body = rows.slice(this.offset, this.offset + this.pageSize).map((row, index) => {
			if (!selectable) return ` ${row.text}`;
			return index + this.offset === this.selected ? `${this.theme.fg("accent", " → ")}${this.theme.fg("accent", row.text)}` : `   ${row.text}`;
		});
		const title = `${this.theme.fg("accent", this.theme.bold("Rail Team"))}  ${this.renderTabs()}`;
		const selector = ids.length > 1 ? `‹ ${ids.indexOf(this.teamId!) + 1}/${ids.length} › ${this.teamId!.slice(0, 8)}` : "";
		const header = selector ? `${fit(title, inner - visibleWidth(selector) - 2)} ${this.theme.fg("dim", selector)}` : title;
		const summary = team && facts ? this.summaryText(team, works, facts) : history ? `${history.lifecycle.toUpperCase()} · history (read-only) · ${history.results.length} results` : "No teams";
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const line = (text = "") => `${this.theme.fg("border", "│")}${fit(text, inner)}${this.theme.fg("border", "│")}`;
		return [border(`╭${"─".repeat(inner)}╮`), line(` ${header}`), line(` ${this.theme.fg("dim", summary)}`), line(),
			...(omitted ? [line(` ${this.theme.fg("dim", omitted)}`)] : []), ...body.map(line),
			...(showDetails ? [line(), ...details.map((text) => line(` ${text}`))] : []), line(),
			...(notice ? [line(` ${this.theme.fg("warning", compact(notice, inner - 1))}`)] : []),
			line(` ${this.theme.fg("dim", this.helpText(live, ids.length > 1))}`), border(`╰${"─".repeat(inner)}╯`)];
	}

	private renderTabs(): string {
		return TABS.map((tab, index) => index === this.tab ? this.theme.fg("accent", `[${tab}]`) : this.theme.fg("dim", ` ${tab} `)).join(" ");
	}

	private summaryText(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts): string {
		const start = facts.timeline[0]?.at ?? this.now();
		const end = writable(team) ? this.now() : facts.timeline.at(-1)?.at ?? start;
		const counts = (["running", "held", "waiting"] as const).flatMap((status) => {
			const count = team.members.filter((member) => memberStatus(member) === status).length;
			return count ? [`${count} ${status}`] : [];
		});
		return [team.lifecycle.toUpperCase(), team.health === "ok" ? "ok" : "needs attention", clock(end - start), progress(works, false), ...counts,
			...(!writable(team) || !this.host.active ? ["read-only"] : [])].join(" · ");
	}

	private helpText(live: boolean, multiple: boolean): string {
		const view = this.detail ? "↑↓/pgup/dn scroll · esc back" : this.tab === 0 ? "↑↓ scroll" : this.tab === 1 ? "↑↓ select · enter details"
			: this.tab === 2 ? "↑↓ select · enter fold" : "↑↓ cursor · pgup/dn page · home/end";
		return [view, ...(!this.detail ? ["←→/tab views"] : []), ...(multiple ? ["[ ] teams"] : []), ...(live ? ["c/r/g/m actions"] : ["read-only"]), ...(!this.detail ? ["esc close"] : [])].join(" · ");
	}

	private overview(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		const lines: string[] = [];
		const labelWidth = 13;
		const add = (label: string, value: string, color?: "warning") => {
			const text = `${(label ? `${label}:` : "").padEnd(labelWidth)}${value}`;
			lines.push(color ? this.theme.fg(color, text) : text);
		};
		wrapTextWithAnsi(oneLine(team.brief.goal), Math.max(1, width - labelWidth)).slice(0, 3).forEach((line, index) => add(index ? "" : "Goal", line));
		add("Progress", `${progress(works)} · ${team.works.cancelled} cancelled/superseded`);
		add("Waiting for", facts.waitingFor ?? "—", facts.waitingFor?.startsWith("Lead decision") ? "warning" : undefined);
		const holds = this.host.runtime.listHolds(team.teamId);
		const incidents = team.incidents.filter((incident) => incident.state === "open");
		add("Attention", holds.length || incidents.length ? `${holds.length} open holds · ${incidents.length} open incidents` : "none", holds.length || incidents.length ? "warning" : undefined);
		for (const hold of holds) add("", `${hold.assignee} · ${shortWorkRef(hold.work)} · ${oneLine(hold.message)}`, "warning");
		for (const incident of incidents) if (!holds.some((hold) => hold.incidentId === incident.id)) add("", `${incident.code}: ${oneLine(incident.message)}`, "warning");
		const { used, limits } = this.host.runtime.inspectBudget(team.teamId);
		const counters = [["activations", "teamActivations"], ["lead", "leadActivations"], ["model requests", "teamModelRequests"], ["tool calls", "teamToolCalls"], ["works", "teamWorks"]] as const;
		counters.forEach(([label, key], index) => {
			const value = used[key], limit = limits[key];
			const cells = limit ? Math.min(6, Math.floor(value / limit * 6)) : 6;
			const meter = limit >= TEAM_BUDGET_UNLIMITED ? `${value} · unlimited` : this.theme.fg(value >= limit ? "error" : value / limit >= 0.8 ? "warning" : "muted", `${"█".repeat(cells)}${"░".repeat(6 - cells)}  ${value}/${limit}`);
			add(index ? "" : "Budget", `${label.padEnd(15)} ${meter}`);
		});
		this.timeline(facts).slice(-5).forEach((row, index) => add(index ? "" : "Recent", row.text));
		return lines.map((text) => ({ text }));
	}

	private members(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		const rows = team.members.map((member) => ({ member, route: memberRoute(member, assignedWork(member, works)), time: clock(this.host.driver.memberActivity(team.teamId, member.id)?.durationMs ?? 0) }));
		const label = (member: TeamMemberView) => member.id === team.lead ? `${member.id} (lead)` : member.id;
		const aliasWidth = Math.min(Math.floor(width * 0.2), Math.max(...rows.map(({ member }) => visibleWidth(label(member)))));
		const routeWidth = Math.min(Math.floor(width * 0.4), Math.max(...rows.map(({ route }) => visibleWidth(route))));
		const timeWidth = Math.max(...rows.map(({ time }) => time.length));
		const stateWidth = Math.max(1, width - aliasWidth - routeWidth - timeWidth - 8);
		return rows.map(({ member, route, time }) => {
			const status = memberStatus(member);
			return { member: member.id, text: `${this.theme.fg(statusColor(status), ICONS[status])} ${column(label(member), aliasWidth)}  ${column(oneLine(memberDetail(member, facts, works, team.lead)), stateWidth)}  ${column(route, routeWidth)}  ${time.padStart(timeWidth)}` };
		});
	}

	private selectionDetails(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): string[] {
		const row = this.rows[this.selected];
		const title = (text: string) => this.theme.fg("toolTitle", this.theme.bold(text));
		const dim = (text: string) => this.theme.fg("dim", compact(text, width));
		if (this.tab === 1 && row?.member) {
			const member = team.members.find((member) => member.id === row.member)!;
			const work = assignedWork(member, works);
			return [title(member.id), dim(`Task: ${work ? this.host.runtime.getWork(team.teamId, work.work)!.current.task : member.id === team.lead ? team.brief.goal : "No assigned work"}`),
				dim(`Route: ${memberRoute(member, work)}`), dim(latestResult(member.id, works, facts))];
		}
		if (this.tab === 2 && row?.work) {
			const work = row.work;
			return [title(workRefKey(work.work)), dim(`From: ${work.requester} → ${work.assignee} → ${work.requester}`),
				dim(`State: ${workState(work)} · resultRef: ${work.resultRef ?? "—"}`), dim(`Task: ${this.host.runtime.getWork(team.teamId, work.work)!.current.task}`)];
		}
		return [];
	}

	private memberDetail(team: TeamTeamView, works: TeamWorkSummary[], facts: Facts, width: number): Row[] {
		const member = team.members.find((member) => member.id === this.detail)!;
		const work = assignedWork(member, works);
		const task = work ? this.host.runtime.getWork(team.teamId, work.work)?.current.task : undefined;
		const lines = [`Member ${member.id} · Esc back`, `Task: ${task ?? (member.id === team.lead ? team.brief.goal : "No assigned work")}`, "Outbound works:",
			...works.filter((work) => work.requester === member.id).map((work) => `  ${shortWorkRef(work.work)} → ${work.assignee} · ${work.hold ? "held" : work.state}`)];
		const latest = facts.results.get(member.id)?.latest;
		if (latest) lines.push(`Latest result: ${latest.result.status} · ${latest.id}`, latestResult(member.id, works, facts), latest.result.summary);
		else lines.push("Latest result: none");
		return lines.flatMap((text) => wrapTextWithAnsi(stripTerminalSequences(text), width).map((text) => ({ text })));
	}

	private timeline(facts: Facts): Row[] {
		const origin = facts.timeline[0]?.at ?? 0;
		return facts.timeline.map((entry) => ({ text: `${clock(entry.at - origin).padStart(7)}  ${oneLine(entry.text)}`, milestone: `${entry.at}:${entry.text}` }));
	}

	private historyRows(entry: TeamHistoryEntry, width: number): Row[] {
		const heading = `Team ${entry.teamId} · ${entry.lifecycle.toUpperCase()} · ${entry.version === 1 ? "legacy · " : ""}history (read-only)`;
		const lines = this.tab === 0 ? [heading, `Goal: ${entry.goal ?? "not retained"}`, `Outcome: ${entry.outcome ?? entry.lifecycle}`, entry.reason ?? "", `${entry.results.length} retained results`]
			: this.tab === 1 ? [heading, ...entry.members.map((name) => `${name} · ${entry.results.filter((result) => result.author === name).length} results · activity not retained`)]
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
