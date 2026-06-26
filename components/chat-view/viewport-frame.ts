import { CONVERSATION_SCROLLBAR_STYLE, FOOTER_LAYOUT, RAIL_EDITOR_STYLE } from "../../config";
import { clamp } from "../../core/utils";
import { addGlobalLeftGutterToRows, composeHistoryRows } from "./viewport-compose";
import { selectionRange, type RenderCache, type ScrollState, type ScrollbarMetrics } from "./state";

const MAX_SCROLLBAR_THUMB_RATIO = 0.65;
const MIN_SCROLLBAR_HITBOX_WIDTH = 2;
const SCROLLBAR_THUMB_GLYPH = "█";

export type ConversationViewportFrameInput = {
	sections: RenderCache;
	state: ScrollState;
	width: number;
	terminalRows: number;
	leftGutterWidth: number;
};

export type ConversationViewportFrame = {
	rows: string[];
	shouldClearViewportMemory: boolean;
	historyOverflow: boolean;
};

function fixedViewportLayoutSignature(parts: {
	leftGutterWidth: number;
	historyRows: number;
	pendingRows: number;
	statusRows: number;
	aboveRows: number;
	editorRows: number;
	belowRows: number;
	footerRows: number;
	footerBottomGapRows: number;
}): string {
	return [
		parts.leftGutterWidth,
		parts.historyRows,
		parts.pendingRows,
		parts.statusRows,
		parts.aboveRows,
		parts.editorRows,
		parts.belowRows,
		parts.footerRows,
		parts.footerBottomGapRows,
	].join("\u001f");
}

function foregroundFromBackgroundAnsi(ansi: string): string {
	return ansi.replace(/\x1b\[48([;:])/g, "\x1b[38$1");
}

function getScrollbarMetrics(visibleRows: number, totalRows: number, start: number, width: number): ScrollbarMetrics | undefined {
	if (!CONVERSATION_SCROLLBAR_STYLE.visible) return undefined;
	const barWidth = CONVERSATION_SCROLLBAR_STYLE.width;
	if (width <= barWidth || totalRows <= visibleRows || visibleRows <= 0) return undefined;

	const rawThumbSize = Math.max(1, Math.floor((visibleRows * visibleRows) / totalRows));
	const maxVisibleThumbSize = Math.max(1, Math.floor(visibleRows * MAX_SCROLLBAR_THUMB_RATIO));
	const thumbSize = Math.min(rawThumbSize, maxVisibleThumbSize);
	const maxThumbStart = Math.max(0, visibleRows - thumbSize);
	const maxScrollStart = Math.max(1, totalRows - visibleRows);
	const thumbStart = Math.round((start / maxScrollStart) * maxThumbStart);
	const hitboxWidth = Math.max(barWidth, MIN_SCROLLBAR_HITBOX_WIDTH);
	const fill = " ".repeat(barWidth);
	const thumb = SCROLLBAR_THUMB_GLYPH.repeat(barWidth);
	const thumbColor = foregroundFromBackgroundAnsi(CONVERSATION_SCROLLBAR_STYLE.thumbBackground) || RAIL_EDITOR_STYLE.rail;
	return {
		width: barWidth,
		thumbSize,
		thumbStart,
		maxThumbStart,
		maxScrollStart,
		xStart: Math.max(1, width - hitboxWidth + 1),
		xEnd: width,
		thumbBar: `${thumbColor}${thumb}${CONVERSATION_SCROLLBAR_STYLE.reset}`,
		trackBar: `${CONVERSATION_SCROLLBAR_STYLE.trackBackground}${fill}${CONVERSATION_SCROLLBAR_STYLE.reset}`,
	};
}

function fitToTerminalRows(lines: string[], terminalRows: number): string[] {
	return lines.length > terminalRows ? lines.slice(lines.length - terminalRows) : lines;
}

export function composeConversationViewportFrame(input: ConversationViewportFrameInput): ConversationViewportFrame {
	const { sections, state, width, terminalRows, leftGutterWidth } = input;
	const contentWidth = Math.max(1, width - leftGutterWidth);
	const { historyLines, historyRevision, pendingLines, statusLines, aboveLines, editorLines, belowLines, footerLines } = sections;
	const footerBottomGapLines = Array.from({ length: FOOTER_LAYOUT.bottomGapRows }, () => "");
	const fixedLines = addGlobalLeftGutterToRows([
		...pendingLines,
		...statusLines,
		...aboveLines,
		...editorLines,
		...belowLines,
		...footerLines,
		...footerBottomGapLines,
	], width, leftGutterWidth);
	const historyRows = Math.max(1, terminalRows - fixedLines.length);
	const editorTopRow = historyRows + pendingLines.length + statusLines.length + aboveLines.length;
	const editorBottomRow = editorTopRow + editorLines.length;
	const footerTopRow = editorBottomRow + belowLines.length;
	const footerBottomRow = footerTopRow + footerLines.length;
	const layoutSignature = fixedViewportLayoutSignature({
		leftGutterWidth,
		historyRows,
		pendingRows: pendingLines.length,
		statusRows: statusLines.length,
		aboveRows: aboveLines.length,
		editorRows: editorLines.length,
		belowRows: belowLines.length,
		footerRows: footerLines.length,
		footerBottomGapRows: FOOTER_LAYOUT.bottomGapRows,
	});
	const fixedLayoutChanged = state.viewportLayoutSignature !== undefined && state.viewportLayoutSignature !== layoutSignature;
	state.viewportLayoutSignature = layoutSignature;

	const maxStart = Math.max(0, historyLines.length - historyRows);
	let start: number;
	if (state.lockedStart !== undefined) {
		start = clamp(Math.round(state.lockedStart), 0, maxStart);
		state.offsetFromBottom = maxStart - start;
	} else {
		state.offsetFromBottom = clamp(state.offsetFromBottom, 0, maxStart);
		start = maxStart - state.offsetFromBottom;
	}

	const scrollbar = getScrollbarMetrics(historyRows, historyLines.length, start, width);
	state.view = { start, rows: historyRows, lineCount: historyLines.length, width: contentWidth, leftGutterWidth, editorTopRow, editorBottomRow, footerTopRow, footerBottomRow, scrollbar };
	const selection = selectionRange(state.selection);
	const scrollbarSig = scrollbar ? `${scrollbar.width}:${scrollbar.thumbStart}:${scrollbar.thumbSize}` : "none";
	const selSig = selection ? `${selection.start.line}:${selection.start.col}:${selection.end.line}:${selection.end.col}` : "nosel";
	const rowsSignature = `${historyRevision}\u001f${start}\u001f${historyRows}\u001f${width}\u001f${leftGutterWidth}\u001f${contentWidth}\u001f${scrollbarSig}\u001f${selSig}`;
	const memo = state.viewportRowsCache;
	let historyWithScrollbar: string[];
	if (memo && memo.historyLinesRef === historyLines && memo.signature === rowsSignature) {
		historyWithScrollbar = memo.rows;
	} else {
		historyWithScrollbar = composeHistoryRows(historyLines, start, historyRows, width, leftGutterWidth, contentWidth, scrollbar, selection);
		state.viewportRowsCache = { historyLinesRef: historyLines, signature: rowsSignature, rows: historyWithScrollbar };
	}

	const historyOverflow = historyLines.length > historyRows;
	return {
		rows: fitToTerminalRows([...historyWithScrollbar, ...fixedLines], terminalRows),
		shouldClearViewportMemory: fixedLayoutChanged && historyOverflow,
		historyOverflow,
	};
}
