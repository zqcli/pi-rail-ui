import * as path from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { FOOTER_LAYOUT, RAIL_FOOTER_STYLE, type FooterStyle } from "../../config";
import { fitToWidth } from "../../core/utils";
import { getConversationScrollStore, stateFor } from "../chat-view/state";

export type FooterUsageStats = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
};

type RailSessionStats = {
	sessionFile?: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
};

export type FooterLiveState = {
	cwd: string;
	cwdShort: string;
	branch?: string | null | undefined;
	sessionName?: string | undefined;
	idle: boolean;
	pending: boolean;
	modelId?: string | undefined;
	modelShort: string;
	provider?: string | undefined;
	thinking: string;
	activeTools: string[];
	allToolCount: number;
	extensionStatuses: string[];
	contextTokens?: number | null | undefined;
	contextWindow?: number | undefined;
	contextPercent?: number | null | undefined;
	usingSubscription?: boolean | undefined;
};

type FooterStore = {
	selectionNoticeUntil: number;
	selectionNoticeTimer?: ReturnType<typeof setTimeout> | undefined;
	turnStartTime?: number | undefined;
	turnDuration?: number | undefined;
	footerData?: ReadonlyFooterDataProvider | undefined;
};

const FOOTER_STORE_KEY = Symbol.for("pi-rail-ui.footer-state");
const SIMPLE_MODEL_MAX_WIDTH = Math.max(12, FOOTER_LAYOUT.modelMaxWidth);
const MODAL_MIN_WIDTH = 56;
const MODAL_MAX_WIDTH = 92;
const MODAL_LABEL_WIDTH = 12;

function footerStore(): FooterStore {
	return ((globalThis as any)[FOOTER_STORE_KEY] ??= { selectionNoticeUntil: 0, turnStartTime: undefined, turnDuration: undefined } satisfies FooterStore);
}

function requestFooterRender(tui?: any): void {
	if (tui && typeof tui === "object") {
		stateFor(tui, getConversationScrollStore()).preferCachedRender = true;
	}
	tui?.requestRender?.();
}

export function showFooterSelectionNotice(tui?: any, durationMs = 1800): void {
	const store = footerStore();
	store.selectionNoticeUntil = Date.now() + durationMs;
	if (store.selectionNoticeTimer) clearTimeout(store.selectionNoticeTimer);
	store.selectionNoticeTimer = setTimeout(() => {
		store.selectionNoticeTimer = undefined;
		store.selectionNoticeUntil = 0;
		requestFooterRender(tui);
	}, durationMs);
	requestFooterRender(tui);
}

export function setTurnStartTime(time: number): void {
	const store = footerStore();
	store.turnStartTime = time;
	store.turnDuration = undefined;
}

export function setTurnEndTime(): void {
	const store = footerStore();
	if (store.turnStartTime !== undefined) store.turnDuration = Date.now() - store.turnStartTime;
	store.turnStartTime = undefined;
}

function formatDuration(ms: number, style: FooterStyle): string {
	const totalMinutes = Math.floor(ms / 60000);
	if (totalMinutes < 60) return `${style.amber}${totalMinutes}m`;
	return `${style.amber}${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`;
}

function turnDurationText(state: FooterLiveState, style: FooterStyle): string | undefined {
	const store = footerStore();
	if (!state.idle && store.turnStartTime !== undefined) return formatDuration(Date.now() - store.turnStartTime, style);
	if (store.turnDuration !== undefined) return formatDuration(store.turnDuration, style);
	return undefined;
}

function selectionNoticeText(style: FooterStyle): string | undefined {
	return footerStore().selectionNoticeUntil > Date.now() ? `${style.mint}selection copied` : undefined;
}

