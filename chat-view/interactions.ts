import { TUI, visibleWidth } from "@earendil-works/pi-tui";
import { copyToClipboard } from "../clipboard";
import { CONVERSATION_SCROLL_LAYOUT, CONVERSATION_SCROLLBAR_STYLE } from "../config";
import {
	canToggleRailSection,
	normalizeRailSectionPosition,
	railSectionMoved,
	railSectionSelectionStartCol,
	sameRailSection,
	toggleRailSection,
	type RailSectionRange,
} from "../ui/rail-section";
import { SGR_MOUSE_RE, clamp, comparePosition, parseWheel, samePosition, segmenter, stripAnsi, type Position } from "../utils";
import { isInteractiveRoot } from "./history-renderer";
import { stateFor, type ActiveInteraction, type ConversationScrollStore, type ScrollAnimation, type ScrollState, type ScrollView } from "./state";

const HISTORY_MUTATING_KEYS = new Set(["\x0f"]); // Ctrl+O: Pi global expand/collapse may mutate older history blocks.

type ConversationMouse = { x: number; y: number; action: "press" | "drag" | "release" | "copy" };

export function selectionRange(selection?: { anchor: Position; active: Position }): { start: Position; end: Position } | undefined {
	if (!selection || samePosition(selection.anchor, selection.active)) return undefined;
	return comparePosition(selection.anchor, selection.active) <= 0
		? { start: selection.anchor, end: selection.active }
		: { start: selection.active, end: selection.anchor };
}

function plainVisibleSlice(line: string, startCol: number, endCol: number): string {
	if (endCol <= startCol) return "";
	let out = "";
	let col = 0;
	for (const segment of segmenter.segment(stripAnsi(line))) {
		const grapheme = segment.segment;
		const width = visibleWidth(grapheme);
		if (width > 0 && col >= startCol && col < endCol) out += grapheme;
		col += width;
	}
	return out;
}

function railSectionRangeAtLine(state: ScrollState, line: number): RailSectionRange | undefined {
	const ranges = state.renderCache?.historyRailSectionRanges;
	if (!ranges?.length) return undefined;
	let low = 0;
	let high = ranges.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const range = ranges[mid]!;
		if (line < range.start) high = mid - 1;
		else if (line >= range.end) low = mid + 1;
		else return range;
	}
	return undefined;
}

function selectedHistoryLineText(
	state: ScrollState,
	line: string,
	lineIndex: number,
	startCol: number,
	endCol: number,
): string {
	const sectionRange = railSectionRangeAtLine(state, lineIndex);
	if (!sectionRange) return plainVisibleSlice(line, startCol, endCol).replace(/[ \t]+$/u, "");
	const section = sectionRange.section;
	if (!section.config.selectable) return "";

	let effectiveStart = startCol;
	let effectiveEnd = endCol;
	if (section.config.selection.mode === "contentOnly") {
		const contentStart = railSectionSelectionStartCol(section);
		effectiveStart = Math.max(effectiveStart, contentStart);
		effectiveEnd = Math.max(effectiveEnd, contentStart);
	}
	let text = plainVisibleSlice(line, effectiveStart, effectiveEnd);
	if (section.config.selection.trimRight) text = text.replace(/[ \t]+$/u, "");
	return text;
}

function selectedHistoryText(state: ScrollState): string | undefined {
	const range = selectionRange(state.selection);
	const lines = state.renderCache?.historyLines;
	if (!range || !lines) return undefined;

	const selected: string[] = [];
	for (let lineIndex = range.start.line; lineIndex <= range.end.line; lineIndex++) {
		const line = lines[lineIndex] ?? "";
		const startCol = lineIndex === range.start.line ? range.start.col : 0;
		const endCol = lineIndex === range.end.line ? range.end.col : state.view?.width ?? visibleWidth(stripAnsi(line));
		selected.push(selectedHistoryLineText(state, line, lineIndex, startCol, endCol));
	}
	return selected.join("\n");
}

function copySelectedHistoryText(state: ScrollState): boolean {
	const text = selectedHistoryText(state);
	return Boolean(text && copyToClipboard(text));
}

function clearSelectionCopyTimer(state: ScrollState): void {
	if (!state.copyTimer) return;
	clearTimeout(state.copyTimer);
	state.copyTimer = undefined;
}

