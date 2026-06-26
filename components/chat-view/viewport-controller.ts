import { appLeftGutterWidth, CONVERSATION_SCROLL_LAYOUT } from "../../config";
import { getRenderedSections, isInteractiveRoot } from "./history-renderer";
import { handleConversationInput } from "./interactions";
import { composeConversationViewportFrame } from "./viewport-frame";
import {
	getConversationScrollStore,
	stateFor,
	type ConversationScrollStore,
} from "./state";

const CLEAR_SCREEN_AND_SCROLLBACK = "\x1b[H\x1b[2J\x1b[3J";
// Keep wheel input in the alternate screen instead of letting the terminal
// scroll its native viewport, which would move the fixed editor/footer away.
const ENABLE_ALT_SCROLL_MODE = "\x1b[?1007h";
const DISABLE_ALT_SCROLL_MODE = "\x1b[?1007l";
const ENTER_ALT_SCREEN = `\x1b[?1049h${ENABLE_ALT_SCROLL_MODE}${CLEAR_SCREEN_AND_SCROLLBACK}`;
const EXIT_ALT_SCREEN = `${DISABLE_ALT_SCROLL_MODE}\x1b[?1049l`;

type ResetOptions = {
	clearOnNextOverflowRender?: boolean | undefined;
};

function writeTerminalControl(sequence: string): void {
	if (process.stdout.isTTY) process.stdout.write(sequence);
}

function requestFullRenderAfterScreenClear(tui: any | undefined): void {
	if (typeof tui?.requestRender === "function") tui.requestRender(true);
}

function fitToTerminalRows(lines: string[], terminalRows: number): string[] {
	return lines.length > terminalRows ? lines.slice(lines.length - terminalRows) : lines;
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

export class ConversationViewportController {
	constructor(private readonly store: ConversationScrollStore = getConversationScrollStore()) {}

	ensureAlternateScreen(tui?: any): void {
		if (!CONVERSATION_SCROLL_LAYOUT.enabled || !CONVERSATION_SCROLL_LAYOUT.alternateScreen) return;
		if (this.store.alternateScreenActive) return;
		writeTerminalControl(ENTER_ALT_SCREEN);
		this.store.alternateScreenActive = true;
		requestFullRenderAfterScreenClear(tui);
	}

	releaseAlternateScreen(): void {
		if (!this.store.alternateScreenActive) return;
		writeTerminalControl(EXIT_ALT_SCREEN);
		this.store.alternateScreenActive = false;
	}

	render(tui: any, width: number, originalRender: (width: number) => string[]): string[] {
		if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(tui)) return originalRender.call(tui, width);

		try {
			const children = tui.children as any[];
			const state = stateFor(tui, this.store);
			const leftGutterWidth = appLeftGutterWidth(width);
			const contentWidth = Math.max(1, width - leftGutterWidth);
			const sections = getRenderedSections(children, contentWidth, state);
			const terminalRows = Math.max(1, tui.terminal?.rows ?? 24);
			const frame = composeConversationViewportFrame({
				sections,
				state,
				width,
				terminalRows,
				leftGutterWidth,
			});
			if (frame.shouldClearViewportMemory) this.clearViewportRenderMemory(tui);
			this.clearBeforeOverflowRender(tui, frame.historyOverflow);
			return frame.rows;
		} catch {
			const terminalRows = Math.max(1, tui.terminal?.rows ?? 24);
			return fitToTerminalRows(originalRender.call(tui, width), terminalRows);
		}
	}

	handleInput(tui: any, data: string, originalHandleInput: (data: string) => void): void {
		return handleConversationInput(tui, data, originalHandleInput, this.store);
	}

	reset(options: ResetOptions = {}): void {
		for (const timer of this.store.animationTimers) clearTimeout(timer);
		this.store.animationTimers.clear();
		this.store.states = new WeakMap<object, any>();
		this.store.clearOnNextOverflowRender = options.clearOnNextOverflowRender === true;
	}

	resetAfterInitialMessages(tui: any): void {
		if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(tui)) return;
		this.reset({ clearOnNextOverflowRender: true });
		tui.requestRender?.(true);
	}

	private clearBeforeOverflowRender(tui: any, hasOverflow: boolean): void {
		if (!hasOverflow || !this.store.clearOnNextOverflowRender) return;
		this.store.clearOnNextOverflowRender = false;
		writeTerminalControl(CLEAR_SCREEN_AND_SCROLLBACK);
		resetTuiRenderMemory(tui);
	}

	private clearViewportRenderMemory(tui: any): void {
		writeTerminalControl(CLEAR_SCREEN_AND_SCROLLBACK);
		resetTuiRenderMemory(tui);
	}
}

export const conversationViewportController = new ConversationViewportController();
