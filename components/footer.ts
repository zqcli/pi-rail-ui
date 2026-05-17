import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { FOOTER_LAYOUT, TALL_GRAY_EDITOR_SURFACE_STYLE, TALL_GRAY_FOOTER_STYLE, type FooterStyle } from "../config";
import { fitToWidth } from "../utils";

export type FooterStats = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
	contextTokens?: number | null;
	contextWindow?: number;
	contextPercent?: number | null;
	usingSubscription?: boolean;
};

type FooterStore = {
	expanded: boolean;
};

type FooterRenderState = {
	cwd: string;
	cwdShort: string;
	branch?: string | null;
	sessionName?: string;
	idle: boolean;
	pending: boolean;
	modelId?: string;
	modelShort: string;
	provider?: string;
	providerCount: number;
	thinking: string;
	activeTools: string[];
	allToolCount: number;
	extensionStatuses: string[];
	expanded: boolean;
};

const FOOTER_STORE_KEY = Symbol.for("pi-rail-ui.footer-state");
const FOOTER_LEFT_GAP = Math.max(0, TALL_GRAY_EDITOR_SURFACE_STYLE.leftWindowGapWidth);
const SIMPLE_MODEL_MAX_WIDTH = Math.max(12, FOOTER_LAYOUT.modelMaxWidth);
const EXPANDED_MODEL_MAX_WIDTH = Math.max(28, FOOTER_LAYOUT.modelMaxWidth + 12);
const SESSION_MAX_WIDTH = 28;
const STATUS_MAX_WIDTH = 32;

function footerStore(): FooterStore {
	const g = globalThis as any;
	return g[FOOTER_STORE_KEY] ??= { expanded: false } satisfies FooterStore;
}

export function isFooterExpanded(): boolean {
	return footerStore().expanded;
}

export function setFooterExpanded(expanded: boolean): void {
	footerStore().expanded = expanded;
}

export function toggleFooterExpanded(): boolean {
	const store = footerStore();
	store.expanded = !store.expanded;
	return store.expanded;
}

