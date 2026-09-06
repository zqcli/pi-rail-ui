import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { FOOTER_LAYOUT } from "../../config";
import { fitToWidth } from "../../core/utils";

export type FooterUsageStats = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
};

export type RailSessionStats = {
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

export type RailSessionSnapshot = {
	state: FooterLiveState;
	session: RailSessionStats;
	capturedAt: Date;
};

const SIMPLE_MODEL_MAX_WIDTH = Math.max(12, FOOTER_LAYOUT.modelMaxWidth);

export function formatNum(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

export function footerUsageEntries(ctx: ExtensionContext): any[] {
	return ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
}

function applyEntryUsage(totals: FooterUsageStats, usage: any): void {
	if (!usage || typeof usage !== "object") return;
	totals.inputTokens += usage.input ?? 0;
	totals.outputTokens += usage.output ?? 0;
	totals.cacheReadTokens += usage.cacheRead ?? 0;
	totals.cacheWriteTokens += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

export function usageStatsFromEntries(entries: any[]): FooterUsageStats {
	const totals: FooterUsageStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		// Compaction and branch summaries are LLM work too: Pi stores their
		// summary-generation usage on the entry itself (not on a message), and
		// session docs include it in token and cost totals.
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			applyEntryUsage(totals, entry.usage);
			continue;
		}
		if (entry.type !== "message") continue;
		applyEntryUsage(totals, entry.message?.usage);
	}

	return totals;
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

export function collectFooterLiveState(ctx: ExtensionContext, pi: ExtensionAPI, footerData?: ReadonlyFooterDataProvider, options: { details?: boolean } = {}): FooterLiveState {
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

export function collectRailSessionSnapshot(ctx: ExtensionContext, pi: ExtensionAPI, footerData?: ReadonlyFooterDataProvider): RailSessionSnapshot {
	const entries = footerUsageEntries(ctx);
	const stats = usageStatsFromEntries(entries);
	return {
		state: collectFooterLiveState(ctx, pi, footerData, { details: true }),
		session: sessionStatsFromEntries(ctx, entries, stats),
		capturedAt: new Date(),
	};
}
