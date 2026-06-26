import {
	canToggleRailSection,
	normalizeRailSectionPosition,
	sameRailSection,
	toggleRailSection,
	type RailSectionRange,
} from "../../rail/rail-section";
import { SGR_MOUSE_RE, clamp, comparePosition, stripAnsi, type Position } from "../../core/utils";
import {
	lineSelectionAt,
	selectedHistoryText,
	wordSelectionAt,
} from "./history-selection";
import {
	autoScrollSelectionOnce,
	clearScrollAnimation,
	clearSelectionAutoScroll,
	handleConversationScrollbarDrag,
	lockScrollStart,
	requestCoalescedInteractionRender,
} from "./scroll-interaction";
import { selectionRange, type ActiveInteraction, type ConversationScrollStore, type ScrollState, type ScrollView } from "./state";
import type { ConversationInteractionEffects } from "./interactions";

const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_MAX_DISTANCE = 1;
const SELECTION_INCLUSIVE_COLUMN_BIAS = 2;

export type ConversationMouse = { x: number; y: number; action: "press" | "drag" | "release" | "copy"; clickCount?: number };
type ClickMemory = { x: number; y: number; at: number; count: number };

const clickMemory = new WeakMap<ScrollState, ClickMemory>();

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

export function copySelectedHistoryText(state: ScrollState, tui: any | undefined, effects: ConversationInteractionEffects): boolean {
	const text = selectedHistoryText(state, (line) => railSectionRangeAtLine(state, line));
	if (!text) return false;
	void effects.copyToClipboard(text).then(
		() => effects.showSelectionNotice(tui),
		() => {
			// Stay silent on clipboard failure.
		},
	);
	return true;
}

export function clearHistorySelection(state: ScrollState, store: ConversationScrollStore, effects: ConversationInteractionEffects): boolean {
	const hadSelection = Boolean(state.selection || state.interaction.type === "selecting");
	clearSelectionAutoScroll(state, store, effects);
	state.selection = undefined;
	state.interaction = { type: "idle" };
	state.preferCachedRender = true;
	return hadSelection;
}

