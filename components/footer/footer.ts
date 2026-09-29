import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { FOOTER_LAYOUT, RAIL_FOOTER_STYLE, type FooterStyle } from "../../config";
import { fitToWidth } from "../../core/utils";
import { railFastFooterLabel } from "../../commands/rail-fast";
import { keepAliveLabel, keepAliveStatus, onKeepAliveChange } from "../../commands/rail-keep-alive";
import { railOaiSearchFooterLabel } from "../../commands/rail-oai-search";
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
	turnStartTime?: number | undefined;
	turnDuration?: number | undefined;
	footerData?: ReadonlyFooterDataProvider | undefined;
};

const FOOTER_STORE_KEY = Symbol.for("pi-rail-ui.footer-state");
const MODAL_MIN_WIDTH = 56;
const MODAL_MAX_WIDTH = 120;
/** The open panel re-reads the session this often so countdowns, context and statuses stay current. */
const MODAL_REFRESH_MS = 1000;

function footerStore(): FooterStore {
	return ((globalThis as any)[FOOTER_STORE_KEY] ??= { turnStartTime: undefined, turnDuration: undefined } satisfies FooterStore);
}

function requestFooterRender(tui?: any): void {
	tui?.requestRender?.();
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

function fitPrioritizedFooterLeft(
	prefixParts: Array<string | undefined>,
	priorityParts: Array<string | undefined>,
	suffixParts: Array<string | undefined>,
	separator: string,
	width: number,
): string {
	const full = visibleJoin([...prefixParts, ...priorityParts, ...suffixParts], separator);
	if (visibleWidth(full) <= width) return full;

	const priority = visibleJoin(priorityParts, separator);
	const separatorWidth = visibleWidth(separator);
	const prefixWidth = Math.max(0, width - visibleWidth(priority) - separatorWidth);
	const fitted = visibleJoin([fitToWidth(visibleJoin(prefixParts, separator), prefixWidth), priority], separator);
	const suffix = visibleJoin(suffixParts, separator);
	const suffixWidth = width - visibleWidth(fitted) - separatorWidth;
	return footerLine(visibleJoin([fitted, suffixWidth > 0 ? fitToWidth(suffix, suffixWidth) : undefined], separator), width);
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

function renderSimpleFooter(width: number, state: FooterLiveState, stats: FooterUsageStats, style: FooterStyle, ka?: string): string[] {
	const identity = `${style.text}▸ ${fitToWidth(state.cwdShort, FOOTER_LAYOUT.cwdMaxWidth)}${state.branch ? `${style.mint}@${fitToWidth(state.branch, FOOTER_LAYOUT.branchMaxWidth)}` : ""}`;
	const fastLabel = railFastFooterLabel();
	const searchLabel = railOaiSearchFooterLabel();
	const separator = `${style.muted} · `;
	const prefixParts = [identity, `${style.sky}${state.modelShort}`];
	const priorityParts = [
		`${style.amber}${state.thinking}`,
		fastLabel ? `${style.sky}${fastLabel}` : undefined,
		searchLabel ? `${searchLabel === "SEARCHING" ? style.amber : style.sky}${searchLabel}` : undefined,
		ka ? `${style.amber}${ka}` : undefined,
	];
	const suffixParts = [
		turnDurationText(state, style),
		state.pending ? `${style.amber}queued` : undefined,
	];
	const right = visibleJoin([
		usageText(stats, style),
		contextText(state, style),
		stats.cost > 0 || state.usingSubscription ? costText(stats.cost, state.usingSubscription, style) : undefined,
	], separator);
	const priority = visibleJoin(priorityParts, separator);
	const fittedRight = fitToWidth(right, Math.max(0, width - Math.min(width, visibleWidth(priority)) - 1));
	const rightWidth = visibleWidth(fittedRight);
	const leftWidth = rightWidth >= width ? 0 : Math.max(0, width - rightWidth - (fittedRight ? 1 : 0));
	const left = fitPrioritizedFooterLeft(
		prefixParts,
		priorityParts,
		suffixParts,
		separator,
		leftWidth,
	);
	return [fitAligned(left, fittedRight, width)];
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
	const maxHeight = availableHeight;

	return { anchor: "center", width, maxHeight, margin };
}

function modalFit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…", true);
}

function modalPad(text: string, width: number): string {
	const fitted = modalFit(text, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

export class RailSessionModal implements Component {
	private scroll = 0;
	private lastPage = 1;

	/** maxHeight may be read per frame, so a terminal resize changes the page instead of clipping it. */
	constructor(
		private snapshot: RailSessionSnapshot,
		private readonly theme: Theme,
		private readonly maxHeight: number | (() => number),
		private readonly done: () => void,
		private readonly onDispose: () => void = () => {},
	) {}

	dispose(): void {
		this.onDispose();
	}

	update(snapshot: RailSessionSnapshot): void {
		this.snapshot = snapshot;
	}

	render(width: number): string[] {
		const frameWidth = Math.max(32, width);
		const innerWidth = Math.max(1, frameWidth - 2);
		const contentWidth = Math.max(1, innerWidth - 2);
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content: string) => `${border("│")}${modalPad(` ${content}`, innerWidth)}${border("│")}`;
		const content = renderRailSessionContent(this.snapshot, this.theme, contentWidth);
		const page = Math.max(1, (typeof this.maxHeight === "function" ? this.maxHeight() : this.maxHeight) - 4);
		this.lastPage = page;
		this.scroll = Math.max(0, Math.min(this.scroll, content.length - page));
		const visible = content.slice(this.scroll, this.scroll + page);
		const more = content.length > page;
		const hint = more
			? `${this.scroll + 1}-${this.scroll + visible.length}/${content.length} · ↑↓ PgUp/PgDn scroll · Esc close`
			: "Esc/Enter/q close";
		return [
			border(`╭${"─".repeat(innerWidth)}╮`),
			...visible.map(row),
			row(""),
			row(this.theme.fg("dim", hint)),
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
			return;
		}
		const step = matchesKey(data, "up") || data === "k" ? -1 : matchesKey(data, "down") || data === "j" ? 1
			: matchesKey(data, "pageUp") ? -this.lastPage : matchesKey(data, "pageDown") || data === " " ? this.lastPage
			: matchesKey(data, "home") ? -Infinity : matchesKey(data, "end") ? Infinity : 0;
		// render() clamps the offset to the content length.
		if (step) this.scroll = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, this.scroll + step));
	}

	invalidate(): void {
		// Rendered from the latest snapshot on every frame.
	}
}

