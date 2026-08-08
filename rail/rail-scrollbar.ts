import { compositeTuiLine } from "@earendil-works/pi-tui";
import { CONVERSATION_SCROLLBAR_STYLE, RAIL_EDITOR_STYLE } from "../config";
import { createPatchLifecycle, resolveNativeTuiExport } from "../core/patching";
import { isRailUiActive } from "./rail-section";

const RAIL_SCROLLBAR_MARKED_KEY = Symbol.for("pi-rail-ui.rail-scrollbar-marked");
const RAIL_SCROLLBAR_ORIGINAL_KEY = Symbol.for("pi-rail-ui.rail-scrollbar-original");

const scrollbarLifecycle = createPatchLifecycle("rail-scrollbar-patch", () => ({}));
const markedScrollViews = new Set<any>();

function foregroundFromBackgroundAnsi(ansi: string): string {
	return ansi.replace(/\x1b\[48([;:])/g, "\x1b[38$1");
}

function thumbCell(): string {
	const color = foregroundFromBackgroundAnsi(CONVERSATION_SCROLLBAR_STYLE.thumbBackground) || RAIL_EDITOR_STYLE.rail;
	const width = Math.max(1, Math.round(CONVERSATION_SCROLLBAR_STYLE.width));
	return `${color}${"█".repeat(width)}${CONVERSATION_SCROLLBAR_STYLE.reset}`;
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
 * rightmost column of the transcript region, and keep Pi's native scrollbar
 * hidden. Mirrors the old viewport metrics.
 */
export function drawRailScrollbar(screen: string[], layout: any, terminalColumns: number): string[] {
	const scrollView = layout?.primaryScrollView;
	if (!isRailScrollbarView(scrollView)) return screen;
	if (scrollView.currentScrollbar !== "hidden") scrollView.setScrollbar?.("hidden");

	const box = findScrollBox(layout.root, scrollView);
	if (!box) return screen;
	const trackTop = Math.max(0, box.rect.y);
	const trackHeight = Math.max(0, Math.floor(box.rect.height));
	const totalRows = Array.isArray(box.scrollContentLines) ? box.scrollContentLines.length : 0;
	if (trackHeight <= 0 || totalRows <= trackHeight) return screen;
	const column = box.rect.x + box.rect.width - 1;
	if (column < 0 || column >= terminalColumns) return screen;

	const thumbSize = Math.min(
		Math.max(1, Math.floor((trackHeight * trackHeight) / totalRows)),
		Math.max(1, Math.floor(trackHeight * 0.65)),
	);
	const maxThumbStart = Math.max(0, trackHeight - thumbSize);
	const maxScrollStart = Math.max(1, totalRows - trackHeight);
	const thumbStart = Math.round((scrollView.currentScrollTop / maxScrollStart) * maxThumbStart);
	const thumbTop = trackTop + thumbStart;
	const cell = thumbCell();
	const barWidth = Math.max(1, Math.round(CONVERSATION_SCROLLBAR_STYLE.width));

	for (let row = Math.max(0, thumbTop); row < Math.min(screen.length, thumbTop + thumbSize); row++) {
		screen[row] = compositeTuiLine(screen[row] ?? "", cell, column, barWidth, terminalColumns);
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
}

export function uninstallRailScrollbar(): void {
	scrollbarLifecycle.deactivate();
	for (const scrollView of markedScrollViews) {
		const original = scrollView[RAIL_SCROLLBAR_ORIGINAL_KEY];
		if (original !== undefined) scrollView.setScrollbar?.(original);
		delete scrollView[RAIL_SCROLLBAR_MARKED_KEY];
		delete scrollView[RAIL_SCROLLBAR_ORIGINAL_KEY];
	}
	markedScrollViews.clear();
}