function formatNum(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatInteger(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function trimFixed(value: number, digits: number): string {
	return value.toFixed(digits).replace(/\.?0+$/u, "");
}

function formatTokenAmount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0K";
	if (value >= 1_000_000) return `${trimFixed(value / 1_000_000, 2)}M`;
	const thousands = value / 1000;
	if (thousands < 0.1) return "<0.1K";
	return `${trimFixed(thousands, 1)}K`;
}

function formatCachePercent(tokens: RailSessionStats["tokens"]): string {
	const cacheRead = Math.max(0, tokens.cacheRead);
	const nonCachedInput = Math.max(0, tokens.input);
	const totalInput = cacheRead + nonCachedInput;
	if (totalInput <= 0) return "0%";
	return `${trimFixed((cacheRead / totalInput) * 100, 1)}%`;
}

function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

function footerLine(content: string, width: number): string {
	return truncateToWidth(content, Math.max(0, width), "…", true);
}

function visibleJoin(parts: Array<string | undefined>, separator: string): string {
	let out = "";
	for (const part of parts) {
		if (!part || visibleWidth(part) <= 0) continue;
		out += out ? `${separator}${part}` : part;
	}
	return out;
}

function fitAligned(left: string, right: string, width: number): string {
	if (!right) return footerLine(left, width);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return footerLine(right, width);
	const fittedLeft = fitToWidth(left, Math.max(0, width - rightWidth - 1));
	const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
	return footerLine(`${fittedLeft}${gap}${right}`, width);
}

function stateText(state: FooterLiveState, style: FooterStyle): string {
	return state.idle ? `${style.mint}● ready` : `${style.amber}● working`;
}

function contextText(state: FooterLiveState, style: FooterStyle): string {
	const hasPercent = typeof state.contextPercent === "number" && Number.isFinite(state.contextPercent);
	const percent = hasPercent ? `${state.contextPercent!.toFixed(2)}%` : "?";
	const color = hasPercent && state.contextPercent! >= 70 ? style.amber : style.lilac;
	return `${color}ctx ${percent}`;
}

function costText(cost: number, usingSubscription: boolean | undefined, style: FooterStyle): string {
	return `${style.mint}${formatCost(cost)}${usingSubscription ? " (sub)" : ""}`;
}

function usageText(stats: FooterUsageStats, style: FooterStyle): string {
	return visibleJoin([
		`${style.sky}↑${formatNum(stats.inputTokens)}`,
		`${style.sky}↓${formatNum(stats.outputTokens)}`,
		`${style.lilac}R${formatNum(stats.cacheReadTokens)}`,
		`${style.lilac}W${formatNum(stats.cacheWriteTokens)}`,
	], " ");
}

function footerUsageEntries(ctx: ExtensionContext): any[] {
	return ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
}

function usageStatsFromEntries(entries: any[]): FooterUsageStats {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let cost = 0;

	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const usage = entry.message?.usage;
		if (!usage) continue;
		inputTokens += usage.input ?? 0;
		outputTokens += usage.output ?? 0;
		cacheReadTokens += usage.cacheRead ?? 0;
		cacheWriteTokens += usage.cacheWrite ?? 0;
		cost += usage.cost?.total ?? 0;
	}

	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost };
}

function sessionStatsFromEntries(ctx: ExtensionContext, entries: any[], stats: FooterUsageStats): RailSessionStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolCalls = 0;
	let toolResults = 0;
	let totalMessages = 0;

	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object") continue;
		totalMessages++;
		if (message.role === "user") userMessages++;
		else if (message.role === "assistant") {
			assistantMessages++;
			const content = Array.isArray(message.content) ? message.content : [];
			toolCalls += content.filter((part: any) => part?.type === "toolCall").length;
		} else if (message.role === "toolResult") toolResults++;
	}

	return {
		sessionFile: ctx.sessionManager.getSessionFile(),
		sessionId: ctx.sessionManager.getSessionId(),
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: stats.inputTokens,
			output: stats.outputTokens,
			cacheRead: stats.cacheReadTokens,
			cacheWrite: stats.cacheWriteTokens,
			total: stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens,
		},
		cost: stats.cost,
	};
}

