import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { FOOTER_LAYOUT, RAIL_FOOTER_STYLE, type FooterStyle } from "../../config";
import { fitToWidth } from "../../core/utils";
import { railFastFooterLabel } from "../../commands/rail-fast";
import {
	collectFooterLiveState,
	collectFooterUsageStats,
	collectRailSessionSnapshot,
	footerUsageEntries,
	formatCost,
	formatNum,
	renderRailSessionContent,
	usageStatsFromEntries,
	type FooterLiveState,
	type FooterUsageStats,
	type RailSessionSnapshot,
} from "./footer-session-presenter";

type FooterStore = {
	selectionNoticeUntil: number;
	selectionNoticeTimer?: ReturnType<typeof setTimeout> | undefined;
	turnStartTime?: number | undefined;
	turnDuration?: number | undefined;
	footerData?: ReadonlyFooterDataProvider | undefined;
};

const FOOTER_STORE_KEY = Symbol.for("pi-rail-ui.footer-state");
const MODAL_MIN_WIDTH = 56;
const MODAL_MAX_WIDTH = 92;

function footerStore(): FooterStore {
	return ((globalThis as any)[FOOTER_STORE_KEY] ??= { selectionNoticeUntil: 0, turnStartTime: undefined, turnDuration: undefined } satisfies FooterStore);
}

function requestFooterRender(tui?: any): void {
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

function rememberFooterData(footerData: ReadonlyFooterDataProvider): void {
	footerStore().footerData = footerData;
}

function latestFooterData(): ReadonlyFooterDataProvider | undefined {
	return footerStore().footerData;
}

function renderSimpleFooter(width: number, state: FooterLiveState, stats: FooterUsageStats, style: FooterStyle): string[] {
	const identity = `${style.text}▸ ${fitToWidth(state.cwdShort, FOOTER_LAYOUT.cwdMaxWidth)}${state.branch ? `${style.mint}@${fitToWidth(state.branch, FOOTER_LAYOUT.branchMaxWidth)}` : ""}`;
	const fastLabel = railFastFooterLabel();
	const left = visibleJoin([
		identity,
		`${style.sky}${state.modelShort}`,
		`${style.amber}${state.thinking}`,
		fastLabel ? `${style.sky}${fastLabel}` : undefined,
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

type RailSessionOverlayOptions = {
	anchor: "center";
	width: number;
	maxHeight: number;
	margin: number;
};

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

	const snapshot = collectRailSessionSnapshot(ctx, pi, latestFooterData());
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
	return renderSimpleFooter(width, collectFooterLiveState(ctx, pi, footerData), stats, style);
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
		return renderSimpleFooter(width, state, this.usageStats(), RAIL_FOOTER_STYLE);
	}

}

export function createRailFooter(ctx: ExtensionContext, pi: ExtensionAPI) {
	return (tui: any, _theme: any, footerData: ReadonlyFooterDataProvider) => new RailFooterComponent(tui, ctx, pi, footerData);
}
