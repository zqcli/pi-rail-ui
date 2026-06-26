import { TUI } from "@earendil-works/pi-tui";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { showFooterSelectionNotice } from "../footer";
import { CONVERSATION_SCROLL_LAYOUT } from "../../config";
import { parseWheel } from "../../core/utils";
import { isInteractiveRoot } from "./history-renderer";
import {
	clearHistorySelection,
	copySelectedHistoryText,
	handleConversationMouseIntent,
	parseConversationMouse,
	rememberClickCount,
} from "./input-intent";
import {
	requestCoalescedInteractionRender,
	setOffsetFromBottomImmediate,
} from "./scroll-interaction";
import { selectionRange, stateFor, type ConversationScrollStore } from "./state";

const HISTORY_MUTATING_KEYS = new Set(["\x0f"]); // Ctrl+O: Pi global expand/collapse may mutate older history blocks.
type InteractionTimer = ReturnType<typeof setTimeout>;

export type ConversationInteractionEffects = {
	copyToClipboard(text: string): Promise<void>;
	showSelectionNotice(tui?: any): void;
	now(): number;
	setTimeout(callback: () => void, ms: number): InteractionTimer;
	clearTimeout(timer: InteractionTimer): void;
	animationFrameMs(): number;
};

const defaultInteractionEffects: ConversationInteractionEffects = {
	copyToClipboard,
	showSelectionNotice: showFooterSelectionNotice,
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (timer) => clearTimeout(timer),
	animationFrameMs: () => Math.max(8, Math.round((TUI as any).MIN_RENDER_INTERVAL_MS ?? 16)),
};

function shouldPreferHistoryCacheForInput(data: string): boolean {
	if (HISTORY_MUTATING_KEYS.has(data)) return false;
	if (data === "\r" || data === "\n" || data === "\r\n") return false;
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code < 32 && data !== "\t") return false;
	}
	return true;
}

export function handleConversationInputWithEffects(
	tui: any,
	data: string,
	originalHandleInput: (data: string) => void,
	store: ConversationScrollStore,
	effects: ConversationInteractionEffects,
): void {
	if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(tui)) return originalHandleInput.call(tui, data);
	if (tui.getTopmostVisibleOverlay?.()) {
		stateFor(tui, store).preferCachedRender = true;
		return originalHandleInput.call(tui, data);
	}

	const state = stateFor(tui, store);
	if (data === "\x03" && selectionRange(state.selection)) {
		const copied = copySelectedHistoryText(state, tui, effects);
		// Drop the selection either way so the next Ctrl+C reaches the native
		// handler (abort/clear) instead of being swallowed by a stale selection.
		clearHistorySelection(state, store, effects);
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
		if (setOffsetFromBottomImmediate(state, store, effects, state.offsetFromBottom + wheel.direction * CONVERSATION_SCROLL_LAYOUT.wheelStepRows, true)) {
			requestCoalescedInteractionRender(tui, state, store, effects, true);
		}
		return;
	}

	const mouse = parseConversationMouse(data);
	if (mouse) {
		rememberClickCount(state, mouse, effects);
		if (handleConversationMouseIntent(tui, mouse, state, store, effects)) return;
	}
	if (HISTORY_MUTATING_KEYS.has(data)) {
		state.historyDirty = true;
		state.preferCachedRender = false;
	} else if (shouldPreferHistoryCacheForInput(data)) {
		state.preferCachedRender = true;
	}
	return originalHandleInput.call(tui, data);
}

export function handleConversationInput(tui: any, data: string, originalHandleInput: (data: string) => void, store: ConversationScrollStore): void {
	return handleConversationInputWithEffects(tui, data, originalHandleInput, store, defaultInteractionEffects);
}
