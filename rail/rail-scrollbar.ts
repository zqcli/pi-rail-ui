import { compositeTuiLine } from "@earendil-works/pi-tui";
import { CONVERSATION_SCROLLBAR_STYLE, RAIL_EDITOR_STYLE } from "../config";
import { createPatchLifecycle, resolveNativeTuiExport } from "../core/patching";
import { isRailUiActive } from "./rail-section";

const RAIL_SCROLLBAR_MARKED_KEY = Symbol.for("pi-rail-ui.rail-scrollbar-marked");
const RAIL_SCROLLBAR_ORIGINAL_KEY = Symbol.for("pi-rail-ui.rail-scrollbar-original");

const scrollbarLifecycle = createPatchLifecycle("rail-scrollbar-patch", () => ({}));
const markedScrollViews = new Set<any>();

const RAIL_DRAG_INACTIVITY_MS = 300;
let railDragActive = false;
let railRenderPending = false;
let railDragTimeout: ReturnType<typeof setTimeout> | undefined;

/**
 * While the Rail scrollbar is being dragged, renders are suspended so the
 * transcript is not redrawn on every mouse-motion event; the release (or an
 * inactivity timeout) performs one final render. Scroll state still updates.
 */
export function beginRailDrag(tui: any): void {
	railDragActive = true;
	railRenderPending = false;
	bumpRailDrag(tui);
}

export function bumpRailDrag(tui: any): void {
	if (!railDragActive) return;
	if (railDragTimeout) clearTimeout(railDragTimeout);
	railDragTimeout = setTimeout(() => endRailDrag(tui), RAIL_DRAG_INACTIVITY_MS);
	railDragTimeout.unref?.();
}

export function railRequestRender(tui: any): void {
	if (railDragActive) {
		railRenderPending = true;
		return;
	}
	tui.requestRender?.();
}

export function endRailDrag(tui: any): void {
	if (!railDragActive) return;
	railDragActive = false;
	if (railDragTimeout) {
		clearTimeout(railDragTimeout);
		railDragTimeout = undefined;
	}
	if (railRenderPending) {
		railRenderPending = false;
		tui.requestRender?.();
	}
}

function resetRailDrag(): void {
	railDragActive = false;
	railRenderPending = false;
	if (railDragTimeout) {
		clearTimeout(railDragTimeout);
		railDragTimeout = undefined;
	}
}