export function collectFooterUsageStats(ctx: ExtensionContext): FooterUsageStats {
	return usageStatsFromEntries(footerUsageEntries(ctx));
}

function rememberFooterData(footerData: ReadonlyFooterDataProvider): void {
	footerStore().footerData = footerData;
}

function latestFooterData(): ReadonlyFooterDataProvider | undefined {
	return footerStore().footerData;
}

function collectFooterLiveState(ctx: ExtensionContext, pi: ExtensionAPI, footerData?: ReadonlyFooterDataProvider, options: { details?: boolean } = {}): FooterLiveState {
	const rawCwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const home = process.env["HOME"] || process.env["USERPROFILE"];
	const includeDetails = options.details === true;
	const contextUsage = ctx.getContextUsage();
	let activeTools: string[] = [];
	let allToolCount = 0;
	let usingSubscription = false;

	if (includeDetails) {
		try {
			activeTools = [...(pi.getActiveTools?.() ?? [])];
			allToolCount = pi.getAllTools?.()?.length ?? 0;
		} catch {
			activeTools = [];
			allToolCount = 0;
		}
	}
	try {
		usingSubscription = Boolean(ctx.model && ctx.modelRegistry?.isUsingOAuth?.(ctx.model));
	} catch {
		usingSubscription = false;
	}

	const modelId = ctx.model?.id;
	const modelShort = modelId
		? fitToWidth(modelId
			.replace(/^claude-/, "claude ")
			.replace(/^gemini-/, "gemini ")
			.replace(/^gpt-/, "gpt ")
			.replace(/-20\d{6}$/u, "")
			.replace(/-latest$/u, "")
			.replace(/-preview$/u, "")
			.replace(/-/gu, " ")
			.replace(/\s+/gu, " ")
			.trim(), SIMPLE_MODEL_MAX_WIDTH)
		: "no model";
	const extensionStatuses = includeDetails && footerData
		? Array.from(footerData.getExtensionStatuses().entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
			.filter(Boolean)
		: [];

	return {
		cwd: home && rawCwd.startsWith(home) ? `~${rawCwd.slice(home.length)}` : rawCwd,
		cwdShort: path.basename(ctx.cwd) || ctx.cwd,
		branch: footerData?.getGitBranch?.(),
		sessionName: ctx.sessionManager.getSessionName?.(),
		idle: ctx.isIdle(),
		pending: ctx.hasPendingMessages?.() === true,
		modelId,
		modelShort,
		provider: (ctx.model as any)?.provider,
		thinking: pi.getThinkingLevel?.() ?? "off",
		activeTools,
		allToolCount,
		extensionStatuses,
		contextTokens: contextUsage?.tokens,
		contextWindow: contextUsage?.contextWindow,
		contextPercent: contextUsage?.percent,
		usingSubscription,
	};
}

function renderSimpleFooter(width: number, state: FooterLiveState, stats: FooterUsageStats, style: FooterStyle): string[] {
	const identity = `${style.text}▸ ${fitToWidth(state.cwdShort, FOOTER_LAYOUT.cwdMaxWidth)}${state.branch ? `${style.mint}@${fitToWidth(state.branch, FOOTER_LAYOUT.branchMaxWidth)}` : ""}`;
	const left = visibleJoin([
		identity,
		`${style.sky}${state.modelShort}`,
		`${style.amber}${state.thinking}`,
		stateText(state, style),
		turnDurationText(state, style),
		state.pending ? `${style.amber}queued` : undefined,
		selectionNoticeText(style),
	], `${style.muted} · `);
	const right = visibleJoin([
		usageText(stats, style),
		contextText(state, style),
		stats.cost > 0 || state.usingSubscription ? costText(stats.cost, state.usingSubscription, style) : undefined,
	], `${style.muted} · `);
	return [fitAligned(left, right, width)];
}

function renderFooterRows(width: number, state: FooterLiveState, stats: FooterUsageStats, style: FooterStyle): string[] {
	return renderSimpleFooter(width, state, stats, style);
}

type RailSessionSnapshot = {
	state: FooterLiveState;
	session: RailSessionStats;
	capturedAt: Date;
};

type RailSessionOverlayOptions = {
	anchor: "center";
	width: number;
	maxHeight: number;
	margin: number;
};

function collectRailSessionSnapshot(ctx: ExtensionContext, pi: ExtensionAPI): RailSessionSnapshot {
	const entries = footerUsageEntries(ctx);
	const stats = usageStatsFromEntries(entries);
	return {
		state: collectFooterLiveState(ctx, pi, latestFooterData(), { details: true }),
		session: sessionStatsFromEntries(ctx, entries, stats),
		capturedAt: new Date(),
	};
}

function resolveRailSessionOverlayOptions(): RailSessionOverlayOptions {
	const terminalWidth =
		typeof process.stdout.columns === "number" && Number.isFinite(process.stdout.columns)
			? process.stdout.columns
			: 120;
	const terminalHeight =
		typeof process.stdout.rows === "number" && Number.isFinite(process.stdout.rows)
			? process.stdout.rows
			: 36;

	const margin = 1;
	const availableWidth = Math.max(MODAL_MIN_WIDTH, terminalWidth - margin * 2);
	const width = Math.max(MODAL_MIN_WIDTH, Math.min(MODAL_MAX_WIDTH, availableWidth));
	const availableHeight = Math.max(12, terminalHeight - margin * 2);
	const maxHeight = Math.min(26, availableHeight);

	return { anchor: "center", width, maxHeight, margin };
}

function modalFit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…", true);
}

