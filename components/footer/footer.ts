import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { FOOTER_LAYOUT, RAIL_FOOTER_STYLE, type FooterStyle } from "../../config";
import { fitToWidth } from "../../core/utils";

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

type FooterStore = { expanded: boolean };

type FooterSnapshot = {
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
const SIMPLE_MODEL_MAX_WIDTH = Math.max(12, FOOTER_LAYOUT.modelMaxWidth);
const EXPANDED_MODEL_MAX_WIDTH = Math.max(28, FOOTER_LAYOUT.modelMaxWidth + 12);
const SESSION_MAX_WIDTH = 28;
const STATUS_MAX_WIDTH = 32;
const SIGNATURE_SEP = "\u001f";
const LIST_SEP = "\u001e";

function footerStore(): FooterStore {
	return ((globalThis as any)[FOOTER_STORE_KEY] ??= { expanded: false } satisfies FooterStore);
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

function stateText(state: FooterSnapshot, style: FooterStyle): string {
	return state.idle ? `${style.mint}● ready` : `${style.amber}● working`;
}

function contextText(stats: FooterStats, style: FooterStyle, expanded = false): string {
	const hasPercent = typeof stats.contextPercent === "number" && Number.isFinite(stats.contextPercent);
	const percent = hasPercent ? `${stats.contextPercent!.toFixed(2)}%` : "?";
	const color = hasPercent && stats.contextPercent! >= 70 ? style.amber : style.lilac;
	const windowText = expanded && stats.contextWindow ? `/${formatNum(stats.contextWindow)}` : "";
	return `${color}ctx ${percent}${windowText}`;
}

function costText(stats: FooterStats, style: FooterStyle): string {
	return `${style.mint}${formatCost(stats.cost)}${stats.usingSubscription ? " (sub)" : ""}`;
}

function usageText(stats: FooterStats, style: FooterStyle, expanded = false): string {
	return expanded
		? visibleJoin([
			`${style.sky}↑ input ${formatNum(stats.inputTokens)}`,
			`${style.sky}↓ output ${formatNum(stats.outputTokens)}`,
			`${style.lilac}R cache ${formatNum(stats.cacheReadTokens)}`,
			`${style.lilac}W cache ${formatNum(stats.cacheWriteTokens)}`,
			`${style.text}total ${formatNum(stats.inputTokens + stats.outputTokens)}`,
			costText(stats, style),
			contextText(stats, style, true),
		], `${style.muted} · `)
		: visibleJoin([
			`${style.sky}↑${formatNum(stats.inputTokens)}`,
			`${style.sky}↓${formatNum(stats.outputTokens)}`,
			`${style.lilac}R${formatNum(stats.cacheReadTokens)}`,
			`${style.lilac}W${formatNum(stats.cacheWriteTokens)}`,
		], " ");
}

export function collectFooterStats(ctx: ExtensionContext): FooterStats {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let cost = 0;

	const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
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

	const contextUsage = ctx.getContextUsage();
	const contextTokens = contextUsage?.tokens;
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
		totalTokens: typeof contextTokens === "number" ? contextTokens : inputTokens + outputTokens,
		cost,
		contextTokens,
		contextWindow: contextUsage?.contextWindow,
		contextPercent: contextUsage?.percent,
		usingSubscription,
	};
}

function collectFooterSnapshot(ctx: ExtensionContext, pi: ExtensionAPI, footerData: any): FooterSnapshot {
	const rawCwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const home = process.env.HOME || process.env.USERPROFILE;
	const statuses = footerData.getExtensionStatuses?.();
	let activeTools: string[] = [];
	let allToolCount = 0;
	let providerCount = 0;

	try {
		activeTools = [...(pi.getActiveTools?.() ?? [])];
		allToolCount = pi.getAllTools?.()?.length ?? 0;
	} catch {
		activeTools = [];
		allToolCount = 0;
	}
	try {
		providerCount = footerData.getAvailableProviderCount?.() ?? 0;
	} catch {
		providerCount = 0;
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

	return {
		cwd: home && rawCwd.startsWith(home) ? `~${rawCwd.slice(home.length)}` : rawCwd,
		cwdShort: path.basename(ctx.cwd) || ctx.cwd,
		branch: footerData.getGitBranch?.(),
		sessionName: ctx.sessionManager.getSessionName?.(),
		idle: ctx.isIdle(),
		pending: ctx.hasPendingMessages?.() === true,
		modelId,
		modelShort,
		provider: (ctx.model as any)?.provider,
		providerCount,
		thinking: pi.getThinkingLevel?.() ?? "off",
		activeTools,
		allToolCount,
		extensionStatuses: statuses && typeof statuses.entries === "function"
			? Array.from(statuses.entries())
				.sort(([a], [b]) => String(a).localeCompare(String(b)))
				.map(([, text]) => String(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
				.filter(Boolean)
			: [],
		expanded: isFooterExpanded(),
	};
}

function renderSimpleFooter(width: number, state: FooterSnapshot, stats: FooterStats, style: FooterStyle): string[] {
	const identity = `${style.text}▸ ${fitToWidth(state.cwdShort, FOOTER_LAYOUT.cwdMaxWidth)}${state.branch ? `${style.mint}@${fitToWidth(state.branch, FOOTER_LAYOUT.branchMaxWidth)}` : ""}`;
	const left = visibleJoin([
		identity,
		`${style.sky}${state.modelShort}`,
		`${style.amber}${state.thinking}`,
		stateText(state, style),
		state.pending ? `${style.amber}queued` : undefined,
	], `${style.muted} · `);
	const right = visibleJoin([
		usageText(stats, style),
		contextText(stats, style),
		stats.cost > 0 || stats.usingSubscription ? costText(stats, style) : undefined,
	], `${style.muted} · `);
	return [fitAligned(left, right, width)];
}

function renderExpandedFooter(width: number, state: FooterSnapshot, stats: FooterStats, style: FooterStyle): string[] {
	const row1Left = visibleJoin([
		`${style.text}▾ pi`,
		`${style.muted}cwd ${style.text}${fitToWidth(state.cwd, Math.max(FOOTER_LAYOUT.cwdMaxWidth, 36))}`,
		state.branch ? `${style.mint}branch ${fitToWidth(state.branch, FOOTER_LAYOUT.branchMaxWidth)}` : undefined,
		state.sessionName ? `${style.muted}session ${style.text}${fitToWidth(state.sessionName, SESSION_MAX_WIDTH)}` : undefined,
		stateText(state, style),
		state.pending ? `${style.amber}queued` : undefined,
	], `${style.muted} · `);
	const toolText = state.activeTools.length === 0 && state.allToolCount === 0
		? undefined
		: state.activeTools.length > 0 && state.activeTools.length <= 6
			? `${style.text}tools ${state.activeTools.join(",")}`
			: `${style.text}tools ${state.activeTools.length}/${state.allToolCount || state.activeTools.length}`;
	const statusText = state.extensionStatuses.length === 0
		? ""
		: state.extensionStatuses.length === 1
			? `${style.muted}status ${fitToWidth(state.extensionStatuses[0]!, STATUS_MAX_WIDTH)}`
			: `${style.muted}status ${state.extensionStatuses.length}`;
	const row2Left = visibleJoin([
		`${style.sky}model ${fitToWidth(`${state.provider ? `${state.provider}/` : ""}${state.modelId ?? "no model"}`, EXPANDED_MODEL_MAX_WIDTH)}`,
		`${style.amber}thinking ${state.thinking}`,
		toolText,
	], `${style.muted} · `);

	return [
		fitAligned(row1Left, contextText(stats, style, true), width),
		fitAligned(`  ${row2Left}`, statusText, width),
		footerLine(`  ${style.muted}usage ${usageText(stats, style, true)}`, width),
	];
}

function renderFooterRows(width: number, state: FooterSnapshot, stats: FooterStats, style: FooterStyle): string[] {
	return state.expanded
		? renderExpandedFooter(width, state, stats, style)
		: renderSimpleFooter(width, state, stats, style);
}

export function renderFooter(
	width: number,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	footerData: any,
	stats: FooterStats = collectFooterStats(ctx),
	style: FooterStyle = RAIL_FOOTER_STYLE,
): string[] {
	return renderFooterRows(width, collectFooterSnapshot(ctx, pi, footerData), stats, style);
}

function footerSignature(width: number, state: FooterSnapshot, stats: FooterStats): string {
	return [
		width,
		state.expanded ? 1 : 0,
		state.cwd,
		state.cwdShort,
		state.branch ?? "",
		state.sessionName ?? "",
		state.idle ? 1 : 0,
		state.pending ? 1 : 0,
		state.modelId ?? "",
		state.modelShort,
		state.provider ?? "",
		state.providerCount,
		state.thinking,
		state.allToolCount,
		state.activeTools.join(LIST_SEP),
		state.extensionStatuses.join(LIST_SEP),
		stats.inputTokens,
		stats.outputTokens,
		stats.cacheReadTokens,
		stats.cacheWriteTokens,
		stats.totalTokens,
		stats.cost,
		stats.contextTokens ?? "",
		stats.contextWindow ?? "",
		stats.contextPercent ?? "",
		stats.usingSubscription ? 1 : 0,
	].join(SIGNATURE_SEP);
}

export function createRailFooter(ctx: ExtensionContext, pi: ExtensionAPI) {
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
			invalidateRender();
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
				const state = collectFooterSnapshot(ctx, pi, footerData);
				const signature = footerSignature(width, state, statsCache);
				if (renderCache?.signature === signature) return renderCache.rows;
				const rows = renderFooterRows(width, state, statsCache, RAIL_FOOTER_STYLE);
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