function foregroundFromBackgroundAnsi(ansi: string): string {
	return ansi.replace(/\x1b\[48([;:])/g, "\x1b[38$1");
}

function thumbCell(): string {
	const color = foregroundFromBackgroundAnsi(CONVERSATION_SCROLLBAR_STYLE.thumbBackground) || RAIL_EDITOR_STYLE.rail;
	const width = Math.max(1, Math.round(CONVERSATION_SCROLLBAR_STYLE.width));
	return `${color}${"█".repeat(width)}${CONVERSATION_SCROLLBAR_STYLE.reset}`;
}

/**
 * Paint the Rail thumb over the rightmost cell of one screen row.
 * Plain rows (no ANSI) use a direct slice; styled rows fall back to
 * compositeTuiLine so escape sequences and wide graphemes stay intact.
 */
function styleRailThumbCell(line: string, column: number, barWidth: number, totalWidth: number): string {
	if (!line) return thumbCell();
	if (line.indexOf("\x1b") === -1) {
		return `${line.slice(0, column)}${thumbCell()}${line.slice(column + barWidth)}`;
	}
	return compositeTuiLine(line, thumbCell(), column, barWidth, totalWidth);
}

export function markRailScrollbarView(scrollView: any): void {
	if (!scrollView || scrollView[RAIL_SCROLLBAR_MARKED_KEY] === true) return;
	scrollView[RAIL_SCROLLBAR_MARKED_KEY] = true;
	scrollView[RAIL_SCROLLBAR_ORIGINAL_KEY] = scrollView.currentScrollbar;
	markedScrollViews.add(scrollView);
}

export function isRailScrollbarView(scrollView: any): boolean {
	return scrollView?.[RAIL_SCROLLBAR_MARKED_KEY] === true;
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

/**
 * Draw the legacy Rail scrollbar (blue thumb, transparent track) over the
 * rightmost column of the transcript region. The native scrollbar stays in
 * "auto" mode so Pi's drag/hover/click handling works on the same thumb
 * geometry; our thumb is painted on top and simply reuses it.
 */
export function drawRailScrollbar(screen: string[], layout: any, terminalColumns: number): string[] {
	const scrollView = layout?.primaryScrollView;
	if (!isRailScrollbarView(scrollView)) return screen;
	// Keep the native bar interactable: "auto" mode plus an always-visible
	// transient state makes Pi's getScrollbarGeometry/handleScrollbarMouseEvent
	// accept the thumb as a drag target without reserving a layout column.
	if (scrollView.currentScrollbar !== "auto") scrollView.setScrollbar?.("auto");
	scrollView.hideTransientScrollbar?.();
	scrollView.transientScrollbarVisible = true;

	const box = findScrollBox(layout.root, scrollView);
	if (!box) return screen;
	const trackTop = Math.max(0, box.rect.y);
	const trackHeight = Math.max(0, Math.floor(box.rect.height));
	const totalRows = Array.isArray(box.scrollContentLines) ? box.scrollContentLines.length : 0;
	if (trackHeight <= 0 || totalRows <= trackHeight) return screen;
	const column = box.rect.x + box.rect.width - 1;
	if (column < 0 || column >= terminalColumns) return screen;

	// Must match Pi's getScrollbarGeometry exactly: the native drag logic
	// (grabOffset, thumbOffset, scrollTo) is computed from the same numbers.
	const thumbSize = Math.max(2, Math.min(trackHeight, Math.round((trackHeight * trackHeight) / totalRows)));
	const maxThumbStart = Math.max(0, trackHeight - thumbSize);
	const maxScrollStart = Math.max(0, totalRows - trackHeight);
	const thumbStart = maxScrollStart === 0 ? 0 : Math.round((scrollView.currentScrollTop / maxScrollStart) * maxThumbStart);
	const thumbTop = trackTop + thumbStart;
	const barWidth = Math.max(1, Math.round(CONVERSATION_SCROLLBAR_STYLE.width));

	for (let row = Math.max(0, thumbTop); row < Math.min(screen.length, thumbTop + thumbSize); row++) {
		screen[row] = styleRailThumbCell(screen[row] ?? "", column, barWidth, terminalColumns);
	}
	return screen;
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
		const result = original.call(this, screen, layout);
		if (!scrollbarLifecycle.state().active || !isRailUiActive()) return result;
		const scrollView = layout?.primaryScrollView;
		if (!scrollView || scrollView.primary !== true) return result;
		markRailScrollbarView(scrollView);
		try {
			return drawRailScrollbar(result, layout, this.terminal?.columns ?? 0);
		} catch {
			return result;
		}
	});
	scrollbarLifecycle.patchMethod(ctor, "handleScrollbarMouseEvent", (original) => function patchedScrollbarMouseEvent(
		this: any,
		_event: any,
	): boolean {
		const wasDragging = Boolean(this.scrollbarDrag);
		const result = original.apply(this, arguments as unknown as [event: any]);
		const isDragging = Boolean(this.scrollbarDrag);
		if (isDragging && !wasDragging) beginRailDrag(this);
		else if (isDragging) bumpRailDrag(this);
		else if (wasDragging) endRailDrag(this);
		return result;
	});
	scrollbarLifecycle.patchMethod(ctor, "requestRender", (original) => function patchedRequestRender(
		this: any,
	): void {
		if (railDragActive) {
			railRenderPending = true;
			return;
		}
		return original.apply(this, arguments as unknown as []);
	});
}

export function uninstallRailScrollbar(): void {
	scrollbarLifecycle.deactivate();
	resetRailDrag();
	for (const scrollView of markedScrollViews) {
		const original = scrollView[RAIL_SCROLLBAR_ORIGINAL_KEY];
		if (original !== undefined) scrollView.setScrollbar?.(original);
		scrollView.hideTransientScrollbar?.();
		delete scrollView[RAIL_SCROLLBAR_MARKED_KEY];
		delete scrollView[RAIL_SCROLLBAR_ORIGINAL_KEY];
	}
	markedScrollViews.clear();
}