function modalPad(text: string, width: number): string {
	const fitted = modalFit(text, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function modalSection(theme: Theme, label: string): string {
	return ` ${theme.fg("accent", theme.bold(label))}`;
}

function modalField(theme: Theme, label: string, value: string, width: number): string {
	const safeLabel = modalPad(label, MODAL_LABEL_WIDTH);
	const prefix = `  ${theme.fg("dim", safeLabel)} `;
	return modalFit(`${prefix}${value}`, width);
}

function modalMetricCell(theme: Theme, label: string, value: string, width: number): string {
	const labelWidth = Math.min(12, Math.max(7, Math.floor(width * 0.52)));
	return modalPad(`${theme.fg("dim", modalPad(label, labelWidth))} ${theme.fg("success", value)}`, width);
}

function modalMetricRow(theme: Theme, left: [string, string], right: [string, string], width: number): string {
	const gap = 2;
	const bodyWidth = Math.max(1, width - 2);
	const leftWidth = Math.max(1, Math.floor((bodyWidth - gap) / 2));
	const rightWidth = Math.max(1, bodyWidth - gap - leftWidth);
	return modalFit(`  ${modalMetricCell(theme, left[0], left[1], leftWidth)}${" ".repeat(gap)}${modalMetricCell(theme, right[0], right[1], rightWidth)}`, width);
}

function contextProgress(theme: Theme, percent: number | null | undefined): string | undefined {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
	const used = Math.max(0, Math.min(100, percent));
	const cells = 18;
	const filled = Math.round((used / 100) * cells);
	const bar = `${theme.fg(used >= 70 ? "warning" : "accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(cells - filled))}`;
	return `${bar} ${theme.fg(used >= 70 ? "warning" : "success", `${used.toFixed(2)}% used`)}`;
}

function toolSummary(state: FooterLiveState): string | undefined {
	if (state.activeTools.length > 0 && state.activeTools.length <= 8) return state.activeTools.join(", ");
	if (state.activeTools.length > 0) return `${state.activeTools.length}/${state.allToolCount || state.activeTools.length} active`;
	if (state.allToolCount > 0) return `0/${state.allToolCount} active`;
	return undefined;
}

function extensionSummary(state: FooterLiveState): string | undefined {
	if (state.extensionStatuses.length === 0) return undefined;
	if (state.extensionStatuses.length === 1) return state.extensionStatuses[0];
	return `${state.extensionStatuses.length} statuses · ${state.extensionStatuses[0]}`;
}

function contextValue(theme: Theme, state: FooterLiveState): string {
	const tokens = typeof state.contextTokens === "number" && Number.isFinite(state.contextTokens) ? state.contextTokens : undefined;
	const window = typeof state.contextWindow === "number" && Number.isFinite(state.contextWindow) ? state.contextWindow : undefined;
	const percent = typeof state.contextPercent === "number" && Number.isFinite(state.contextPercent) ? `${state.contextPercent.toFixed(2)}% used` : undefined;
	if (tokens !== undefined && window !== undefined) {
		return `${theme.fg("success", formatNum(tokens))}${theme.fg("dim", " used / ")}${theme.fg("success", formatNum(window))}${percent ? theme.fg("dim", ` (${percent})`) : ""}`;
	}
	if (percent) return theme.fg("success", percent);
	if (tokens !== undefined) return `${theme.fg("success", formatNum(tokens))}${theme.fg("dim", " used")}`;
	return theme.fg("dim", "unknown");
}

function renderRailSessionContent(snapshot: RailSessionSnapshot, theme: Theme, width: number): string[] {
	const { state, session } = snapshot;
	const model = `${state.provider ? `${state.provider}/` : ""}${state.modelId ?? "no model"}`;
	const tools = toolSummary(state);
	const extensions = extensionSummary(state);
	const rows: string[] = [
		`${theme.fg("accent", theme.bold("Rail Session"))}${theme.fg("dim", `  ${snapshot.capturedAt.toLocaleTimeString()}`)}`,
		"",
		modalSection(theme, "Session Info"),
		modalField(theme, "File", theme.fg("text", session.sessionFile ?? "in-memory"), width),
		modalField(theme, "ID", theme.fg("text", session.sessionId), width),
	];

	if (state.sessionName) rows.push(modalField(theme, "Name", theme.fg("text", state.sessionName), width));

	rows.push("", modalSection(theme, "Messages / Tokens"));
	rows.push(modalMetricRow(theme, ["User", formatInteger(session.userMessages)], ["Input", formatTokenAmount(session.tokens.input)], width));
	rows.push(modalMetricRow(theme, ["Assistant", formatInteger(session.assistantMessages)], ["Output", formatTokenAmount(session.tokens.output)], width));
	rows.push(modalMetricRow(theme, ["Tool Calls", formatInteger(session.toolCalls)], ["Cache", formatCachePercent(session.tokens)], width));
	rows.push(modalMetricRow(theme, ["Tool Results", formatInteger(session.toolResults)], ["Cache R/W", `${formatTokenAmount(session.tokens.cacheRead)}/${formatTokenAmount(session.tokens.cacheWrite)}`], width));
	rows.push(modalMetricRow(theme, ["Total", formatInteger(session.totalMessages)], ["Tokens", formatTokenAmount(session.tokens.total)], width));
	if (session.cost > 0 || state.usingSubscription) {
		const billing = `${theme.fg("success", formatCost(session.cost))}${state.usingSubscription ? theme.fg("dim", " (sub)") : ""}`;
		rows.push(modalField(theme, "Cost", billing, width));
	}

	rows.push("", modalSection(theme, "Runtime"));
	rows.push(modalField(theme, "Model", theme.fg("text", model), width));
	rows.push(modalField(theme, "Thinking", theme.fg("text", state.thinking), width));
	if (state.pending) rows.push(modalField(theme, "Queue", theme.fg("warning", "pending messages"), width));
	rows.push(modalField(theme, "Directory", theme.fg("text", state.cwd), width));
	if (state.branch) rows.push(modalField(theme, "Branch", theme.fg("text", state.branch), width));
	const progress = contextProgress(theme, state.contextPercent);
	if (progress) rows.push(modalField(theme, "Context", progress, width));
	rows.push(modalField(theme, "Window", contextValue(theme, state), width));
	if (tools || extensions) rows.push(modalField(theme, "Tools", theme.fg("text", tools ?? "none"), width));
	if (extensions) rows.push(modalField(theme, "Extensions", theme.fg("text", extensions), width));

	return rows;
}

class RailSessionModal implements Component {
	constructor(
		private readonly snapshot: RailSessionSnapshot,
		private readonly theme: Theme,
		private readonly maxHeight: number,
		private readonly done: () => void,
	) {}

	render(width: number): string[] {
		const frameWidth = Math.max(32, width);
		const innerWidth = Math.max(1, frameWidth - 2);
		const contentWidth = Math.max(1, innerWidth - 2);
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content: string) => `${border("│")}${modalPad(` ${content}`, innerWidth)}${border("│")}`;
		const maxContentRows = Math.max(1, this.maxHeight - 4);
		let content = renderRailSessionContent(this.snapshot, this.theme, contentWidth);
		if (content.length > maxContentRows) {
			content = [
				...content.slice(0, Math.max(0, maxContentRows - 1)),
				this.theme.fg("dim", "  …"),
			];
		}
		const lines = [
			border(`╭${"─".repeat(innerWidth)}╮`),
			...content.map(row),
			row(""),
			row(this.theme.fg("dim", "Esc/Enter/q close")),
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
		}
	}

	invalidate(): void {
		// Snapshot renderer; nothing cached between frames.
	}
}

export async function openRailSessionModal(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/rail-session requires interactive TUI mode.", "warning");
		return;
	}

	const snapshot = collectRailSessionSnapshot(ctx, pi);
	const overlayOptions = resolveRailSessionOverlayOptions();
	await ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) => new RailSessionModal(snapshot, theme, overlayOptions.maxHeight, () => done()),
		{ overlay: true, overlayOptions },
	);
}

