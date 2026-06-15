import { TUI, visibleWidth } from "@earendil-works/pi-tui";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { showFooterSelectionNotice, toggleFooterExpanded } from "../footer";
import { CONVERSATION_SCROLL_LAYOUT, CONVERSATION_SCROLLBAR_STYLE } from "../../config";
import {
	canToggleRailSection,
	normalizeRailSectionPosition,
	railSectionSelectionStartCol,
	sameRailSection,
	toggleRailSection,
	type RailSectionRange,
} from "../../rail/rail-section";
import { SGR_MOUSE_RE, clamp, comparePosition, parseWheel, samePosition, segmenter, stripAnsi, type Position } from "../../core/utils";
import { isInteractiveRoot } from "./history-renderer";
import { stateFor, type ActiveInteraction, type ConversationScrollStore, type ScrollAnimation, type ScrollState, type ScrollView } from "./state";

const HISTORY_MUTATING_KEYS = new Set(["\x0f"]); // Ctrl+O: Pi global expand/collapse may mutate older history blocks.
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_MAX_DISTANCE = 1;
const SELECTION_AUTO_SCROLL_MS = 80;
const SELECTION_INCLUSIVE_COLUMN_BIAS = 2;

type ConversationMouse = { x: number; y: number; action: "press" | "drag" | "release" | "copy"; clickCount?: number };
type ClickMemory = { x: number; y: number; at: number; count: number };

const clickMemory = new WeakMap<ScrollState, ClickMemory>();
const coalescedInteractionRenderTimers = new WeakMap<ScrollState, ReturnType<typeof setTimeout>>();
const coalescedInteractionRenderForces = new WeakMap<ScrollState, boolean>();

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