function scheduleSelectedHistoryCopy(state: ScrollState): void {
	clearSelectionCopyTimer(state);
	state.copyTimer = setTimeout(() => {
		state.copyTimer = undefined;
		copySelectedHistoryText(state);
	}, 120);
}

function shouldPreferHistoryCacheForInput(data: string): boolean {
	if (HISTORY_MUTATING_KEYS.has(data)) return false;
	if (data === "\r" || data === "\n" || data === "\r\n") return false;
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code < 32 && data !== "\t") return false;
	}
	return true;
}

function parseConversationMouse(data: string): ConversationMouse | undefined {
	if (!data.startsWith("\x1b[<")) return undefined;
	const match = SGR_MOUSE_RE.exec(data);
	if (!match) return undefined;

	const code = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	const final = match[4];
	if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
	if ((code & 64) !== 0) return undefined;

	const button = code & 3;
	const release = final === "m" || button === 3;
	const drag = !release && (code & 32) !== 0;
	const leftButton = button === 0;
	const rightButton = button === 2;
	if (!release && rightButton && !drag) return { x, y, action: "copy" };
	if (!release && !leftButton) return undefined;
	return { x, y, action: release ? "release" : drag ? "drag" : "press" };
}

function normalizePointForSelection(state: ScrollState, pos: Position): Position {
	return normalizeRailSectionPosition(pos, railSectionRangeAtLine(state, pos.line));
}

function pointForMouse(state: ScrollState, mouse: ConversationMouse): Position | undefined {
	const view = state.view;
	if (!view || view.rows <= 0 || view.lineCount <= 0) return undefined;

	const row = Math.max(0, Math.min(view.rows - 1, mouse.y - 1));
	const line = Math.max(0, Math.min(view.lineCount - 1, view.start + row));
	const col = Math.max(0, Math.min(view.width, mouse.x - 1));
	return normalizePointForSelection(state, { line, col });
}

function isOnScrollbar(view: ScrollView, mouse: ConversationMouse): boolean {
	const scrollbar = view.scrollbar;
	const row = mouse.y - 1;
	return Boolean(scrollbar && row >= 0 && row < view.rows && mouse.x >= scrollbar.xStart && mouse.x <= scrollbar.xEnd);
}

function easeOutCubic(value: number): number {
	const inverse = 1 - clamp(value, 0, 1);
	return 1 - inverse * inverse * inverse;
}

function animationFrameMs(): number {
	return Math.max(8, Math.round((TUI as any).MIN_RENDER_INTERVAL_MS ?? 16));
}

function clearScrollAnimation(state: ScrollState, store: ConversationScrollStore): void {
	const timer = state.scrollAnimation?.timer;
	if (timer) {
		clearTimeout(timer);
		store.animationTimers.delete(timer);
	}
	state.scrollAnimation = undefined;
}

function lockScrollStart(state: ScrollState, start: number): void {
	const view = state.view;
	if (!view) return;
	state.lockedStart = clamp(Math.round(start), 0, Math.max(0, view.lineCount - view.rows));
}

function applyScrollLockForOffset(state: ScrollState, offsetFromBottom: number): void {
	const view = state.view;
	if (!view) return;
	const maxStart = Math.max(0, view.lineCount - view.rows);
	if (offsetFromBottom <= 0) state.lockedStart = undefined;
	else state.lockedStart = maxStart - clamp(Math.round(offsetFromBottom), 0, maxStart);
}

function scheduleScrollAnimationTick(tui: any, state: ScrollState, store: ConversationScrollStore): void {
	const animation = state.scrollAnimation;
	if (!animation) return;

	const timer = setTimeout(() => {
		store.animationTimers.delete(timer);
		if (state.scrollAnimation?.timer !== timer) return;
		state.scrollAnimation.timer = undefined;
		advanceScrollAnimation(tui, state, store);
	}, animationFrameMs());
	animation.timer = timer;
	store.animationTimers.add(timer);
}

