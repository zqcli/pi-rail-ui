import { TUI } from "@earendil-works/pi-tui";
import { CONVERSATION_SCROLL_LAYOUT, CONVERSATION_SCROLLBAR_STYLE, CONVERSATION_SELECTION_STYLE, FOOTER_LAYOUT, RAIL_EDITOR_STYLE } from "../../config";
import { getInteractiveModeConstructors, restorePrototypePatches } from "../../core/patching";
import { applyColumnHighlight, clamp, padToWidth } from "../../core/utils";
import { getRenderedSections, isInteractiveRoot } from "./history-renderer";
import { handleConversationInput, selectionRange } from "./interactions";
import {
	getConversationScrollStore,
	stateFor,
	type ConversationScrollStore,
	type ScrollbarMetrics,
	type TuiCtor,
} from "./state";

type InteractiveModeCtor = { prototype: any };

const CLEAR_SCREEN_AND_SCROLLBACK = "\x1b[H\x1b[2J\x1b[3J";
// Keep wheel input in the alternate screen instead of letting the terminal
// scroll its native viewport, which would move the fixed editor/footer away.
const ENABLE_ALT_SCROLL_MODE = "\x1b[?1007h";
const DISABLE_ALT_SCROLL_MODE = "\x1b[?1007l";
const ENTER_ALT_SCREEN = `\x1b[?1049h${ENABLE_ALT_SCROLL_MODE}${CLEAR_SCREEN_AND_SCROLLBACK}`;
const EXIT_ALT_SCREEN = `${DISABLE_ALT_SCROLL_MODE}\x1b[?1049l`;
const MAX_SCROLLBAR_THUMB_RATIO = 0.65;
const MIN_SCROLLBAR_HITBOX_WIDTH = 2;
const SCROLLBAR_THUMB_GLYPH = "█";

function writeTerminalControl(sequence: string): void {
	if (process.stdout.isTTY) process.stdout.write(sequence);
}

function requestFullRenderAfterScreenClear(tui: any | undefined): void {
	if (typeof tui?.requestRender === "function") tui.requestRender(true);
}

function resetTuiRenderMemory(tui: any): void {
	if (!tui || typeof tui !== "object") return;
	tui.previousLines = [];
	tui.previousWidth = 0;
	tui.previousHeight = 0;
	tui.cursorRow = 0;
	tui.hardwareCursorRow = 0;
	tui.maxLinesRendered = 0;
	tui.previousViewportTop = 0;
	if (tui.previousKittyImageIds instanceof Set) tui.previousKittyImageIds.clear();
}

function clearBeforeOverflowRender(tui: any, store: ConversationScrollStore, hasOverflow: boolean): void {
	if (!hasOverflow || !store.clearOnNextOverflowRender) return;
	store.clearOnNextOverflowRender = false;
	writeTerminalControl(CLEAR_SCREEN_AND_SCROLLBACK);
	resetTuiRenderMemory(tui);
}

export function ensureConversationAlternateScreen(tui?: any): void {
	if (!CONVERSATION_SCROLL_LAYOUT.enabled || !CONVERSATION_SCROLL_LAYOUT.alternateScreen) return;
	const store = getConversationScrollStore();
	if (store.alternateScreenActive) return;
	writeTerminalControl(ENTER_ALT_SCREEN);
	store.alternateScreenActive = true;
	requestFullRenderAfterScreenClear(tui);
}

export function releaseConversationAlternateScreen(): void {
	const store = getConversationScrollStore();
	if (!store.alternateScreenActive) return;
	writeTerminalControl(EXIT_ALT_SCREEN);
	store.alternateScreenActive = false;
}