export function parseConversationMouse(data: string): ConversationMouse | undefined {
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

export function rememberClickCount(state: ScrollState, mouse: ConversationMouse, effects: ConversationInteractionEffects): void {
	if (mouse.action !== "press") return;
	const now = effects.now();
	const previous = clickMemory.get(state);
	const sameClickTarget = previous
		&& Math.abs(previous.x - mouse.x) <= DOUBLE_CLICK_MAX_DISTANCE
		&& previous.y === mouse.y
		&& now - previous.at <= DOUBLE_CLICK_MS;
	const count = sameClickTarget ? Math.min(3, previous.count + 1) : 1;
	clickMemory.set(state, { x: mouse.x, y: mouse.y, at: now, count });
	mouse.clickCount = count;
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

function applyClickSelection(
	tui: any,
	state: ScrollState,
	pos: Position,
	clickCount: number,
	effects: ConversationInteractionEffects,
): boolean {
	if (clickCount < 2) return false;
	const selection = clickCount >= 3
		? lineSelectionAt(state, pos, (point) => normalizePointForSelection(state, point))
		: wordSelectionAt(state, pos, (point) => normalizePointForSelection(state, point));
	if (!selection) return false;
	state.selection = selection;
	state.interaction = { type: "idle" };
	state.preferCachedRender = true;
	copySelectedHistoryText(state, tui, effects);
	tui.requestRender?.();
	return true;
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
	effects: ConversationInteractionEffects,
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
	else if (range && !selecting) copySelectedHistoryText(state, tui, effects);
	if (!selecting) clearSelectionAutoScroll(state, store, effects);
	state.preferCachedRender = true;
	if (selecting) requestCoalescedInteractionRender(tui, state, store, effects);
	else tui.requestRender?.();
	return true;
}

function handleRailSectionMouse(
	tui: any,
	mouse: ConversationMouse,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
): boolean {
	if (mouse.action === "copy") return false;

	if (mouse.action === "press") {
		const range = railSectionRangeAtMouse(state, mouse, true);
		if (!range) return false;
		if (mouse.clickCount && mouse.clickCount >= 2 && !canToggleRailSection(range.section)) return false;

		const hadSelection = clearHistorySelection(state, store, effects);
		clearScrollAnimation(state, store, effects);
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
			setRailSectionSelectionFromMouse(tui, state, store, effects, pending, mouse, true);
		}
		return true;
	}

	if (mouse.action === "release") {
		state.interaction = { type: "idle" };
		if (pending.moved || mouseMovedFrom(pending, mouse)) {
			setRailSectionSelectionFromMouse(tui, state, store, effects, pending, mouse, false);
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

function handleFooterMouse(
	tui: any,
	mouse: ConversationMouse,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
): boolean {
	if (mouse.action === "copy") return false;

	const view = state.view;
	if (!view) {
		if (mouse.action === "release" && state.interaction.type === "footerClick") state.interaction = { type: "idle" };
		return false;
	}

	if (mouse.action === "press") {
		if (!isOnFooter(view, mouse)) return false;
		const hadSelection = clearHistorySelection(state, store, effects);
		clearScrollAnimation(state, store, effects);
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
		return true;
	}

	return false;
}

function handleConversationSelection(
	tui: any,
	mouse: ConversationMouse,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
): boolean {
	const view = state.view;
	if (!view) return false;

	const row = mouseRow(mouse);
	const startsInHistory = row >= 0 && row < view.rows;
	if (mouse.action === "copy") {
		return startsInHistory && copySelectedHistoryText(state, tui, effects);
	}
	if (mouse.action === "press" && !startsInHistory) {
		if (clearHistorySelection(state, store, effects)) tui.requestRender?.();
		return false;
	}
	if (mouse.action !== "press" && state.interaction.type !== "selecting") return false;

	if (mouse.action === "press") {
		const pos = pointForMouse(state, mouse);
		if (!pos) return false;
		const clickCount = mouse.clickCount ?? 1;
		if (clickCount >= 2 && applyClickSelection(tui, state, pos, clickCount, effects)) return true;
		const hadSelection = clearHistorySelection(state, store, effects);
		clearScrollAnimation(state, store, effects);
		lockScrollStart(state, view.start);
		state.interaction = { type: "selecting", x: mouse.x, y: mouse.y, moved: false, anchor: pos };
		state.selection = undefined;
		if (hadSelection) tui.requestRender?.();
	} else if (mouse.action === "drag") {
		const pending = state.interaction.type === "selecting" ? state.interaction : undefined;
		if (!pending) return false;
		const selection = inclusiveSelectionForMouse(state, pending.anchor, mouse);
		if (!selection) return false;
		const moved = pending.moved || mouseMovedFrom(pending, mouse);
		state.interaction = { type: "selecting", x: mouse.x, y: mouse.y, moved, anchor: pending.anchor };
		state.selection = moved ? selection : undefined;
		autoScrollSelectionOnce(tui, state, store, effects, mouse, (point) => normalizePointForSelection(state, point));
	} else {
		const pending = state.interaction.type === "selecting" ? state.interaction : undefined;
		if (!pending) return false;
		const selection = inclusiveSelectionForMouse(state, pending.anchor, mouse);
		if (!selection) return false;
		const moved = pending.moved || mouseMovedFrom(pending, mouse);
		if (moved) state.selection = selection;
		state.interaction = { type: "idle" };
		clearSelectionAutoScroll(state, store, effects);
		if (!moved || !selectionRange(state.selection)) state.selection = undefined;
		else copySelectedHistoryText(state, tui, effects);
	}

	state.preferCachedRender = true;
	if (mouse.action === "drag") requestCoalescedInteractionRender(tui, state, store, effects);
	else tui.requestRender?.();
	return true;
}

export function handleConversationMouseIntent(
	tui: any,
	mouse: ConversationMouse,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
): boolean {
	if (handleConversationScrollbarDrag(tui, mouse, state, store, effects, () => clearHistorySelection(state, store, effects))) return true;
	if (handleFooterMouse(tui, mouse, state, store, effects)) return true;
	if (handleRailSectionMouse(tui, mouse, state, store, effects)) return true;
	return handleConversationSelection(tui, mouse, state, store, effects);
}