function advanceScrollAnimation(tui: any, state: ScrollState, store: ConversationScrollStore): void {
	const animation = state.scrollAnimation;
	const view = state.view;
	if (!animation || !view) return;

	const maxOffset = Math.max(0, view.lineCount - view.rows);
	const target = clamp(animation.targetOffsetFromBottom, 0, maxOffset);
	const elapsed = Date.now() - animation.startedAt;
	const progress = animation.durationMs <= 0 ? 1 : clamp(elapsed / animation.durationMs, 0, 1);
	const timedOut = elapsed > 2000;
	const nextOffset = progress >= 1
		? target
		: Math.round(animation.startOffsetFromBottom + (target - animation.startOffsetFromBottom) * easeOutCubic(progress));

	if (state.offsetFromBottom !== nextOffset) {
		state.offsetFromBottom = nextOffset;
		state.preferCachedRender = true;
		tui.requestRender?.();
	}

	if (progress >= 1 || timedOut || state.offsetFromBottom === target) {
		state.offsetFromBottom = target;
		if (animation.lockAtEnd) {
			const maxStart = Math.max(0, view.lineCount - view.rows);
			const targetStart = animation.targetStart ?? maxStart - target;
			if (targetStart >= maxStart) state.lockedStart = undefined;
			else state.lockedStart = clamp(Math.round(targetStart), 0, maxStart);
		}
		state.scrollAnimation = undefined;
		return;
	}

	scheduleScrollAnimationTick(tui, state, store);
}

function setOffsetFromBottomImmediate(
	state: ScrollState,
	store: ConversationScrollStore,
	offset: number,
	lock = false,
): boolean {
	const view = state.view;
	if (!view) return false;

	clearScrollAnimation(state, store);
	const maxOffset = Math.max(0, view.lineCount - view.rows);
	const nextOffset = clamp(Math.round(offset), 0, maxOffset);
	const changed = state.offsetFromBottom !== nextOffset;
	state.offsetFromBottom = nextOffset;
	if (lock) applyScrollLockForOffset(state, nextOffset);
	else state.lockedStart = undefined;
	state.preferCachedRender = true;
	return changed;
}

function animateOffsetFromBottom(
	tui: any,
	state: ScrollState,
	store: ConversationScrollStore,
	offset: number,
	options: { targetStart?: number; lockAtEnd?: boolean } = {},
): boolean {
	const view = state.view;
	if (!view) return false;

	const maxOffset = Math.max(0, view.lineCount - view.rows);
	const target = clamp(Math.round(offset), 0, maxOffset);
	if (CONVERSATION_SCROLLBAR_STYLE.dragAnimationMs <= 0) {
		const changed = setOffsetFromBottomImmediate(state, store, target, options.lockAtEnd === true);
		if (options.lockAtEnd && options.targetStart !== undefined) lockScrollStart(state, options.targetStart);
		return changed;
	}

	const currentAnimation = state.scrollAnimation;
	if (currentAnimation?.targetOffsetFromBottom === target && currentAnimation.targetStart === options.targetStart) return false;
	if (target === state.offsetFromBottom) {
		clearScrollAnimation(state, store);
		if (options.lockAtEnd && options.targetStart !== undefined) lockScrollStart(state, options.targetStart);
		else if (!options.lockAtEnd) state.lockedStart = undefined;
		return false;
	}

	clearScrollAnimation(state, store);
	state.lockedStart = undefined;
	state.scrollAnimation = {
		startOffsetFromBottom: state.offsetFromBottom,
		targetOffsetFromBottom: target,
		targetStart: options.targetStart,
		lockAtEnd: options.lockAtEnd,
		startedAt: Date.now(),
		durationMs: CONVERSATION_SCROLLBAR_STYLE.dragAnimationMs,
	} satisfies ScrollAnimation;
	scheduleScrollAnimationTick(tui, state, store);
	return true;
}

function scrollOffsetFromStart(view: ScrollView, start: number): number {
	const maxStart = Math.max(0, view.lineCount - view.rows);
	const clampedStart = clamp(Math.round(start), 0, maxStart);
	return maxStart - clampedStart;
}

function scrollStartForThumbRow(row: number, metrics: NonNullable<ScrollView["scrollbar"]>, pointerOffsetRows: number): number {
	if (metrics.maxThumbStart <= 0) return 0;

	const targetThumbStart = clamp(row - pointerOffsetRows, 0, metrics.maxThumbStart);
	return Math.round((targetThumbStart / metrics.maxThumbStart) * metrics.maxScrollStart);
}