function copySelectedHistoryText(state: ScrollState, tui?: any): boolean {
	const text = selectedHistoryText(state);
	if (!text) return false;
	// pi's copyToClipboard is async (native addon + OSC52 fallback) and throws on
	// failure. Fire-and-forget so the input handler stays synchronous; the boolean
	// now reports "had text to copy", which is all callers use it for.
	void copyToClipboard(text).then(
		() => showFooterSelectionNotice(tui),
		() => {
			// Stay silent on clipboard failure.
		},
	);
	return true;
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

function mouseRow(mouse: Pick<ConversationMouse, "y">): number {
	return mouse.y - 1;
}

function mouseHistoryLine(view: ScrollView, mouse: ConversationMouse): number | undefined {
	const row = mouseRow(mouse);
	if (row < 0 || row >= view.rows) return undefined;
	return view.start + row;
}

function mouseLocalX(view: ScrollView, mouse: Pick<ConversationMouse, "x">): number {
	return mouse.x - 1 - view.leftGutterWidth;
}

function mouseMovedFrom(start: { x: number; y: number }, mouse: ConversationMouse, tolerance = 0): boolean {
	return Math.abs(start.x - mouse.x) > tolerance || Math.abs(start.y - mouse.y) > tolerance;
}

function normalizePointForSelection(state: ScrollState, pos: Position): Position {
	return normalizeRailSectionPosition(pos, railSectionRangeAtLine(state, pos.line));
}

function pointForMouse(state: ScrollState, mouse: ConversationMouse): Position | undefined {
	const view = state.view;
	if (!view || view.rows <= 0 || view.lineCount <= 0) return undefined;

	const row = clamp(mouseRow(mouse), 0, view.rows - 1);
	const line = Math.max(0, Math.min(view.lineCount - 1, view.start + row));
	const col = Math.max(0, Math.min(view.width, mouseLocalX(view, mouse)));
	return normalizePointForSelection(state, { line, col });
}

function inclusiveSelectionForMouse(
	state: ScrollState,
	anchor: Position,
	mouse: ConversationMouse,
): { anchor: Position; active: Position } | undefined {
	const active = pointForMouse(state, mouse);
	const view = state.view;
	if (!active || !view) return undefined;
	if (comparePosition(active, anchor) >= 0) {
		return { anchor, active: normalizePointForSelection(state, { line: active.line, col: Math.min(view.width, active.col + SELECTION_INCLUSIVE_COLUMN_BIAS) }) };
	}
	return {
		anchor: normalizePointForSelection(state, { line: anchor.line, col: Math.min(view.width, anchor.col + SELECTION_INCLUSIVE_COLUMN_BIAS) }),
		active,
	};
}

function clickCountForMouse(state: ScrollState, mouse: ConversationMouse): number {
	const now = Date.now();
	const previous = clickMemory.get(state);
	const sameClickTarget = previous
		&& Math.abs(previous.x - mouse.x) <= DOUBLE_CLICK_MAX_DISTANCE
		&& previous.y === mouse.y
		&& now - previous.at <= DOUBLE_CLICK_MS;
	const count = sameClickTarget ? Math.min(3, previous.count + 1) : 1;
	clickMemory.set(state, { x: mouse.x, y: mouse.y, at: now, count });
	return count;
}

function lineVisibleWidth(state: ScrollState, line: number): number {
	return Math.min(state.view?.width ?? 0, visibleWidth(stripAnsi(state.renderCache?.historyLines[line] ?? "")));
}

function wordSelectionAt(state: ScrollState, pos: Position): { anchor: Position; active: Position } | undefined {
	const text = stripAnsi(state.renderCache?.historyLines[pos.line] ?? "");
	if (!text) return undefined;

	const chars = [...segmenter.segment(text)].map((segment) => ({ text: segment.segment, width: visibleWidth(segment.segment) }));
	let col = 0;
	let index = 0;
	for (; index < chars.length; index++) {
		const width = chars[index]!.width;
		if (width > 0 && pos.col < col + width) break;
		col += width;
	}
	if (index >= chars.length || /\s/u.test(chars[index]!.text)) return undefined;

	let startIndex = index;
	let endIndex = index + 1;
	while (startIndex > 0 && !/\s/u.test(chars[startIndex - 1]!.text)) startIndex--;
	while (endIndex < chars.length && !/\s/u.test(chars[endIndex]!.text)) endIndex++;

	const startCol = chars.slice(0, startIndex).reduce((sum, item) => sum + item.width, 0);
	const endCol = chars.slice(0, endIndex).reduce((sum, item) => sum + item.width, 0);
	return {
		anchor: normalizePointForSelection(state, { line: pos.line, col: startCol }),
		active: normalizePointForSelection(state, { line: pos.line, col: endCol }),
	};
}

function lineSelectionAt(state: ScrollState, pos: Position): { anchor: Position; active: Position } {
	return {
		anchor: normalizePointForSelection(state, { line: pos.line, col: 0 }),
		active: normalizePointForSelection(state, { line: pos.line, col: lineVisibleWidth(state, pos.line) }),
	};
}

function applyClickSelection(tui: any, state: ScrollState, pos: Position, clickCount: number): boolean {
	if (clickCount < 2) return false;
	const selection = clickCount >= 3 ? lineSelectionAt(state, pos) : wordSelectionAt(state, pos);
	if (!selection) return false;
	state.selection = selection;
	state.interaction = { type: "idle" };
	state.preferCachedRender = true;
	copySelectedHistoryText(state, tui);
	tui.requestRender?.();
	return true;
}

function isOnScrollbar(view: ScrollView, mouse: ConversationMouse): boolean {
	const scrollbar = view.scrollbar;
	const row = mouseRow(mouse);
	return Boolean(scrollbar && row >= 0 && row < view.rows && mouse.x >= scrollbar.xStart && mouse.x <= scrollbar.xEnd);
}

function easeOutCubic(value: number): number {
	const inverse = 1 - clamp(value, 0, 1);
	return 1 - inverse * inverse * inverse;
}

function animationFrameMs(): number {
	return Math.max(8, Math.round((TUI as any).MIN_RENDER_INTERVAL_MS ?? 16));
}

function requestCoalescedInteractionRender(tui: any, state: ScrollState, store: ConversationScrollStore, force = false): void {
	if (force) coalescedInteractionRenderForces.set(state, true);
	if (coalescedInteractionRenderTimers.has(state)) return;
	const timer = setTimeout(() => {
		store.animationTimers.delete(timer);
		if (coalescedInteractionRenderTimers.get(state) !== timer) return;
		coalescedInteractionRenderTimers.delete(state);
		const shouldForce = coalescedInteractionRenderForces.get(state) === true;
		coalescedInteractionRenderForces.delete(state);
		tui.requestRender?.(shouldForce);
	}, animationFrameMs());
	coalescedInteractionRenderTimers.set(state, timer);
	store.animationTimers.add(timer);
}

function clearScrollAnimation(state: ScrollState, store: ConversationScrollStore): void {
	const timer = state.scrollAnimation?.timer;
	if (timer) {
		clearTimeout(timer);
		store.animationTimers.delete(timer);
	}
	state.scrollAnimation = undefined;
}

function clearSelectionAutoScroll(state: ScrollState, store: ConversationScrollStore): void {
	if (!state.selectionAutoScrollTimer) return;
	clearTimeout(state.selectionAutoScrollTimer);
	store.animationTimers.delete(state.selectionAutoScrollTimer);
	state.selectionAutoScrollTimer = undefined;
}

function clearHistorySelection(state: ScrollState, store: ConversationScrollStore): boolean {
	const hadSelection = Boolean(state.selection || state.interaction.type === "selecting");
	clearSelectionAutoScroll(state, store);
	state.selection = undefined;
	state.interaction = { type: "idle" };
	state.preferCachedRender = true;
	return hadSelection;
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
		tui.requestRender?.(true);
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

function autoScrollSelectionOnce(tui: any, state: ScrollState, store: ConversationScrollStore, mouse: ConversationMouse): void {
	const view = state.view;
	if (!view || state.interaction.type !== "selecting") return;

	const row = mouseRow(mouse);
	const direction = row <= 0 ? 1 : row >= view.rows ? -1 : 0;
	if (direction === 0) {
		clearSelectionAutoScroll(state, store);
		return;
	}

	if (setOffsetFromBottomImmediate(state, store, state.offsetFromBottom + direction, true)) {
		const maxStart = Math.max(0, view.lineCount - view.rows);
		const nextStart = clamp(view.start - direction, 0, maxStart);
		const line = direction > 0 ? nextStart : Math.min(view.lineCount - 1, nextStart + view.rows - 1);
		const anchor = state.interaction.type === "selecting" ? state.interaction.anchor : undefined;
		state.selection = anchor
			? {
				anchor,
				active: normalizePointForSelection(state, { line, col: direction > 0 ? 0 : view.width }),
			}
			: state.selection;
		tui.requestRender?.(true);
	}

	if (!state.selectionAutoScrollTimer) {
		const timer = setTimeout(() => {
			store.animationTimers.delete(timer);
			if (state.selectionAutoScrollTimer !== timer) return;
			state.selectionAutoScrollTimer = undefined;
			autoScrollSelectionOnce(tui, state, store, mouse);
		}, SELECTION_AUTO_SCROLL_MS);
		state.selectionAutoScrollTimer = timer;
		store.animationTimers.add(timer);
	}
}

function railSectionRangeAtMouse(state: ScrollState, mouse: ConversationMouse, includeLeadingToggleRow = false): RailSectionRange | undefined {
	const view = state.view;
	if (!view) return undefined;

	const line = mouseHistoryLine(view, mouse);
	if (line === undefined) return undefined;
	const range = railSectionRangeAtLine(state, line);
	if (range) return range;
	if (!includeLeadingToggleRow) return undefined;

	const nextRange = railSectionRangeAtLine(state, line + 1);
	const currentLine = state.renderCache?.historyLines[line];
	if (
		nextRange
		&& nextRange.start === line + 1
		&& canToggleRailSection(nextRange.section)
		&& stripAnsi(currentLine ?? "").trim().length === 0
	) {
		return nextRange;
	}
	return undefined;
}

function setRailSectionSelectionFromMouse(
	tui: any,
	state: ScrollState,
	store: ConversationScrollStore,
	pending: ActiveInteraction & { type: "railSectionClick" },
	mouse: ConversationMouse,
	selecting: boolean,
): boolean {
	const anchor = pointForMouse(state, { x: pending.x, y: pending.y, action: "press" });
	const selection = anchor ? inclusiveSelectionForMouse(state, anchor, mouse) : undefined;
	if (!anchor || !selection) return false;

	state.interaction = selecting ? { type: "selecting", x: pending.x, y: pending.y, moved: true, anchor } : { type: "idle" };
	state.selection = selection;
	const range = selectionRange(state.selection);
	if (!range && !selecting) state.selection = undefined;
	else if (range && !selecting) copySelectedHistoryText(state, tui);
	if (!selecting) clearSelectionAutoScroll(state, store);
	state.preferCachedRender = true;
	if (selecting) requestCoalescedInteractionRender(tui, state, store);
	else tui.requestRender?.();
	return true;
}

function handleRailSectionMouse(tui: any, mouse: ConversationMouse, store: ConversationScrollStore): boolean {
	const state = stateFor(tui, store);
	if (mouse.action === "copy") return false;

	if (mouse.action === "press") {
		const range = railSectionRangeAtMouse(state, mouse, true);
		if (!range) return false;
		if (mouse.clickCount && mouse.clickCount >= 2 && !canToggleRailSection(range.section)) return false;

		const hadSelection = clearHistorySelection(state, store);
		clearScrollAnimation(state, store);
		if (state.view) lockScrollStart(state, state.view.start);
		state.interaction = { type: "railSectionClick", section: range.section, x: mouse.x, y: mouse.y, moved: false };
		if (hadSelection) tui.requestRender?.();
		return true;
	}

	if (state.interaction.type !== "railSectionClick") return false;
	const pending = state.interaction;

	if (mouse.action === "drag") {
		if (mouseMovedFrom(pending, mouse)) {
			pending.moved = true;
			setRailSectionSelectionFromMouse(tui, state, store, pending, mouse, true);
		}
		return true;
	}

	if (mouse.action === "release") {
		state.interaction = { type: "idle" };
		if (pending.moved || mouseMovedFrom(pending, mouse)) {
			setRailSectionSelectionFromMouse(tui, state, store, pending, mouse, false);
			return true;
		}

		const range = railSectionRangeAtMouse(state, mouse, true);
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

function isOnFooter(view: ScrollView, mouse: ConversationMouse): boolean {
	const row = mouseRow(mouse);
	return row >= view.footerTopRow && row < view.footerBottomRow;
}

function handleFooterMouse(tui: any, mouse: ConversationMouse, store: ConversationScrollStore): boolean {
	if (mouse.action === "copy") return false;

	const state = stateFor(tui, store);
	const view = state.view;
	if (!view) {
		if (mouse.action === "release" && state.interaction.type === "footerClick") state.interaction = { type: "idle" };
		return false;
	}

	if (mouse.action === "press") {
		if (!isOnFooter(view, mouse)) return false;
		const hadSelection = clearHistorySelection(state, store);
		clearScrollAnimation(state, store);
		state.interaction = { type: "footerClick", x: mouse.x, y: mouse.y, moved: false };
		if (hadSelection) tui.requestRender?.();
		return true;
	}

	if (state.interaction.type !== "footerClick") return false;
	const pending = state.interaction;

	if (mouse.action === "drag") {
		if (mouseMovedFrom(pending, mouse)) pending.moved = true;
		return true;
	}

	if (mouse.action === "release") {
		state.interaction = { type: "idle" };
		if (!pending.moved && !mouseMovedFrom(pending, mouse) && isOnFooter(view, mouse)) {
			toggleFooterExpanded();
			state.preferCachedRender = true;
			tui.requestRender?.();
		}
		return true;
	}

	return false;
}

function handleConversationScrollbarDrag(tui: any, mouse: ConversationMouse, store: ConversationScrollStore): boolean {
	if (!CONVERSATION_SCROLLBAR_STYLE.dragEnabled) return false;

	const state = stateFor(tui, store);
	const view = state.view;
	const metrics = view?.scrollbar;
	if (!view || !metrics) {
		if (mouse.action === "release" && state.interaction.type === "scrollbarDrag") state.interaction = { type: "idle" };
		return false;
	}

	const row = mouseRow(mouse);
	const onScrollbar = isOnScrollbar(view, mouse);
	if (mouse.action === "copy" && onScrollbar) return true;

	if (mouse.action === "press") {
		if (!onScrollbar) return false;

		const hadSelection = clearHistorySelection(state, store);
		const insideThumb = row >= metrics.thumbStart && row < metrics.thumbStart + metrics.thumbSize;
		const pointerOffsetRows = insideThumb ? row - metrics.thumbStart : Math.floor(metrics.thumbSize / 2);
		state.interaction = { type: "scrollbarDrag", pointerOffsetRows: clamp(pointerOffsetRows, 0, Math.max(0, metrics.thumbSize - 1)) };
		if (applyScrollbarMouseRow(tui, state, store, row) || hadSelection) tui.requestRender?.(true);
		return true;
	}

	if (state.interaction.type !== "scrollbarDrag") return false;

	if (mouse.action === "drag") {
		if (applyScrollbarMouseRow(tui, state, store, row)) requestCoalescedInteractionRender(tui, state, store, true);
		return true;
	}

	if (mouse.action === "release") {
		const changed = applyScrollbarMouseRow(tui, state, store, row);
		state.interaction = { type: "idle" };
		if (changed) tui.requestRender?.(true);
		return true;
	}

	return false;
}

function handleConversationSelection(tui: any, mouse: ConversationMouse, store: ConversationScrollStore): boolean {
	const state = stateFor(tui, store);
	const view = state.view;
	if (!view) return false;

	const row = mouseRow(mouse);
	const startsInHistory = row >= 0 && row < view.rows;
	if (mouse.action === "copy") {
		return startsInHistory && copySelectedHistoryText(state, tui);
	}
	if (mouse.action === "press" && !startsInHistory) {
		if (clearHistorySelection(state, store)) tui.requestRender?.();
		return false;
	}
	if (mouse.action !== "press" && state.interaction.type !== "selecting") return false;

	if (mouse.action === "press") {
		const pos = pointForMouse(state, mouse);
		if (!pos) return false;
		const clickCount = mouse.clickCount ?? 1;
		if (clickCount >= 2 && applyClickSelection(tui, state, pos, clickCount)) return true;
		const hadSelection = clearHistorySelection(state, store);
		clearScrollAnimation(state, store);
		lockScrollStart(state, view.start);
		state.interaction = { type: "selecting", x: mouse.x, y: mouse.y, moved: false, anchor: pos };
		state.selection = undefined;
		if (hadSelection) tui.requestRender?.();
	} else if (mouse.action === "drag") {
		const pending = state.interaction.type === "selecting" ? state.interaction : undefined;
		const anchor = pending?.anchor;
		const selection = anchor ? inclusiveSelectionForMouse(state, anchor, mouse) : undefined;
		if (!selection || !pending) return false;
		const moved = pending.moved || mouseMovedFrom(pending, mouse);
		state.interaction = { type: "selecting", x: mouse.x, y: mouse.y, moved, anchor };
		state.selection = moved ? selection : undefined;
		autoScrollSelectionOnce(tui, state, store, mouse);
	} else {
		const pending = state.interaction.type === "selecting" ? state.interaction : undefined;
		const anchor = pending?.anchor;
		const selection = anchor ? inclusiveSelectionForMouse(state, anchor, mouse) : undefined;
		if (!selection || !pending) return false;
		const moved = pending.moved || mouseMovedFrom(pending, mouse);
		if (moved) state.selection = selection;
		state.interaction = { type: "idle" };
		clearSelectionAutoScroll(state, store);
		if (!moved || !selectionRange(state.selection)) state.selection = undefined;
		else copySelectedHistoryText(state, tui);
	}

	state.preferCachedRender = true;
	if (mouse.action === "drag") requestCoalescedInteractionRender(tui, state, store);
	else tui.requestRender?.();
	return true;
}

export function handleConversationInput(tui: any, data: string, originalHandleInput: (data: string) => void, store: ConversationScrollStore): void {
	if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(tui)) return originalHandleInput.call(tui, data);
	if (tui.getTopmostVisibleOverlay?.()) {
		stateFor(tui, store).preferCachedRender = true;
		return originalHandleInput.call(tui, data);
	}

	const state = stateFor(tui, store);
	if (data === "\x03" && selectionRange(state.selection)) {
		const copied = copySelectedHistoryText(state, tui);
		// Drop the selection either way so the next Ctrl+C reaches the native
		// handler (abort/clear) instead of being swallowed by a stale selection.
		clearHistorySelection(state, store);
		tui.requestRender?.();
		if (copied) return;
	}

	const wheel = parseWheel(data);
	if (wheel) {
		const row = wheel.y - 1;
		const view = state.view;
		if (!view || (row >= view.editorTopRow && row < view.editorBottomRow)) {
			state.preferCachedRender = true;
			return originalHandleInput.call(tui, data);
		}
		if (setOffsetFromBottomImmediate(state, store, state.offsetFromBottom + wheel.direction * CONVERSATION_SCROLL_LAYOUT.wheelStepRows, true)) {
			requestCoalescedInteractionRender(tui, state, store, true);
		}
		return;
	}

	const mouse = parseConversationMouse(data);
	if (mouse) {
		if (mouse.action === "press") mouse.clickCount = clickCountForMouse(state, mouse);
		if (handleConversationScrollbarDrag(tui, mouse, store)) return;
		if (handleFooterMouse(tui, mouse, store)) return;
		if (handleRailSectionMouse(tui, mouse, store)) return;
		if (handleConversationSelection(tui, mouse, store)) return;
	}
	if (HISTORY_MUTATING_KEYS.has(data)) {
		state.historyDirty = true;
		state.preferCachedRender = false;
	} else if (shouldPreferHistoryCacheForInput(data)) {
		state.preferCachedRender = true;
	}
	return originalHandleInput.call(tui, data);
}
