import { TUI } from "@earendil-works/pi-tui";
import { CONVERSATION_SCROLL_LAYOUT, CONVERSATION_SCROLLBAR_STYLE, TALL_GRAY_EDITOR_STYLE } from "../config";
import { restorePrototypePatches } from "../patching";
import { applyColumnHighlight, clamp, padToWidth } from "../utils";
import { getRenderedSections, isInteractiveRoot } from "./history-renderer";
import { handleConversationInput, selectionRange } from "./interactions";
import {
	getConversationScrollStore,
	stateFor,
	type ConversationScrollStore,
	type ScrollbarMetrics,
	type TuiCtor,
} from "./state";

async function resolveNativeTuiExport<T>(exportName: string): Promise<T | undefined> {
	try {
		const packageUrl = import.meta.resolve("@earendil-works/pi-tui");
		const nativeModule = (await import(packageUrl)) as Record<string, T | undefined>;
		return nativeModule[exportName];
	} catch {
		return undefined;
	}
}

function getScrollbarMetrics(visibleRows: number, totalRows: number, start: number, width: number): ScrollbarMetrics | undefined {
	if (!CONVERSATION_SCROLLBAR_STYLE.visible) return undefined;
	const barWidth = CONVERSATION_SCROLLBAR_STYLE.width;
	if (width <= barWidth || totalRows <= visibleRows || visibleRows <= 0) return undefined;

	const thumbSize = Math.max(1, Math.floor((visibleRows * visibleRows) / totalRows));
	const maxThumbStart = Math.max(0, visibleRows - thumbSize);
	const maxScrollStart = Math.max(1, totalRows - visibleRows);
	const thumbStart = Math.round((start / maxScrollStart) * maxThumbStart);
	const fill = " ".repeat(barWidth);
	return {
		width: barWidth,
		thumbSize,
		thumbStart,
		maxThumbStart,
		maxScrollStart,
		xStart: width - barWidth + 1,
		xEnd: width,
		thumbBar: `${CONVERSATION_SCROLLBAR_STYLE.thumbBackground}${fill}${CONVERSATION_SCROLLBAR_STYLE.reset}`,
		trackBar: `${CONVERSATION_SCROLLBAR_STYLE.trackBackground}${fill}${CONVERSATION_SCROLLBAR_STYLE.reset}`,
	};
}

function renderScrollbar(line: string, rowIndex: number, metrics: ScrollbarMetrics | undefined, width: number): string {
	if (!metrics) return line;

	const isThumb = rowIndex >= metrics.thumbStart && rowIndex < metrics.thumbStart + metrics.thumbSize;
	return `${padToWidth(line, width - metrics.width)}${isThumb ? metrics.thumbBar : metrics.trackBar}`;
}

function highlightHistoryLine(
	line: string,
	lineIndex: number,
	range: { start: { line: number; col: number }; end: { line: number; col: number } } | undefined,
	width: number,
): string {
	if (!range || lineIndex < range.start.line || lineIndex > range.end.line) return line;

	const startCol = lineIndex === range.start.line ? range.start.col : 0;
	const endCol = lineIndex === range.end.line ? range.end.col : width;
	return applyColumnHighlight(line, startCol, endCol, TALL_GRAY_EDITOR_STYLE.selection, TALL_GRAY_EDITOR_STYLE.reset);
}

function renderStickyConversation(tui: any, width: number, originalRender: (width: number) => string[], store: ConversationScrollStore): string[] {
	if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(tui)) return originalRender.call(tui, width);

	try {
		const children = tui.children as any[];
		const state = stateFor(tui, store);
		const sections = getRenderedSections(children, width, state);
		const { historyLines, pendingLines, statusLines, aboveLines, editorLines, belowLines, footerLines } = sections;
		const fixedLines = [...pendingLines, ...statusLines, ...aboveLines, ...editorLines, ...belowLines, ...footerLines];
		const terminalRows = Math.max(1, tui.terminal?.rows ?? 24);
		const historyRows = Math.max(1, terminalRows - fixedLines.length);
		const editorTopRow = historyRows + pendingLines.length + statusLines.length + aboveLines.length;
		const editorBottomRow = editorTopRow + editorLines.length;
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
		state.view = { start, rows: historyRows, lineCount: historyLines.length, width, editorTopRow, editorBottomRow, scrollbar };
		const selection = selectionRange(state.selection);
		const historyWithScrollbar: string[] = [];
		for (let index = 0; index < historyRows; index++) {
			const lineIndex = start + index;
			const line = historyLines[lineIndex] ?? "";
			historyWithScrollbar.push(renderScrollbar(highlightHistoryLine(line, lineIndex, selection, width), index, scrollbar, width));
		}
		return [...historyWithScrollbar, ...fixedLines];
	} catch {
		return originalRender.call(tui, width);
	}
}

function patchTui(ctor: TuiCtor | undefined, store: ConversationScrollStore): void {
	if (!ctor?.prototype) return;

	if (!store.targets.some((target) => target.ctor === ctor && target.methodName === "render")) {
		const originalRender = ctor.prototype.render;
		ctor.prototype.render = function patchedConversationScrollRender(width: number): string[] {
			return renderStickyConversation(this, width, originalRender, store);
		};
		store.targets.push({ ctor, methodName: "render", original: originalRender });
	}

	if (!store.targets.some((target) => target.ctor === ctor && target.methodName === "handleInput")) {
		const originalHandleInput = ctor.prototype.handleInput;
		ctor.prototype.handleInput = function patchedConversationScrollInput(data: string): void {
			return handleConversationInput(this, data, originalHandleInput, store);
		};
		store.targets.push({ ctor, methodName: "handleInput", original: originalHandleInput });
	}
}

export async function installConversationScroll(): Promise<void> {
	if (!CONVERSATION_SCROLL_LAYOUT.enabled) return;
	const store = getConversationScrollStore();
	patchTui(TUI as unknown as TuiCtor, store);
	patchTui(await resolveNativeTuiExport<TuiCtor>("TUI"), store);
}

export function uninstallConversationScroll(): void {
	const store = getConversationScrollStore();
	restorePrototypePatches(store.targets);
	for (const timer of store.animationTimers) clearTimeout(timer);
	store.animationTimers.clear();
	store.states = new WeakMap<object, any>();
}