function applyScrollbarMouseRow(tui: any, state: ScrollState, store: ConversationScrollStore, row: number): boolean {
	const view = state.view;
	const metrics = view?.scrollbar;
	const drag = state.interaction.type === "scrollbarDrag" ? state.interaction : undefined;
	if (!view || !metrics || !drag) return false;

	const clampedRow = clamp(row, 0, Math.max(0, view.rows - 1));
	const start = scrollStartForThumbRow(clampedRow, metrics, drag.pointerOffsetRows);
	return animateOffsetFromBottom(tui, state, store, scrollOffsetFromStart(view, start), { targetStart: start, lockAtEnd: true });
}

function railSectionRangeAtMouse(state: ScrollState, mouse: ConversationMouse): RailSectionRange | undefined {
	const view = state.view;
	if (!view) return undefined;

	const row = mouse.y - 1;
	if (row < 0 || row >= view.rows) return undefined;
	return railSectionRangeAtLine(state, view.start + row);
}

function setRailSectionSelectionFromMouse(
	tui: any,
	state: ScrollState,
	pending: ActiveInteraction & { type: "railSectionClick" },
	mouse: ConversationMouse,
	selecting: boolean,
): boolean {
	const anchor = pointForMouse(state, { x: pending.x, y: pending.y, action: "press" });
	const active = pointForMouse(state, mouse);
	if (!anchor || !active) return false;

	state.interaction = selecting ? { type: "selecting" } : { type: "idle" };
	state.selection = { anchor, active };
	const range = selectionRange(state.selection);
	if (range && selecting) scheduleSelectedHistoryCopy(state);
	else clearSelectionCopyTimer(state);
	if (!range && !selecting) state.selection = undefined;
	else if (range && !selecting) copySelectedHistoryText(state);
	state.preferCachedRender = true;
	tui.requestRender?.();
	return true;
}

function handleRailSectionMouse(tui: any, data: string, store: ConversationScrollStore): boolean {
	const mouse = parseConversationMouse(data);
	if (!mouse) return false;

	const state = stateFor(tui, store);
	if (mouse.action === "copy") return false;

	if (mouse.action === "press") {
		const range = railSectionRangeAtMouse(state, mouse);
		if (!range) return false;

		clearSelectionCopyTimer(state);
		clearScrollAnimation(state, store);
		if (state.view) lockScrollStart(state, state.view.start);
		state.selection = undefined;
		state.interaction = { type: "railSectionClick", section: range.section, x: mouse.x, y: mouse.y, moved: false };
		return true;
	}

	if (state.interaction.type !== "railSectionClick") return false;
	const pending = state.interaction;

	if (mouse.action === "drag") {
		if (railSectionMoved(pending, mouse.x, mouse.y)) {
			pending.moved = true;
			setRailSectionSelectionFromMouse(tui, state, pending, mouse, true);
		}
		return true;
	}

	if (mouse.action === "release") {
		state.interaction = { type: "idle" };
		if (pending.moved || railSectionMoved(pending, mouse.x, mouse.y)) {
			setRailSectionSelectionFromMouse(tui, state, pending, mouse, false);
			return true;
		}

		const range = railSectionRangeAtMouse(state, mouse);
		if (sameRailSection(range?.section, pending.section) && canToggleRailSection(pending.section)) {
			toggleRailSection(pending.section);
			state.historyDirty = true;
			state.preferCachedRender = false;
			tui.requestRender?.();
		}
		return true;
	}

	return false;
}

