import { CONVERSATION_SCROLLBAR_STYLE } from "../../config";
import { clamp, type Position } from "../../core/utils";
import type { ConversationInteractionEffects } from "./interactions";
import type { ConversationMouse } from "./input-intent";
import type { ConversationScrollStore, ScrollAnimation, ScrollState, ScrollView } from "./state";

const SELECTION_AUTO_SCROLL_MS = 80;

const coalescedInteractionRenderTimers = new WeakMap<ScrollState, ReturnType<typeof setTimeout>>();
const coalescedInteractionRenderForces = new WeakMap<ScrollState, boolean>();

function mouseRow(mouse: Pick<ConversationMouse, "y">): number {
	return mouse.y - 1;
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

export function requestCoalescedInteractionRender(
	tui: any,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
	force = false,
): void {
	if (force) coalescedInteractionRenderForces.set(state, true);
	if (coalescedInteractionRenderTimers.has(state)) return;
	const timer = effects.setTimeout(() => {
		store.animationTimers.delete(timer);
		if (coalescedInteractionRenderTimers.get(state) !== timer) return;
		coalescedInteractionRenderTimers.delete(state);
		const shouldForce = coalescedInteractionRenderForces.get(state) === true;
		coalescedInteractionRenderForces.delete(state);
		tui.requestRender?.(shouldForce);
	}, effects.animationFrameMs());
	coalescedInteractionRenderTimers.set(state, timer);
	store.animationTimers.add(timer);
}

export function clearScrollAnimation(
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
): void {
	const timer = state.scrollAnimation?.timer;
	if (timer) {
		effects.clearTimeout(timer);
		store.animationTimers.delete(timer);
	}
	state.scrollAnimation = undefined;
}

export function clearSelectionAutoScroll(
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
): void {
	if (!state.selectionAutoScrollTimer) return;
	effects.clearTimeout(state.selectionAutoScrollTimer);
	store.animationTimers.delete(state.selectionAutoScrollTimer);
	state.selectionAutoScrollTimer = undefined;
}

export function lockScrollStart(state: ScrollState, start: number): void {
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

function scheduleScrollAnimationTick(
	tui: any,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
): void {
	const animation = state.scrollAnimation;
	if (!animation) return;

	const timer = effects.setTimeout(() => {
		store.animationTimers.delete(timer);
		if (state.scrollAnimation?.timer !== timer) return;
		state.scrollAnimation.timer = undefined;
		advanceScrollAnimation(tui, state, store, effects);
	}, effects.animationFrameMs());
	animation.timer = timer;
	store.animationTimers.add(timer);
}

function advanceScrollAnimation(
	tui: any,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
): void {
	const animation = state.scrollAnimation;
	const view = state.view;
	if (!animation || !view) return;

	const maxOffset = Math.max(0, view.lineCount - view.rows);
	const target = clamp(animation.targetOffsetFromBottom, 0, maxOffset);
	const elapsed = effects.now() - animation.startedAt;
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

	scheduleScrollAnimationTick(tui, state, store, effects);
}

export function setOffsetFromBottomImmediate(
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
	offset: number,
	lock = false,
): boolean {
	const view = state.view;
	if (!view) return false;

	clearScrollAnimation(state, store, effects);
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
	effects: ConversationInteractionEffects,
	offset: number,
	options: { targetStart?: number | undefined; lockAtEnd?: boolean | undefined } = {},
): boolean {
	const view = state.view;
	if (!view) return false;

	const maxOffset = Math.max(0, view.lineCount - view.rows);
	const target = clamp(Math.round(offset), 0, maxOffset);
	if (CONVERSATION_SCROLLBAR_STYLE.dragAnimationMs <= 0) {
		const changed = setOffsetFromBottomImmediate(state, store, effects, target, options.lockAtEnd === true);
		if (options.lockAtEnd && options.targetStart !== undefined) lockScrollStart(state, options.targetStart);
		return changed;
	}

	const currentAnimation = state.scrollAnimation;
	if (currentAnimation?.targetOffsetFromBottom === target && currentAnimation.targetStart === options.targetStart) return false;
	if (target === state.offsetFromBottom) {
		clearScrollAnimation(state, store, effects);
		if (options.lockAtEnd && options.targetStart !== undefined) lockScrollStart(state, options.targetStart);
		else if (!options.lockAtEnd) state.lockedStart = undefined;
		return false;
	}

	clearScrollAnimation(state, store, effects);
	state.lockedStart = undefined;
	state.scrollAnimation = {
		startOffsetFromBottom: state.offsetFromBottom,
		targetOffsetFromBottom: target,
		targetStart: options.targetStart,
		lockAtEnd: options.lockAtEnd,
		startedAt: effects.now(),
		durationMs: CONVERSATION_SCROLLBAR_STYLE.dragAnimationMs,
	} satisfies ScrollAnimation;
	scheduleScrollAnimationTick(tui, state, store, effects);
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

function applyScrollbarMouseRow(
	tui: any,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
	row: number,
): boolean {
	const view = state.view;
	const metrics = view?.scrollbar;
	const drag = state.interaction.type === "scrollbarDrag" ? state.interaction : undefined;
	if (!view || !metrics || !drag) return false;

	const clampedRow = clamp(row, 0, Math.max(0, view.rows - 1));
	const start = scrollStartForThumbRow(clampedRow, metrics, drag.pointerOffsetRows);
	return animateOffsetFromBottom(tui, state, store, effects, scrollOffsetFromStart(view, start), { targetStart: start, lockAtEnd: true });
}

export function autoScrollSelectionOnce(
	tui: any,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
	mouse: ConversationMouse,
	normalizePointForSelection: (point: Position) => Position,
): void {
	const view = state.view;
	if (!view || state.interaction.type !== "selecting") return;

	const row = mouseRow(mouse);
	const direction = row <= 0 ? 1 : row >= view.rows ? -1 : 0;
	if (direction === 0) {
		clearSelectionAutoScroll(state, store, effects);
		return;
	}

	if (setOffsetFromBottomImmediate(state, store, effects, state.offsetFromBottom + direction, true)) {
		const maxStart = Math.max(0, view.lineCount - view.rows);
		const nextStart = clamp(view.start - direction, 0, maxStart);
		const line = direction > 0 ? nextStart : Math.min(view.lineCount - 1, nextStart + view.rows - 1);
		const anchor = state.interaction.type === "selecting" ? state.interaction.anchor : undefined;
		state.selection = anchor
			? {
				anchor,
				active: normalizePointForSelection({ line, col: direction > 0 ? 0 : view.width }),
			}
			: state.selection;
		tui.requestRender?.(true);
	}

	if (!state.selectionAutoScrollTimer) {
		const timer = effects.setTimeout(() => {
			store.animationTimers.delete(timer);
			if (state.selectionAutoScrollTimer !== timer) return;
			state.selectionAutoScrollTimer = undefined;
			autoScrollSelectionOnce(tui, state, store, effects, mouse, normalizePointForSelection);
		}, SELECTION_AUTO_SCROLL_MS);
		state.selectionAutoScrollTimer = timer;
		store.animationTimers.add(timer);
	}
}

export function handleConversationScrollbarDrag(
	tui: any,
	mouse: ConversationMouse,
	state: ScrollState,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
	clearHistorySelection: () => boolean,
): boolean {
	if (!CONVERSATION_SCROLLBAR_STYLE.dragEnabled) return false;

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

		const hadSelection = clearHistorySelection();
		const insideThumb = row >= metrics.thumbStart && row < metrics.thumbStart + metrics.thumbSize;
		const pointerOffsetRows = insideThumb ? row - metrics.thumbStart : Math.floor(metrics.thumbSize / 2);
		state.interaction = { type: "scrollbarDrag", pointerOffsetRows: clamp(pointerOffsetRows, 0, Math.max(0, metrics.thumbSize - 1)) };
		if (applyScrollbarMouseRow(tui, state, store, effects, row) || hadSelection) tui.requestRender?.(true);
		return true;
	}

	if (state.interaction.type !== "scrollbarDrag") return false;

	if (mouse.action === "drag") {
		if (applyScrollbarMouseRow(tui, state, store, effects, row)) requestCoalescedInteractionRender(tui, state, store, effects, true);
		return true;
	}

	if (mouse.action === "release") {
		const changed = applyScrollbarMouseRow(tui, state, store, effects, row);
		state.interaction = { type: "idle" };
		if (changed) tui.requestRender?.(true);
		return true;
	}

	return false;
}
