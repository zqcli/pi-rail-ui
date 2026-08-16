import { CURSOR_MARKER, compositeTuiLine, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { CONVERSATION_SCROLLBAR_STYLE, RAIL_EDITOR_STYLE } from "../config";
import { createPatchLifecycle, resolveNativeTuiExport } from "../core/patching";
import { isRailUiActive } from "./rail-section";

const RAIL_SCROLLBAR_MARKED_KEY = Symbol.for("pi-rail-ui.rail-scrollbar-marked");
const RAIL_SCROLLBAR_ORIGINAL_KEY = Symbol.for("pi-rail-ui.rail-scrollbar-original");
const RAIL_SCROLLBAR_ORIGINAL_STYLE_KEY = Symbol.for("pi-rail-ui.rail-scrollbar-original-style");
const RAIL_SCROLLBAR_STYLE_PRESENT_KEY = Symbol.for("pi-rail-ui.rail-scrollbar-style-present");
const RAIL_DRAG_IDLE_MS = 1000;
const FOCUS_OUT = "\x1b[O";

const scrollbarLifecycle = createPatchLifecycle("rail-scrollbar-patch", () => ({}));
const markedScrollViews = new Set<any>();
const railFrames = new WeakMap<object, RailScrollbarFrame>();
const railDrags = new WeakMap<object, RailScrollbarDrag>();
const activeDrags = new Set<RailScrollbarDrag>();

export type RailScrollbarGeometry = {
	column: number;
	trackTop: number;
	trackHeight: number;
	thumbTop: number;
	thumbHeight: number;
	maxThumbStart: number;
	maxScrollTop: number;
};

type RailScrollbarFrame = {
	scrollView: any;
	geometry: RailScrollbarGeometry;
	baseScreen: string[];
	terminalWidth: number;
};

type RailScrollbarDrag = {
	tui: any;
	scrollView: any;
	geometry: RailScrollbarGeometry;
	frame: RailScrollbarFrame | undefined;
	grabOffset: number;
	pendingY: number;
	pendingScrollTop: number;
	previewThumbTop: number;
	lastEventAt: number;
	previewHandle: ReturnType<typeof setImmediate> | undefined;
	idleHandle: ReturnType<typeof setTimeout> | undefined;
};

function foregroundFromBackgroundAnsi(ansi: string): string {
	return ansi.replace(/\x1b\[48([;:])/g, "\x1b[38$1");
}

let cachedThumbCell: string | undefined;
function thumbCell(): string {
	if (cachedThumbCell !== undefined) return cachedThumbCell;
	const color = foregroundFromBackgroundAnsi(CONVERSATION_SCROLLBAR_STYLE.thumbBackground) || RAIL_EDITOR_STYLE.rail;
	const width = Math.max(1, Math.round(CONVERSATION_SCROLLBAR_STYLE.width));
	cachedThumbCell = `${color}${"█".repeat(width)}${CONVERSATION_SCROLLBAR_STYLE.reset}`;
	return cachedThumbCell;
}

function isPlainAscii(line: string): boolean {
	for (let index = 0; index < line.length; index++) {
		const code = line.charCodeAt(index);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

/** Paint one Rail thumb row without touching Pi's layout or renderer. */
function styleRailThumbCell(line: string, column: number, barWidth: number, totalWidth: number): string {
	const cell = thumbCell();
	if (!line) return `${" ".repeat(Math.max(0, column))}${cell}`;
	if (line.indexOf("\x1b") === -1 && isPlainAscii(line)) {
		return `${line.slice(0, column).padEnd(column, " ")}${cell}${line.slice(column + barWidth)}`;
	}
	return compositeTuiLine(line, cell, column, barWidth, totalWidth);
}

function findScrollBox(root: any, scrollView: any): any | undefined {
	if (!root) return undefined;
	if (root.scrollView === scrollView) return root;
	for (const child of root.children ?? []) {
		const match = findScrollBox(child, scrollView);
		if (match) return match;
	}
	return undefined;
}

function scrollTopOf(scrollView: any): number {
	const value = Number(scrollView?.scrollTop ?? scrollView?.currentScrollTop ?? 0);
	return Number.isFinite(value) ? value : 0;
}

export function railScrollbarGeometry(layout: any, scrollView: any): RailScrollbarGeometry | undefined {
	const box = findScrollBox(layout?.root, scrollView);
	if (!box) return undefined;

	const trackTop = Math.max(0, Math.floor(box.rect?.y ?? 0));
	const trackHeight = Math.max(0, Math.floor(box.rect?.height ?? 0));
	const contentHeight = Math.max(
		0,
		Math.floor(box.children?.[0]?.rect?.height ?? box.scrollContentLines?.length ?? 0),
	);
	if (trackHeight <= 0 || contentHeight <= trackHeight) return undefined;

	const column = Math.floor((box.rect?.x ?? 0) + (box.rect?.width ?? 0) - 1);
	if (column < 0) return undefined;
	const thumbHeight = Math.max(2, Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)));
	const maxThumbStart = Math.max(0, trackHeight - thumbHeight);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const thumbStart = maxScrollTop === 0
		? 0
		: Math.round((scrollTopOf(scrollView) / maxScrollTop) * maxThumbStart);

	return {
		column,
		trackTop,
		trackHeight,
		thumbTop: trackTop + Math.max(0, Math.min(maxThumbStart, thumbStart)),
		thumbHeight,
		maxThumbStart,
		maxScrollTop,
	};
}

/**
 * Draw the legacy Rail thumb. The native scrollbar is hidden, but Pi's
 * layout/viewport remains the owner of normal scrolling and selection.
 */
export function drawRailScrollbar(screen: string[], layout: any, terminalColumns: number): string[] {
	const scrollView = layout?.primaryScrollView;
	if (!isRailScrollbarView(scrollView) || CONVERSATION_SCROLLBAR_STYLE.visible === false) return screen;
	const geometry = railScrollbarGeometry(layout, scrollView);
	if (!geometry || geometry.column >= terminalColumns) return screen;
	const barWidth = Math.max(1, Math.round(CONVERSATION_SCROLLBAR_STYLE.width));

	for (
		let row = Math.max(0, geometry.thumbTop);
		row < Math.min(screen.length, geometry.thumbTop + geometry.thumbHeight);
		row++
	) {
		screen[row] = styleRailThumbCell(screen[row] ?? "", geometry.column, barWidth, terminalColumns);
	}
	return screen;
}

function captureRailFrame(tui: any, screenBeforeThumb: string[], screenAfterThumb: string[], layout: any, scrollView: any): void {
	const geometry = railScrollbarGeometry(layout, scrollView);
	if (!geometry) {
		railFrames.delete(tui);
		return;
	}
	railFrames.set(tui, {
		scrollView,
		geometry,
		baseScreen: screenBeforeThumb.slice(),
		terminalWidth: tui.terminal?.columns ?? screenAfterThumb.length,
	});
}

export function markRailScrollbarView(scrollView: any): void {
	if (!scrollView || scrollView[RAIL_SCROLLBAR_MARKED_KEY] === true) return;
	scrollView[RAIL_SCROLLBAR_MARKED_KEY] = true;
	scrollView[RAIL_SCROLLBAR_ORIGINAL_KEY] = scrollView.currentScrollbar;
	scrollView[RAIL_SCROLLBAR_STYLE_PRESENT_KEY] = "scrollbarStyle" in scrollView;
	scrollView[RAIL_SCROLLBAR_ORIGINAL_STYLE_KEY] = scrollView.scrollbarStyle;
	markedScrollViews.add(scrollView);

	// Keep the native ScrollView only as a state holder. Its paint path and
	// transient scrollbar timers are unnecessary while Rail owns the visual bar.
	if (typeof scrollView.scrollbarStyle === "function") scrollView.scrollbarStyle = (text: string) => text;
	if (scrollView.currentScrollbar !== "hidden") scrollView.setScrollbar?.("hidden");
}

export function isRailScrollbarView(scrollView: any): boolean {
	return scrollView?.[RAIL_SCROLLBAR_MARKED_KEY] === true;
}

function clearNativeSelection(tui: any): void {
	tui.stopSelectionAutoScroll?.();
	tui.selectionPressActive = false;
	tui.selectionAnchor = undefined;
	tui.selectionFocus = undefined;
	tui.selectionGranularity = "character";
	tui.selectionInitialRange = undefined;
	tui.lastClick = undefined;
	tui.pressedUrl = undefined;
	tui.selectionDragged = false;
}

function cancelPendingRender(tui: any): void {
	tui.cancelRenderTimer?.();
	tui.renderRequested = false;
	tui.immediateRenderScheduled = false;
}

function requestFinalRender(tui: any): void {
	cancelPendingRender(tui);
	if (typeof tui.requestImmediateRender === "function") tui.requestImmediateRender();
	else tui.requestRender?.(true);
}

function setScrollTopDirect(scrollView: any, value: number, maxScrollTop: number): boolean {
	const next = Math.max(0, Math.min(maxScrollTop, Math.round(value)));
	const current = scrollTopOf(scrollView);
	if (typeof scrollView.currentScrollTop !== "number") {
		if (typeof scrollView.scrollTo !== "function") return false;
		scrollView.scrollTo(next);
		return next !== current;
	}

	const followsEnd = Boolean(scrollView.followEnd && next === maxScrollTop);
	const changed = next !== current ||
		("followingEnd" in scrollView && scrollView.followingEnd !== followsEnd) ||
		("followSuppressedAtEnd" in scrollView && scrollView.followSuppressedAtEnd !== false);
	if (!changed) return false;

	scrollView.currentScrollTop = next;
	if ("followingEnd" in scrollView) scrollView.followingEnd = followsEnd;
	if ("followSuppressedAtEnd" in scrollView) scrollView.followSuppressedAtEnd = false;
	return true;
}

function mappedDragPosition(state: RailScrollbarDrag, pointerY: number): { thumbTop: number; scrollTop: number } {
	const offset = Math.max(
		0,
		Math.min(state.geometry.maxThumbStart, pointerY - state.geometry.trackTop - state.grabOffset),
	);
	return {
		thumbTop: state.geometry.trackTop + offset,
		scrollTop: state.geometry.maxThumbStart === 0
			? 0
			: Math.round((offset / state.geometry.maxThumbStart) * state.geometry.maxScrollTop),
	};
}

function isImageLineLike(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

function previewLine(line: string, active: boolean, state: RailScrollbarDrag): string {
	const clean = line.replaceAll(CURSOR_MARKER, "");
	const rendered = active
		? styleRailThumbCell(clean, state.geometry.column, Math.max(1, Math.round(CONVERSATION_SCROLLBAR_STYLE.width)), state.frame?.terminalWidth ?? 0)
		: clean;
	return visibleWidth(rendered) > (state.frame?.terminalWidth ?? 0)
		? sliceByColumn(rendered, 0, state.frame?.terminalWidth ?? 0, true)
		: rendered;
}

function writeThumbPreview(state: RailScrollbarDrag, nextThumbTop: number): void {
	const frame = state.frame;
	const terminal = state.tui.terminal;
	if (!frame || !terminal || typeof terminal.write !== "function") return;
	if (nextThumbTop === state.previewThumbTop) return;

	const oldTop = state.previewThumbTop;
	const newTop = nextThumbTop;
	const start = Math.max(0, Math.min(oldTop, newTop));
	const end = Math.min(
		frame.baseScreen.length,
		Math.max(oldTop + state.geometry.thumbHeight, newTop + state.geometry.thumbHeight),
	);
	const parts = ["\x1b[?2026h", "\x1b[s"];
	let changed = false;
	for (let row = start; row < end; row++) {
		const wasActive = row >= oldTop && row < oldTop + state.geometry.thumbHeight;
		const isActive = row >= newTop && row < newTop + state.geometry.thumbHeight;
		if (wasActive === isActive) continue;
		const base = frame.baseScreen[row] ?? "";
		if (isImageLineLike(base)) continue;
		const line = previewLine(base, isActive, state);
		parts.push(`\x1b[${row + 1};1H\x1b[2K${line}\x1b[0m`);
		changed = true;
	}
	if (!changed) {
		state.previewThumbTop = newTop;
		return;
	}
	parts.push("\x1b[u", "\x1b[?2026l");
	terminal.write(parts.join(""));
	state.previewThumbTop = newTop;
}

function flushDragPreview(state: RailScrollbarDrag): void {
	const mapped = mappedDragPosition(state, state.pendingY);
	state.pendingScrollTop = mapped.scrollTop;
	writeThumbPreview(state, mapped.thumbTop);
}

function scheduleDragPreview(state: RailScrollbarDrag): void {
	if (state.previewHandle !== undefined) return;
	state.previewHandle = setImmediate(() => {
		state.previewHandle = undefined;
		if (railDrags.get(state.tui) !== state) return;
		flushDragPreview(state);
	});
	state.previewHandle.unref?.();
}

function scheduleDragIdleCheck(state: RailScrollbarDrag): void {
	if (state.idleHandle !== undefined) return;
	state.idleHandle = setTimeout(() => {
		state.idleHandle = undefined;
		if (railDrags.get(state.tui) !== state) return;
		const remaining = RAIL_DRAG_IDLE_MS - (Date.now() - state.lastEventAt);
		if (remaining > 0) {
			scheduleDragIdleCheck(state);
			return;
		}
		finishRailScrollbarDrag(state.tui, state.pendingY);
	}, RAIL_DRAG_IDLE_MS);
	state.idleHandle.unref?.();
}

function touchRailScrollbarDrag(state: RailScrollbarDrag, pointerY: number): void {
	state.pendingY = pointerY;
	state.lastEventAt = Date.now();
	scheduleDragPreview(state);
}

function finishRailScrollbarDrag(tui: any, pointerY: number): void {
	const state = railDrags.get(tui);
	if (!state) return;
	state.pendingY = pointerY;
	if (state.previewHandle !== undefined) {
		clearImmediate(state.previewHandle);
		state.previewHandle = undefined;
	}
	flushDragPreview(state);
	if (state.idleHandle !== undefined) {
		clearTimeout(state.idleHandle);
		state.idleHandle = undefined;
	}

	setScrollTopDirect(state.scrollView, state.pendingScrollTop, state.geometry.maxScrollTop);
	if (tui.scrollbarDrag === state) tui.scrollbarDrag = undefined;
	railDrags.delete(tui);
	activeDrags.delete(state);
	requestFinalRender(tui);
}

function resetActiveDrags(): void {
	for (const state of activeDrags) {
		if (state.previewHandle !== undefined) clearImmediate(state.previewHandle);
		if (state.idleHandle !== undefined) clearTimeout(state.idleHandle);
		if (state.tui.scrollbarDrag === state) state.tui.scrollbarDrag = undefined;
		railDrags.delete(state.tui);
	}
	activeDrags.clear();
}

function railScrollbarTargetAt(tui: any, x: number, y: number): { scrollView: any; geometry: RailScrollbarGeometry } | undefined {
	if (tui.hasOverlay?.() || tui.getTopmostVisibleOverlay?.()) return undefined;
	const layout = tui.currentLayout;
	const scrollView = layout?.primaryScrollView;
	if (!scrollView || scrollView.primary !== true || !isRailScrollbarView(scrollView)) return undefined;
	const geometry = railScrollbarGeometry(layout, scrollView);
	if (!geometry || x !== geometry.column) return undefined;
	if (y < geometry.thumbTop || y >= geometry.thumbTop + geometry.thumbHeight) return undefined;
	return { scrollView, geometry };
}

function beginRailScrollbarDrag(tui: any, target: { scrollView: any; geometry: RailScrollbarGeometry }, pointerY: number): void {
	const frame = railFrames.get(tui);
	const state: RailScrollbarDrag = {
		tui,
		scrollView: target.scrollView,
		geometry: target.geometry,
		frame,
		grabOffset: pointerY - target.geometry.thumbTop,
		pendingY: pointerY,
		pendingScrollTop: scrollTopOf(target.scrollView),
		previewThumbTop: target.geometry.thumbTop,
		lastEventAt: Date.now(),
		previewHandle: undefined,
		idleHandle: undefined,
	};
	railDrags.set(tui, state);
	activeDrags.add(state);
	// Stop a render that was queued just before the press. The next render is
	// intentionally requested only by finishRailScrollbarDrag.
	cancelPendingRender(tui);
	clearNativeSelection(tui);
	tui.stopScrollbarHover?.();
	// The viewport input path skips its native hover lookup while this marker is
	// present; the custom handler owns all subsequent motion/release events.
	tui.scrollbarDrag = state;
	scheduleDragIdleCheck(state);
}

type AltScreenConstructor = {
	prototype: {
		applySelection(screen: string[], layout?: any): string[];
	};
};

export async function installRailScrollbar(): Promise<void> {
	scrollbarLifecycle.activate();
	const ctor = await resolveNativeTuiExport<AltScreenConstructor>("TuiAltScreen");
	scrollbarLifecycle.patchMethod(ctor, "applySelection", (original) => function patchedApplySelection(
		this: any,
		screen: string[],
		layout: any,
	): string[] {
		const scrollView = layout?.primaryScrollView;
		if (scrollView && scrollView.primary === true && isRailUiActive()) markRailScrollbarView(scrollView);
		const result = original.call(this, screen, layout);
		if (!scrollbarLifecycle.state().active || !isRailUiActive()) return result;
		if (!scrollView || scrollView.primary !== true) return result;
		try {
			const base = result.slice();
			const drawn = drawRailScrollbar(result, layout, this.terminal?.columns ?? 0);
			captureRailFrame(this, base, drawn, layout, scrollView);
			return drawn;
		} catch {
			return result;
		}
	});
	scrollbarLifecycle.patchMethod(ctor, "handleScrollbarMouseEvent", (original) => function patchedScrollbarMouseEvent(
		this: any,
		event: any,
	): boolean {
		const active = railDrags.get(this);
		if (active) {
			if (event.release) {
				finishRailScrollbarDrag(this, event.y);
				return true;
			}
			if ((event.button & 3) === 0) {
				touchRailScrollbarDrag(active, event.y);
				return true;
			}
			return true;
		}

		if (
			CONVERSATION_SCROLLBAR_STYLE.visible !== false &&
			CONVERSATION_SCROLLBAR_STYLE.dragEnabled !== false &&
			!event.release &&
			(event.button & 32) === 0 &&
			(event.button & 3) === 0
		) {
			const target = railScrollbarTargetAt(this, event.x, event.y);
			if (target) {
				beginRailScrollbarDrag(this, target, event.y);
				return true;
			}
		}
		return original.call(this, event);
	});
	scrollbarLifecycle.patchMethod(ctor, "requestRender", (original) => function patchedRequestRender(this: any, ...args: any[]): void {
		if (railDrags.has(this)) return;
		return original.apply(this, args);
	});
	scrollbarLifecycle.patchMethod(ctor, "doRender", (original) => function patchedDoRender(this: any, ...args: any[]): void {
		if (railDrags.has(this)) return;
		return original.apply(this, args);
	});
	scrollbarLifecycle.patchMethod(ctor, "handleViewportInput", (original) => function patchedViewportInput(this: any, ...args: any[]): any {
		const active = railDrags.get(this);
		const result = original.apply(this, args);
		if (active && args[0] === FOCUS_OUT && railDrags.get(this) === active) {
			finishRailScrollbarDrag(this, active.pendingY);
		}
		return result;
	});
}

export function uninstallRailScrollbar(): void {
	scrollbarLifecycle.deactivate();
	resetActiveDrags();
	for (const scrollView of markedScrollViews) {
		const original = scrollView[RAIL_SCROLLBAR_ORIGINAL_KEY];
		if (original !== undefined) scrollView.setScrollbar?.(original);
		const hadStyle = scrollView[RAIL_SCROLLBAR_STYLE_PRESENT_KEY] === true;
		const originalStyle = scrollView[RAIL_SCROLLBAR_ORIGINAL_STYLE_KEY];
		if (hadStyle) scrollView.scrollbarStyle = originalStyle;
		else delete scrollView.scrollbarStyle;
		scrollView.hideTransientScrollbar?.();
		delete scrollView[RAIL_SCROLLBAR_MARKED_KEY];
		delete scrollView[RAIL_SCROLLBAR_ORIGINAL_KEY];
		delete scrollView[RAIL_SCROLLBAR_ORIGINAL_STYLE_KEY];
		delete scrollView[RAIL_SCROLLBAR_STYLE_PRESENT_KEY];
	}
	markedScrollViews.clear();
}
