import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { FOOTER_LAYOUT, TALL_GRAY_FOOTER_STYLE, type FooterStyle } from "../config";
import { fitToWidth } from "../utils";

export type FooterStats = {
	totalTokens: number;
	cost: number;
	contextPercent?: number;
};

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

function formatContextPercent(value: number): string {
	return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function shortModelName(model?: string): string {
	if (!model) return "no model";
	return fitToWidth(
		model
			.replace(/^claude-/, "claude ")
			.replace(/-20\d{6}$/u, "")
			.replace(/-latest$/u, "")
			.replace(/-preview$/u, ""),
		FOOTER_LAYOUT.modelMaxWidth,
	);
}

function footerLine(content: string, width: number): string {
	return truncateToWidth(content, Math.max(0, width), "…", true);
}

export function collectFooterStats(ctx: ExtensionContext): FooterStats {
	let inputTokens = 0;
	let outputTokens = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const usage = (entry as any).message?.usage;
		inputTokens += usage?.input ?? 0;
		outputTokens += usage?.output ?? 0;
		cost += usage?.cost?.total ?? 0;
	}

	const contextUsage = ctx.getContextUsage();
	const totalTokens = contextUsage?.tokens ?? inputTokens + outputTokens;
	return { totalTokens, cost, contextPercent: contextUsage?.percent };
}

export function renderFooter(
	width: number,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	footerData: any,
	stats: FooterStats = collectFooterStats(ctx),
	style: FooterStyle = TALL_GRAY_FOOTER_STYLE,
): string[] {
	const cwd = path.basename(ctx.cwd) || ctx.cwd;
	const branch = footerData.getGitBranch?.();
	const state = ctx.isIdle() ? `${style.mint}● ready` : `${style.amber}● working`;
	const thinking = pi.getThinkingLevel();

	const left = [
		`${style.text}  pi`,
		`${style.muted}${fitToWidth(cwd, FOOTER_LAYOUT.cwdMaxWidth)}`,
		`${style.sky}${shortModelName(ctx.model?.id)}`,
		`${style.amber}${thinking}`,
		branch ? `${style.mint}git:${fitToWidth(branch, FOOTER_LAYOUT.branchMaxWidth)}` : undefined,
		state,
	]
		.filter(Boolean)
		.join(`${style.muted} · `);

	const right = [
		stats.contextPercent !== undefined ? `${style.lilac}${formatContextPercent(stats.contextPercent)}% ctx` : undefined,
		`${style.sky}${formatNum(stats.totalTokens)} tok`,
		`${style.mint}${formatCost(stats.cost)}`,
	]
		.filter(Boolean)
		.join(`${style.muted} · `);

	const rightWidth = visibleWidth(right);
	const fittedLeft = fitToWidth(left, Math.max(0, width - rightWidth - 1));
	const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
	return [footerLine(`${fittedLeft}${gap}${right}`, width)];
}

export function createTallGrayFooter(ctx: ExtensionContext, pi: ExtensionAPI) {
	return (tui: any, _theme: any, footerData: any) => {
		let statsCache: FooterStats | undefined;
		const invalidateStats = () => {
			statsCache = undefined;
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
				return renderFooter(width, ctx, pi, footerData, statsCache);
			},
		};
	};
}