function railSessionSnapshot(ctx: ExtensionContext, pi: ExtensionAPI): RailSessionSnapshot {
	const snapshot = collectRailSessionSnapshot(ctx, pi, latestFooterData());
	snapshot.keepAlive = keepAliveStatus(ctx.sessionManager);
	snapshot.keepAliveLabel = keepAliveLabel(ctx.sessionManager);
	return snapshot;
}

export async function openRailSessionModal(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/rail-session requires interactive TUI mode.", "warning");
		return;
	}

	const overlayOptions = resolveRailSessionOverlayOptions();
	let stop = () => {};
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				let timer: ReturnType<typeof setInterval> | undefined;
				let unsubscribe = () => {};
				stop = () => { clearInterval(timer); unsubscribe(); };
				const modal = new RailSessionModal(railSessionSnapshot(ctx, pi), theme,
					() => resolveRailSessionOverlayOptions().maxHeight, () => done(), () => stop());
				const refresh = () => {
					// A reload or session switch can hide the panel without closing it; its ctx is then stale.
					try { modal.update(railSessionSnapshot(ctx, pi)); } catch { stop(); return; }
					tui.requestRender();
				};
				timer = setInterval(refresh, MODAL_REFRESH_MS);
				timer.unref?.();
				unsubscribe = onKeepAliveChange(ctx.sessionManager, refresh);
				return modal;
			},
			{ overlay: true, overlayOptions },
		);
	} finally {
		stop();
	}
}

export function renderFooter(
	width: number,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	footerData: ReadonlyFooterDataProvider,
	stats: FooterUsageStats = collectFooterUsageStats(ctx),
	style: FooterStyle = RAIL_FOOTER_STYLE,
): string[] {
	return renderSimpleFooter(width, collectFooterLiveState(ctx, pi, footerData), stats, style, keepAliveLabel(ctx.sessionManager));
}

class RailFooterComponent {
	private usageCache?: { entryCount: number; lastEntry: any; stats: FooterUsageStats } | undefined;
	private disposed = false;
	private readonly unsubscribe?: () => void;
	private readonly unsubscribeKeepAlive: () => void;

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
		this.unsubscribeKeepAlive = onKeepAliveChange(ctx.sessionManager, () => requestFooterRender(this.tui));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribeKeepAlive();
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
		return renderSimpleFooter(width, state, this.usageStats(), RAIL_FOOTER_STYLE, keepAliveLabel(this.ctx.sessionManager));
	}

}

export function createRailFooter(ctx: ExtensionContext, pi: ExtensionAPI) {
	return (tui: any, _theme: any, footerData: ReadonlyFooterDataProvider) => new RailFooterComponent(tui, ctx, pi, footerData);
}
