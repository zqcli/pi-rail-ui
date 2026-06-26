import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatCost,
	formatNum,
	type FooterLiveState,
	type RailSessionSnapshot,
	type RailSessionStats,
} from "./footer-session-snapshot";

const MODAL_LABEL_WIDTH = 12;

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

export function renderRailSessionContent(snapshot: RailSessionSnapshot, theme: Theme, width: number): string[] {
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