function formatNum(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

function formatContextPercent(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "?";
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function compactPath(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function shortModelName(model?: string, maxWidth = SIMPLE_MODEL_MAX_WIDTH): string {
	if (!model) return "no model";
	const simplified = model
		.replace(/^claude-/, "claude ")
		.replace(/^gemini-/, "gemini ")
		.replace(/^gpt-/, "gpt ")
		.replace(/-20\d{6}$/u, "")
		.replace(/-latest$/u, "")
		.replace(/-preview$/u, "")
		.replace(/-/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return fitToWidth(simplified, maxWidth);
}

function footerLine(content: string, width: number): string {
	return truncateToWidth(content, Math.max(0, width), "…", true);
}

function footerContentWidth(width: number): number {
	return Math.max(0, width - Math.min(FOOTER_LEFT_GAP, Math.max(0, width)));
}

function addFooterLeftGap(rows: string[], width: number): string[] {
	if (FOOTER_LEFT_GAP <= 0) return rows.map((row) => footerLine(row, width));
	const prefix = " ".repeat(Math.min(FOOTER_LEFT_GAP, Math.max(0, width)));
	const contentWidth = footerContentWidth(width);
	return rows.map((row) => `${prefix}${footerLine(row, contentWidth)}`);
}

function visibleJoin(parts: Array<string | undefined>, separator: string): string {
	return parts.filter((part): part is string => Boolean(part && visibleWidth(part) > 0)).join(separator);
}

function fitAligned(left: string, right: string, width: number): string {
	if (!right) return footerLine(left, width);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return footerLine(right, width);
	const fittedLeft = fitToWidth(left, Math.max(0, width - rightWidth - 1));
	const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
	return footerLine(`${fittedLeft}${gap}${right}`, width);
}

function usageFromEntry(entry: any): FooterStats | undefined {
	if (entry?.type !== "message") return undefined;
	const usage = entry.message?.usage;
	if (!usage) return undefined;
	return {
		inputTokens: usage.input ?? 0,
		outputTokens: usage.output ?? 0,
		cacheReadTokens: usage.cacheRead ?? 0,
		cacheWriteTokens: usage.cacheWrite ?? 0,
		totalTokens: 0,
		cost: usage.cost?.total ?? 0,
	};
}

export function collectFooterStats(ctx: ExtensionContext): FooterStats {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let cost = 0;

	const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
	for (const entry of entries) {
		const usage = usageFromEntry(entry);
		if (!usage) continue;
		inputTokens += usage.inputTokens;
		outputTokens += usage.outputTokens;
		cacheReadTokens += usage.cacheReadTokens;
		cacheWriteTokens += usage.cacheWriteTokens;
		cost += usage.cost;
	}

	const contextUsage = ctx.getContextUsage();
	const contextTokens = contextUsage?.tokens;
	const usageTotal = inputTokens + outputTokens;
	const totalTokens = typeof contextTokens === "number" ? contextTokens : usageTotal;
	let usingSubscription = false;
	try {
		usingSubscription = Boolean(ctx.model && ctx.modelRegistry?.isUsingOAuth?.(ctx.model));
	} catch {
		usingSubscription = false;
	}

	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		cost,
		contextTokens,
		contextWindow: contextUsage?.contextWindow,
		contextPercent: contextUsage?.percent,
		usingSubscription,
	};
}

function footerStatuses(footerData: any): string[] {
	const statuses = footerData.getExtensionStatuses?.();
	if (!statuses || typeof statuses.entries !== "function") return [];
	return Array.from(statuses.entries())
		.sort(([a], [b]) => String(a).localeCompare(String(b)))
		.map(([, text]) => sanitizeStatusText(String(text)))
		.filter(Boolean);
}

function safeTools(pi: ExtensionAPI): { activeTools: string[]; allToolCount: number } {
	try {
		const activeTools = pi.getActiveTools?.() ?? [];
		const allTools = pi.getAllTools?.() ?? [];
		return { activeTools: [...activeTools], allToolCount: allTools.length };
	} catch {
		return { activeTools: [], allToolCount: 0 };
	}
}

function renderState(ctx: ExtensionContext, pi: ExtensionAPI, footerData: any): FooterRenderState {
	const cwd = compactPath(ctx.sessionManager.getCwd?.() ?? ctx.cwd);
	const cwdShort = path.basename(ctx.cwd) || ctx.cwd;
	const branch = footerData.getGitBranch?.();
	const { activeTools, allToolCount } = safeTools(pi);
	const provider = (ctx.model as any)?.provider;
	const modelId = ctx.model?.id;
	let providerCount = 0;
	try {
		providerCount = footerData.getAvailableProviderCount?.() ?? 0;
	} catch {
		providerCount = 0;
	}
	return {
		cwd,
		cwdShort,
		branch,
		sessionName: ctx.sessionManager.getSessionName?.(),
		idle: ctx.isIdle(),
		pending: ctx.hasPendingMessages?.() === true,
		modelId,
		modelShort: shortModelName(modelId),
		provider,
		providerCount,
		thinking: pi.getThinkingLevel?.() ?? "off",
		activeTools,
		allToolCount,
		extensionStatuses: footerStatuses(footerData),
		expanded: isFooterExpanded(),
	};
}

function stateText(state: FooterRenderState, style: FooterStyle): string {
	return state.idle ? `${style.mint}● ready` : `${style.amber}● working`;
}

function contextText(stats: FooterStats, style: FooterStyle, expanded = false): string {
	const hasPercent = typeof stats.contextPercent === "number" && Number.isFinite(stats.contextPercent);
	const percent = hasPercent ? `${formatContextPercent(stats.contextPercent)}%` : "?";
	const color = hasPercent && stats.contextPercent! >= 70 ? style.amber : style.lilac;
	const windowText = expanded && stats.contextWindow ? `/${formatNum(stats.contextWindow)}` : "";
	return `${color}ctx ${percent}${windowText}`;
}

function costText(stats: FooterStats, style: FooterStyle): string {
	const suffix = stats.usingSubscription ? " (sub)" : "";
	return `${style.mint}${formatCost(stats.cost)}${suffix}`;
}

function usageCompact(stats: FooterStats, style: FooterStyle): string {
	return visibleJoin([
		`${style.sky}↑${formatNum(stats.inputTokens)}`,
		`${style.sky}↓${formatNum(stats.outputTokens)}`,
		`${style.lilac}R${formatNum(stats.cacheReadTokens)}`,
		`${style.lilac}W${formatNum(stats.cacheWriteTokens)}`,
	], " ");
}

function usageExpanded(stats: FooterStats, style: FooterStyle): string {
	return visibleJoin([
		`${style.sky}↑ input ${formatNum(stats.inputTokens)}`,
		`${style.sky}↓ output ${formatNum(stats.outputTokens)}`,
		`${style.lilac}R cache ${formatNum(stats.cacheReadTokens)}`,
		`${style.lilac}W cache ${formatNum(stats.cacheWriteTokens)}`,
		`${style.text}total ${formatNum(stats.inputTokens + stats.outputTokens)}`,
		costText(stats, style),
		contextText(stats, style, true),
	], `${style.muted} · `);
}

function renderSimpleFooter(width: number, state: FooterRenderState, stats: FooterStats, style: FooterStyle): string[] {
	const identity = `${style.text}▸ ${fitToWidth(state.cwdShort, FOOTER_LAYOUT.cwdMaxWidth)}${state.branch ? `${style.mint}@${fitToWidth(state.branch, FOOTER_LAYOUT.branchMaxWidth)}` : ""}`;
	const left = visibleJoin([
		identity,
		`${style.sky}${state.modelShort}`,
		`${style.amber}${state.thinking}`,
		stateText(state, style),
		state.pending ? `${style.amber}queued` : undefined,
	], `${style.muted} · `);
	const right = visibleJoin([
		usageCompact(stats, style),
		contextText(stats, style),
		stats.cost > 0 || stats.usingSubscription ? costText(stats, style) : undefined,
	], `${style.muted} · `);
	return [fitAligned(left, right, width)];
}

function providerModelText(state: FooterRenderState, style: FooterStyle): string {
	const providerPrefix = state.provider && (state.providerCount > 1 || state.provider)
		? `${state.provider}/`
		: "";
	return `${style.sky}model ${fitToWidth(`${providerPrefix}${state.modelId ?? "no model"}`, EXPANDED_MODEL_MAX_WIDTH)}`;
}

function toolsText(state: FooterRenderState, style: FooterStyle): string | undefined {
	if (state.activeTools.length === 0 && state.allToolCount === 0) return undefined;
	if (state.activeTools.length > 0 && state.activeTools.length <= 6) {
		return `${style.text}tools ${state.activeTools.join(",")}`;
	}
	return `${style.text}tools ${state.activeTools.length}/${state.allToolCount || state.activeTools.length}`;
}

function statusesText(state: FooterRenderState, style: FooterStyle): string | undefined {
	if (state.extensionStatuses.length === 0) return undefined;
	if (state.extensionStatuses.length === 1) return `${style.muted}status ${fitToWidth(state.extensionStatuses[0]!, STATUS_MAX_WIDTH)}`;
	return `${style.muted}status ${state.extensionStatuses.length}`;
}

function renderExpandedFooter(width: number, state: FooterRenderState, stats: FooterStats, style: FooterStyle): string[] {
	const row1Left = visibleJoin([
		`${style.text}▾ pi`,
		`${style.muted}cwd ${style.text}${fitToWidth(state.cwd, Math.max(FOOTER_LAYOUT.cwdMaxWidth, 36))}`,
		state.branch ? `${style.mint}branch ${fitToWidth(state.branch, FOOTER_LAYOUT.branchMaxWidth)}` : undefined,
		state.sessionName ? `${style.muted}session ${style.text}${fitToWidth(state.sessionName, SESSION_MAX_WIDTH)}` : undefined,
		stateText(state, style),
		state.pending ? `${style.amber}queued` : undefined,
	], `${style.muted} · `);
	const row1Right = contextText(stats, style, true);

	const row2Left = visibleJoin([
		providerModelText(state, style),
		`${style.amber}thinking ${state.thinking}`,
		toolsText(state, style),
	], `${style.muted} · `);
	const row2Right = statusesText(state, style) ?? "";

	return [
		fitAligned(row1Left, row1Right, width),
		fitAligned(`  ${row2Left}`, row2Right, width),
		footerLine(`  ${style.muted}usage ${usageExpanded(stats, style)}`, width),
	];
}

export function renderFooter(
	width: number,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	footerData: any,
	stats: FooterStats = collectFooterStats(ctx),
	style: FooterStyle = TALL_GRAY_FOOTER_STYLE,
): string[] {
	const state = renderState(ctx, pi, footerData);
	const contentWidth = footerContentWidth(width);
	const rows = state.expanded
		? renderExpandedFooter(contentWidth, state, stats, style)
		: renderSimpleFooter(contentWidth, state, stats, style);
	return addFooterLeftGap(rows, width);
}

function renderSignature(width: number, ctx: ExtensionContext, pi: ExtensionAPI, footerData: any, stats: FooterStats): string {
	const state = renderState(ctx, pi, footerData);
	return JSON.stringify({
		width,
		state,
		stats,
	});
}

export function createTallGrayFooter(ctx: ExtensionContext, pi: ExtensionAPI) {
	return (tui: any, _theme: any, footerData: any) => {
		let statsCache: FooterStats | undefined;
		let renderCache: { signature: string; rows: string[] } | undefined;
		const invalidateStats = () => {
			statsCache = undefined;
			renderCache = undefined;
		};
		const invalidateRender = () => {
			renderCache = undefined;
		};
		const unsubscribe = footerData.onBranchChange?.(() => {
			invalidateStats();
			tui.requestRender();
		});
		return {
			dispose() {
				unsubscribe?.();
			},
			invalidate() {
				invalidateStats();
			},
			render(width: number): string[] {
				statsCache ??= collectFooterStats(ctx);
				const signature = renderSignature(width, ctx, pi, footerData, statsCache);
				if (renderCache?.signature === signature) return renderCache.rows;
				const rows = renderFooter(width, ctx, pi, footerData, statsCache);
				renderCache = { signature, rows };
				return rows;
			},
			handleFooterToggle() {
				invalidateRender();
				tui.requestRender?.();
			},
		};
	};
}