function handleConversationScrollbarDrag(tui: any, data: string, store: ConversationScrollStore): boolean {
	if (!CONVERSATION_SCROLLBAR_STYLE.dragEnabled) return false;
	const mouse = parseConversationMouse(data);
	if (!mouse) return false;

	const state = stateFor(tui, store);
	const view = state.view;
	const metrics = view?.scrollbar;
	if (!view || !metrics) {
		if (mouse.action === "release" && state.interaction.type === "scrollbarDrag") state.interaction = { type: "idle" };
		return false;
	}

	const row = mouse.y - 1;
	const onScrollbar = isOnScrollbar(view, mouse);
	if (mouse.action === "copy" && onScrollbar) return true;

	if (mouse.action === "press") {
		if (!onScrollbar) return false;

		clearSelectionCopyTimer(state);
		const hadSelection = Boolean(state.selection || state.interaction.type === "selecting");
		state.selection = undefined;
		const insideThumb = row >= metrics.thumbStart && row < metrics.thumbStart + metrics.thumbSize;
		const pointerOffsetRows = insideThumb ? row - metrics.thumbStart : Math.floor(metrics.thumbSize / 2);
		state.interaction = { type: "scrollbarDrag", pointerOffsetRows: clamp(pointerOffsetRows, 0, Math.max(0, metrics.thumbSize - 1)) };
		if (applyScrollbarMouseRow(tui, state, store, row) || hadSelection) tui.requestRender?.();
		return true;
	}

	if (state.interaction.type !== "scrollbarDrag") return false;

	if (mouse.action === "drag") {
		if (applyScrollbarMouseRow(tui, state, store, row)) tui.requestRender?.();
		return true;
	}

	if (mouse.action === "release") {
		const changed = applyScrollbarMouseRow(tui, state, store, row);
		state.interaction = { type: "idle" };
		if (changed) tui.requestRender?.();
		return true;
	}

	return false;
}

function handleConversationSelection(tui: any, data: string, store: ConversationScrollStore): boolean {
	const mouse = parseConversationMouse(data);
	if (!mouse) return false;

	const state = stateFor(tui, store);
	const view = state.view;
	if (!view) return false;

	const row = mouse.y - 1;
	const startsInHistory = row >= 0 && row < view.rows;
	if (mouse.action === "copy") {
		clearSelectionCopyTimer(state);
		return startsInHistory && copySelectedHistoryText(state);
	}
	if (mouse.action === "press" && !startsInHistory) {
		if (state.selection) {
			clearSelectionCopyTimer(state);
			state.selection = undefined;
			state.interaction = { type: "idle" };
			tui.requestRender?.();
		}
		return false;
	}
	if (mouse.action !== "press" && state.interaction.type !== "selecting") return false;

	const pos = pointForMouse(state, mouse);
	if (!pos) return false;

	if (mouse.action === "press") {
		clearSelectionCopyTimer(state);
		clearScrollAnimation(state, store);
		lockScrollStart(state, view.start);
		state.interaction = { type: "selecting" };
		state.selection = { anchor: pos, active: pos };
	} else if (mouse.action === "drag") {
		state.interaction = { type: "selecting" };
		state.selection = state.selection ? { ...state.selection, active: pos } : { anchor: pos, active: pos };
		if (selectionRange(state.selection)) scheduleSelectedHistoryCopy(state);
	} else {
		if (state.selection) state.selection.active = pos;
		state.interaction = { type: "idle" };
		clearSelectionCopyTimer(state);
		if (!selectionRange(state.selection)) state.selection = undefined;
		else copySelectedHistoryText(state);
	}

	state.preferCachedRender = true;
	tui.requestRender?.();
	return true;
}

export function handleConversationInput(tui: any, data: string, originalHandleInput: (data: string) => void, store: ConversationScrollStore): void {
	if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(tui)) return originalHandleInput.call(tui, data);
	if (tui.getTopmostVisibleOverlay?.()) {
		stateFor(tui, store).preferCachedRender = true;
		return originalHandleInput.call(tui, data);
	}

	const wheel = parseWheel(data);
	if (wheel) {
		const state = stateFor(tui, store);
		const row = wheel.y - 1;
		const view = state.view;
		if (!view || (row >= view.editorTopRow && row < view.editorBottomRow)) {
			state.preferCachedRender = true;
			return originalHandleInput.call(tui, data);
		}
		if (setOffsetFromBottomImmediate(state, store, state.offsetFromBottom + wheel.direction * CONVERSATION_SCROLL_LAYOUT.wheelStepRows, true)) {
			tui.requestRender?.();
		}
		return;
	}

	if (handleConversationScrollbarDrag(tui, data, store)) return;
	if (handleRailSectionMouse(tui, data, store)) return;
	if (handleConversationSelection(tui, data, store)) return;
	const state = stateFor(tui, store);
	if (HISTORY_MUTATING_KEYS.has(data)) {
		state.historyDirty = true;
		state.preferCachedRender = false;
	} else if (shouldPreferHistoryCacheForInput(data)) {
		state.preferCachedRender = true;
	}
	return originalHandleInput.call(tui, data);
}