export function renderFooter(
	width: number,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	footerData: ReadonlyFooterDataProvider,
	stats: FooterUsageStats = collectFooterUsageStats(ctx),
	style: FooterStyle = RAIL_FOOTER_STYLE,
): string[] {
	return renderFooterRows(width, collectFooterLiveState(ctx, pi, footerData), stats, style);
}

class RailFooterComponent {
	private usageCache?: { entryCount: number; lastEntry: any; stats: FooterUsageStats } | undefined;
	private readonly unsubscribe?: () => void;

	constructor(
		private readonly tui: any,
		private readonly ctx: ExtensionContext,
		private readonly pi: ExtensionAPI,
		private readonly footerData: ReadonlyFooterDataProvider,
	) {
		rememberFooterData(footerData);
		this.unsubscribe = footerData.onBranchChange?.(() => {
			requestFooterRender(this.tui);
		});
	}

	dispose(): void {
		this.unsubscribe?.();
	}

	invalidate(): void {
		// Usage stats are keyed by session entries below; recomputing them on
		// every invalidate would rescan the whole session each frame.
	}

	private usageStats(): FooterUsageStats {
		const entries = footerUsageEntries(this.ctx);
		const lastEntry = entries[entries.length - 1];
		let cache = this.usageCache;
		if (!cache || cache.entryCount !== entries.length || cache.lastEntry !== lastEntry) {
			cache = { entryCount: entries.length, lastEntry, stats: usageStatsFromEntries(entries) };
			this.usageCache = cache;
		}
		return cache.stats;
	}

	render(width: number): string[] {
		const state = collectFooterLiveState(this.ctx, this.pi, this.footerData);
		return renderFooterRows(width, state, this.usageStats(), RAIL_FOOTER_STYLE);
	}

}

export function createRailFooter(ctx: ExtensionContext, pi: ExtensionAPI) {
	return (tui: any, _theme: any, footerData: ReadonlyFooterDataProvider) => new RailFooterComponent(tui, ctx, pi, footerData);
}
