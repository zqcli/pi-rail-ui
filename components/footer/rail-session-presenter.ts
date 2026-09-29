import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	formatCost,
	formatNum,
	type FooterLiveState,
	type RailSessionSnapshot,
	type RailSessionStats,
} from "./footer-session-snapshot";

const LABEL_WIDTH = 11;
/** At this content width the Now/Workspace and Usage sections sit side by side. */
const TWO_COLUMN_MIN_WIDTH = 110;
const COLUMN_GAP = 3;

function formatInteger(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function trimFixed(value: number, digits: number): string {
	return value.toFixed(digits).replace(/\.?0+$/u, "");
}

function formatTokenAmount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) return `${trimFixed(value / 1_000_000, 2)}M`;
	if (value < 1000) return String(Math.round(value));
	return `${trimFixed(value / 1000, 1)}K`;
}

function formatCachePercent(tokens: RailSessionStats["tokens"]): string {
	const cacheRead = Math.max(0, tokens.cacheRead);
	const totalInput = cacheRead + Math.max(0, tokens.input);
	if (totalInput <= 0) return "0%";
	return `${trimFixed((cacheRead / totalInput) * 100, 1)}%`;
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…", true);
}

function pad(text: string, width: number): string {
	const fitted = fit(text, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function section(theme: Theme, label: string, detail?: string): string {
	return `${theme.fg("accent", theme.bold(label))}${detail ? theme.fg("dim", `  ${detail}`) : ""}`;
}

function field(theme: Theme, label: string, value: string, width: number): string {
	return fit(`  ${theme.fg("dim", pad(label, LABEL_WIDTH))} ${value}`, width);
}

/** A labelled value that wraps onto aligned continuation lines instead of being cut off. */
function wrappedField(theme: Theme, label: string, value: string, width: number): string[] {
	const indent = 2 + LABEL_WIDTH + 1;
	const lines = wrapTextWithAnsi(value, Math.max(8, width - indent));
	return lines.map((line, index) => index === 0 ? field(theme, label, line, width) : fit(`${" ".repeat(indent)}${line}`, width));
}

function metricRow(theme: Theme, cells: Array<[string, string]>, width: number): string[] {
	const body = Math.max(1, width - 2);
	// Too narrow for side-by-side cells: one metric per line.
	if (cells.length > 1 && body / cells.length < 24) return cells.flatMap((cell) => metricRow(theme, [cell], width));
	const cellWidth = Math.max(2, Math.floor(body / cells.length));
	// Labels shrink before values on narrow panels; one column always separates the cells.
	const labelWidth = Math.max(4, Math.min(11, cellWidth - 10));
	const text = cells.map(([label, value]) => `${pad(`${theme.fg("dim", pad(label, labelWidth))} ${theme.fg("text", value)}`, cellWidth - 1)} `).join("");
	return [fit(`  ${text}`, width)];
}

function contextRow(theme: Theme, state: FooterLiveState, width: number): string {
	const percent = typeof state.contextPercent === "number" && Number.isFinite(state.contextPercent) ? Math.max(0, Math.min(100, state.contextPercent)) : undefined;
	const tokens = typeof state.contextTokens === "number" && Number.isFinite(state.contextTokens) ? state.contextTokens : undefined;
	const window = typeof state.contextWindow === "number" && Number.isFinite(state.contextWindow) ? state.contextWindow : undefined;
	const color = percent !== undefined && percent >= 70 ? "warning" : "success";
	const parts: string[] = [];
	if (percent !== undefined) {
		const cells = 16;
		const filled = Math.round((percent / 100) * cells);
		parts.push(`${theme.fg(color === "warning" ? "warning" : "accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(cells - filled))}`);
		parts.push(theme.fg(color, `${percent.toFixed(1)}%`));
	}
	if (tokens !== undefined) parts.push(`${theme.fg("text", formatNum(tokens))}${window !== undefined ? theme.fg("dim", ` / ${formatNum(window)}`) : ""}`);
	else if (window !== undefined) parts.push(theme.fg("dim", `window ${formatNum(window)}`));
	return field(theme, "Context", parts.length ? parts.join(" ") : theme.fg("dim", "unknown"), width);
}

/** `KA 50|45` plus the detail without repeating the interval, e.g. `WAIT (next 19:32:10)` or the pause reason. */
function keepAliveRows(theme: Theme, snapshot: RailSessionSnapshot, width: number): string[] {
	if (!snapshot.keepAlive) return [];
	const detail = snapshot.keepAlive.replace(/^KA \d+m /u, "").replace(/^PAUSED \((.*)\)$/u, "paused: $1");
	const paused = snapshot.keepAlive.includes(" PAUSED");
	const label = snapshot.keepAliveLabel ?? snapshot.keepAlive.split(" ").slice(0, 2).join(" ");
	return wrappedField(theme, "Keep-alive",
		`${theme.fg(paused ? "error" : "warning", label)}${theme.fg("dim", ` · ${detail} · fees unknown`)}`, width);
}

function nowSection(theme: Theme, snapshot: RailSessionSnapshot, width: number): string[] {
	const { state } = snapshot;
	const model = `${state.provider ? `${state.provider}/` : ""}${state.modelId ?? "no model"}`;
	const rows = [
		section(theme, "Now", state.idle ? "idle" : "running"),
		...wrappedField(theme, "Model", `${theme.fg("text", model)}${theme.fg("dim", ` · thinking ${state.thinking}`)}`, width),
		contextRow(theme, state, width),
	];
	rows.push(...keepAliveRows(theme, snapshot, width));
	if (state.pending) rows.push(field(theme, "Queue", theme.fg("warning", "pending messages"), width));
	return rows;
}

function usageSection(theme: Theme, session: RailSessionStats, state: FooterLiveState, width: number): string[] {
	const cost = `${formatCost(session.cost)}${state.usingSubscription ? " (sub)" : ""}`;
	return [
		section(theme, "Usage", `${formatInteger(session.totalMessages)} message${session.totalMessages === 1 ? "" : "s"}`),
		...metricRow(theme, [["User", formatInteger(session.userMessages)], ["Input", formatTokenAmount(session.tokens.input)]], width),
		...metricRow(theme, [["Assistant", formatInteger(session.assistantMessages)], ["Output", formatTokenAmount(session.tokens.output)]], width),
		...metricRow(theme, [["Tool calls", formatInteger(session.toolCalls)], ["Cache hit", formatCachePercent(session.tokens)]], width),
		...metricRow(theme, [["Results", formatInteger(session.toolResults)], ["Cache R/W", `${formatTokenAmount(session.tokens.cacheRead)}/${formatTokenAmount(session.tokens.cacheWrite)}`]], width),
		...metricRow(theme, [["Cost", cost], ["Total", formatTokenAmount(session.tokens.total)]], width),
	];
}

function workspaceSection(theme: Theme, snapshot: RailSessionSnapshot, width: number): string[] {
	const { state, session } = snapshot;
	const rows = [section(theme, "Workspace")];
	rows.push(...wrappedField(theme, "Directory", `${theme.fg("text", state.cwd)}${state.branch ? theme.fg("dim", ` · ${state.branch}`) : ""}`, width));
	rows.push(field(theme, "Session ID", theme.fg("text", session.sessionId), width));
	// The file path is the longest value; keep all of it visible so it can be copied.
	rows.push(...wrappedField(theme, "File", theme.fg("text", session.sessionFile ?? "in-memory"), width));
	return rows;
}

function toolsSection(theme: Theme, state: FooterLiveState, width: number): string[] {
	if (state.activeTools.length === 0 && state.allToolCount === 0) return [];
	const total = Math.max(state.allToolCount, state.activeTools.length);
	const header = section(theme, "Tools", `${state.activeTools.length}/${total} active`);
	if (state.activeTools.length === 0) return [header, field(theme, "", theme.fg("dim", "none active"), width)];
	return [header, ...wrapTextWithAnsi(theme.fg("text", state.activeTools.join("  ")), Math.max(8, width - 2)).map((line) => fit(`  ${line}`, width))];
}

function extensionsSection(theme: Theme, state: FooterLiveState, width: number): string[] {
	if (state.extensionStatuses.length === 0) return [];
	return [section(theme, "Extensions"), ...state.extensionStatuses.flatMap((status) =>
		wrapTextWithAnsi(theme.fg("text", status), Math.max(8, width - 4))
			.map((line, index) => fit(`  ${index === 0 ? theme.fg("dim", "•") : " "} ${line}`, width)))];
}

function sideBySide(left: string[], right: string[], leftWidth: number, width: number): string[] {
	const rows = Math.max(left.length, right.length);
	return Array.from({ length: rows }, (_, index) =>
		fit(`${pad(left[index] ?? "", leftWidth)}${" ".repeat(COLUMN_GAP)}${right[index] ?? ""}`, width));
}

/**
 * Full panel content, most-watched facts first. It is not cut to a height: the overlay scrolls, so
 * tools and extension statuses stay reachable however many rows keep-alive or a long path adds.
 */
export function renderRailSessionContent(snapshot: RailSessionSnapshot, theme: Theme, width: number): string[] {
	const { state, session } = snapshot;
	const title = `${theme.fg("accent", theme.bold("Rail Session"))}${state.sessionName ? theme.fg("text", `  ${state.sessionName}`) : ""}`;
	const rows = [fit(`${title}${theme.fg("dim", `  · ${snapshot.capturedAt.toLocaleTimeString()}`)}`, width), ""];
	if (width >= TWO_COLUMN_MIN_WIDTH) {
		const leftWidth = Math.floor((width - COLUMN_GAP) / 2);
		const rightWidth = width - COLUMN_GAP - leftWidth;
		rows.push(...sideBySide(nowSection(theme, snapshot, leftWidth), usageSection(theme, session, state, rightWidth), leftWidth, width));
		rows.push("", ...workspaceSection(theme, snapshot, width));
	} else {
		rows.push(...nowSection(theme, snapshot, width), "", ...usageSection(theme, session, state, width), "", ...workspaceSection(theme, snapshot, width));
	}
	for (const block of [toolsSection(theme, state, width), extensionsSection(theme, state, width)]) {
		if (block.length) rows.push("", ...block);
	}
	return rows;
}
