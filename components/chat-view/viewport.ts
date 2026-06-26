import { TUI } from "@earendil-works/pi-tui";
import { appLeftGutterWidth, CONVERSATION_SCROLL_LAYOUT } from "../../config";
import { getInteractiveModeConstructors, resolveNativeTuiExport, restorePrototypePatches } from "../../core/patching";
import { getRenderedSections, isInteractiveRoot } from "./history-renderer";
import { handleConversationInput } from "./interactions";
import { composeConversationViewportFrame } from "./viewport-frame";
import {
	getConversationScrollStore,
	stateFor,
	type ConversationScrollStore,
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

function writeTerminalControl(sequence: string): void {
	if (process.stdout.isTTY) process.stdout.write(sequence);
}

function requestFullRenderAfterScreenClear(tui: any | undefined): void {
	if (typeof tui?.requestRender === "function") tui.requestRender(true);
}

function withGlobalLeftGutterOverlayOptions(options: any, width: number): any {
	const gutter = appLeftGutterWidth(width);
	if (gutter <= 0) return options;

	const rawMargin = options?.margin;
	const margin = typeof rawMargin === "number"
		? { top: rawMargin, right: rawMargin, bottom: rawMargin, left: rawMargin }
		: { ...(rawMargin ?? {}) };
	margin.left = Math.max(0, Math.round(margin.left ?? 0)) + gutter;
	return { ...(options ?? {}), margin };
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

function clearViewportRenderMemory(tui: any): void {
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

function fitToTerminalRows(lines: string[], terminalRows: number): string[] {
	return lines.length > terminalRows ? lines.slice(lines.length - terminalRows) : lines;
}

function renderStickyConversation(tui: any, width: number, originalRender: (width: number) => string[], store: ConversationScrollStore): string[] {
	if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(tui)) return originalRender.call(tui, width);

	try {
		const children = tui.children as any[];
		const state = stateFor(tui, store);
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
		if (frame.shouldClearViewportMemory) clearViewportRenderMemory(tui);
		clearBeforeOverflowRender(tui, store, frame.historyOverflow);
		return frame.rows;
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

	if (!store.targets.some((target) => target.ctor === ctor && target.methodName === "showOverlay")) {
		const originalShowOverlay = ctor.prototype.showOverlay;
		ctor.prototype.showOverlay = function patchedGlobalGutterOverlay(this: any, component: any, options?: any) {
			if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(this)) return originalShowOverlay.call(this, component, options);
			return originalShowOverlay.call(this, component, withGlobalLeftGutterOverlayOptions(options, this.terminal?.columns ?? 80));
		};
		store.targets.push({ ctor, methodName: "showOverlay", original: originalShowOverlay });
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