async function resolveNativeTuiExport<T>(exportName: string): Promise<T | undefined> {
	try {
		const packageUrl = import.meta.resolve("@earendil-works/pi-tui");
		const nativeModule = (await import(packageUrl)) as Record<string, T | undefined>;
		return nativeModule[exportName];
	} catch {
		return undefined;
	}
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
	// When startup resources overflow by only a few rows, a proportional thumb
	// covers most of the viewport. Clamp the thumb instead of hiding it so the
	// scrollbar remains visible and draggable during resume/startup frames.
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

function renderScrollbar(line: string, rowIndex: number, metrics: ScrollbarMetrics | undefined, width: number): string {
	if (!metrics) return line;

	const isThumb = rowIndex >= metrics.thumbStart && rowIndex < metrics.thumbStart + metrics.thumbSize;
	const content = padToWidth(`${line}${RAIL_EDITOR_STYLE.reset}`, width - metrics.width);
	return `${content}${isThumb ? metrics.thumbBar : metrics.trackBar}`;
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
	return applyColumnHighlight(line, startCol, endCol, CONVERSATION_SELECTION_STYLE, RAIL_EDITOR_STYLE.reset);
}

function fitToTerminalRows(lines: string[], terminalRows: number): string[] {
	return lines.length > terminalRows ? lines.slice(lines.length - terminalRows) : lines;
}

function renderStickyConversation(tui: any, width: number, originalRender: (width: number) => string[], store: ConversationScrollStore): string[] {
	if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(tui)) return originalRender.call(tui, width);

	try {
		const children = tui.children as any[];
		const state = stateFor(tui, store);
		const sections = getRenderedSections(children, width, state);
		const { historyLines, pendingLines, statusLines, aboveLines, editorLines, belowLines, footerLines } = sections;
		const footerBottomGapLines = Array.from({ length: FOOTER_LAYOUT.bottomGapRows }, () => "");
		const fixedLines = [...pendingLines, ...statusLines, ...aboveLines, ...editorLines, ...belowLines, ...footerLines, ...footerBottomGapLines];
		const terminalRows = Math.max(1, tui.terminal?.rows ?? 24);
		const historyRows = Math.max(1, terminalRows - fixedLines.length);
		const editorTopRow = historyRows + pendingLines.length + statusLines.length + aboveLines.length;
		const editorBottomRow = editorTopRow + editorLines.length;
		const footerTopRow = editorBottomRow + belowLines.length;
		const footerBottomRow = footerTopRow + footerLines.length;
		const maxStart = Math.max(0, historyLines.length - historyRows);
		let start: number;
		if (state.lockedStart !== undefined) {
			start = clamp(Math.round(state.lockedStart), 0, maxStart);
			state.offsetFromBottom = maxStart - start;
		} else {
			state.offsetFromBottom = clamp(state.offsetFromBottom, 0, maxStart);
			start = maxStart - state.offsetFromBottom;
		}

		clearBeforeOverflowRender(tui, store, historyLines.length > historyRows);
		const scrollbar = getScrollbarMetrics(historyRows, historyLines.length, start, width);
		state.view = { start, rows: historyRows, lineCount: historyLines.length, width, editorTopRow, editorBottomRow, footerTopRow, footerBottomRow, scrollbar };
		const selection = selectionRange(state.selection);
		const historyWithScrollbar: string[] = [];
		for (let index = 0; index < historyRows; index++) {
			const lineIndex = start + index;
			const line = historyLines[lineIndex] ?? "";
			historyWithScrollbar.push(renderScrollbar(highlightHistoryLine(line, lineIndex, selection, width), index, scrollbar, width));
		}
		return fitToTerminalRows([...historyWithScrollbar, ...fixedLines], terminalRows);
	} catch {
		const terminalRows = Math.max(1, tui.terminal?.rows ?? 24);
		return fitToTerminalRows(originalRender.call(tui, width), terminalRows);
	}
}

function patchInteractiveMode(ctor: InteractiveModeCtor | undefined, store: ConversationScrollStore): void {
	if (!ctor?.prototype || typeof ctor.prototype.renderInitialMessages !== "function") return;
	if (store.targets.some((target) => target.ctor === ctor && target.methodName === "renderInitialMessages")) return;

	const originalRenderInitialMessages = ctor.prototype.renderInitialMessages;
	ctor.prototype.renderInitialMessages = function patchedConversationInitialMessages(this: any, ...args: any[]) {
		const result = originalRenderInitialMessages.apply(this, args);
		const tui = this.ui;
		if (CONVERSATION_SCROLL_LAYOUT.enabled && isInteractiveRoot(tui)) {
			clearConversationScrollState(store, { clearOnNextOverflowRender: true });
			tui.requestRender?.(true);
		}
		return result;
	};
	store.targets.push({ ctor, methodName: "renderInitialMessages", original: originalRenderInitialMessages });
}

function patchTui(ctor: TuiCtor | undefined, store: ConversationScrollStore): void {
	if (!ctor?.prototype) return;

	if (!store.targets.some((target) => target.ctor === ctor && target.methodName === "start")) {
		const originalStart = ctor.prototype.start;
		ctor.prototype.start = function patchedConversationScrollStart(this: any, ...args: any[]) {
			const result = originalStart.apply(this, args);
			ensureConversationAlternateScreen(this);
			return result;
		};
		store.targets.push({ ctor, methodName: "start", original: originalStart });
	}

	if (!store.targets.some((target) => target.ctor === ctor && target.methodName === "stop")) {
		const originalStop = ctor.prototype.stop;
		ctor.prototype.stop = function patchedConversationScrollStop(this: any, ...args: any[]) {
			try {
				return originalStop.apply(this, args);
			} finally {
				releaseConversationAlternateScreen();
			}
		};
		store.targets.push({ ctor, methodName: "stop", original: originalStop });
	}

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
	for (const ctor of await getInteractiveModeConstructors()) patchInteractiveMode(ctor, store);
}

function clearConversationScrollState(store: ConversationScrollStore, options: { clearOnNextOverflowRender?: boolean } = {}): void {
	for (const timer of store.animationTimers) clearTimeout(timer);
	store.animationTimers.clear();
	store.states = new WeakMap<object, any>();
	store.clearOnNextOverflowRender = options.clearOnNextOverflowRender === true;
}

export function resetConversationScrollState(): void {
	clearConversationScrollState(getConversationScrollStore(), { clearOnNextOverflowRender: true });
}

export function uninstallConversationScroll(options: { releaseAlternateScreen?: boolean } = {}): void {
	const store = getConversationScrollStore();
	if (options.releaseAlternateScreen !== false) releaseConversationAlternateScreen();
	restorePrototypePatches(store.targets);
	clearConversationScrollState(store);
}
