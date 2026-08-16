import { resolveNativeTuiExport } from "../../core/patching";
import { canToggleRailSection, markRailSectionManuallyToggled, resolveRailSection } from "../../rail/rail-section";
import type { ExecutionRailPatcher } from "./execution-collapse";

const RAIL_CLICK_MARKER_ID_KEY = Symbol.for("pi-rail-ui.rail-click-marker-id");
const RAIL_CLICK_MARKED_ROWS_CACHE_KEY = Symbol.for("pi-rail-ui.rail-click-marked-rows-cache");
const MARKER_START_RE = /\x1b_pi-rail-click:start:(\d+)\x07/gu;
const MARKER_END_RE = /\x1b_pi-rail-click:end:(\d+)\x07/gu;

let nextRailClickMarkerId = 1;
const railClickComponents = new Map<number, any>();

type AltScreenConstructor = {
	prototype: {
		handleSelectionMouseEvent(event: any): void;
	};
};

function railClickMarkerId(component: any): number {
	let id = component?.[RAIL_CLICK_MARKER_ID_KEY] as number | undefined;
	if (id === undefined) {
		id = nextRailClickMarkerId++;
		component[RAIL_CLICK_MARKER_ID_KEY] = id;
	}
	railClickComponents.set(id, component);
	return id;
}

export function markRailClickRows(component: any, rows: string[]): string[] {
	if (rows.length === 0) return rows;
	const id = railClickMarkerId(component);
	const cached = component?.[RAIL_CLICK_MARKED_ROWS_CACHE_KEY] as { source: string[]; rows: string[] } | undefined;
	if (cached?.source === rows) return cached.rows;

	const start = `\x1b_pi-rail-click:start:${id}\x07`;
	const end = `\x1b_pi-rail-click:end:${id}\x07`;
	const marked = [...rows];
	marked[0] = `${start}${marked[0] ?? ""}`;
	const last = marked.length - 1;
	marked[last] = `${marked[last] ?? ""}${end}`;
	component[RAIL_CLICK_MARKED_ROWS_CACHE_KEY] = { source: rows, rows: marked };
	return marked;
}

function markerIds(line: string, pattern: RegExp): number[] {
	pattern.lastIndex = 0;
	return Array.from(line.matchAll(pattern), (match) => Number(match[1]));
}

export function railClickComponentAtRow(lines: string[], row: number): any | undefined {
	const ranges = new Map<number, { start: number; end?: number }>();
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		for (const id of markerIds(line, MARKER_START_RE)) ranges.set(id, { start: index });
		for (const id of markerIds(line, MARKER_END_RE)) {
			const range = ranges.get(id);
			if (range) range.end = index;
		}
	}

	let match: { id: number; start: number } | undefined;
	for (const [id, range] of ranges) {
		if (row < range.start || row > (range.end ?? range.start)) continue;
		if (!match || range.start >= match.start) match = { id, start: range.start };
	}
	return match ? railClickComponents.get(match.id) : undefined;
}

function scrollContentLines(tui: any, scrollView: any): string[] | undefined {
	const visit = (box: any): string[] | undefined => {
		if (box?.scrollView === scrollView && Array.isArray(box.scrollContentLines)) return box.scrollContentLines;
		for (const child of box?.children ?? []) {
			const lines = visit(child);
			if (lines) return lines;
		}
		return undefined;
	};
	return visit(tui?.currentLayout?.root);
}

function clearNativeSelection(tui: any): void {
	tui.selectionPressActive = false;
	tui.stopSelectionAutoScroll?.();
	tui.selectionAnchor = undefined;
	tui.selectionFocus = undefined;
	tui.selectionGranularity = "character";
	tui.selectionInitialRange = undefined;
	tui.pressedUrl = undefined;
	tui.selectionDragged = false;
}

export function handleRailSectionClick(tui: any, event: any): boolean {
	if (!event?.release) return false;
	const button = event.button & 3;
	if (button !== 0 && button !== 3) return false;
	if (!tui?.selectionPressActive || tui.selectionDragged || tui.selectionInitialRange || tui.pressedUrl) return false;

	const anchor = tui.selectionAnchor;
	if (!anchor?.scrollView) return false;
	const point = tui.getSelectionPoint?.(event, anchor.scrollView);
	if (!point || point.scrollView !== anchor.scrollView || point.row !== anchor.row || point.col !== anchor.col) return false;

	const lines = scrollContentLines(tui, anchor.scrollView);
	const component = lines ? railClickComponentAtRow(lines, anchor.row) : undefined;
	if (!component || typeof component.setExpanded !== "function") return false;

	const section = resolveRailSection(component);
	if (!section || !canToggleRailSection(section)) return false;

	clearNativeSelection(tui);
	markRailSectionManuallyToggled(component);
	component.setExpanded(!Boolean(component.expanded));
	// Pin the transcript at the clicked row: with follow:end active, growing or
	// shrinking content would otherwise re-anchor the viewport at the bottom
	// and scroll the toggled section out of view.
	if (anchor.scrollView && typeof anchor.scrollView === "object") anchor.scrollView.followingEnd = false;
	tui.requestRender?.();
	return true;
}

export async function patchRailSectionClickHandling(patcher: ExecutionRailPatcher): Promise<void> {
	const ctor = await resolveNativeTuiExport<AltScreenConstructor>("TuiAltScreen");
	patcher.patchMethod(ctor, "handleSelectionMouseEvent", (original) => function patchedSelectionMouseEvent(
		this: any,
		event: any,
	): void {
		if (handleRailSectionClick(this, event)) return;
		return original.call(this, event);
	});
}

export function clearRailClickRegistry(): void {
	railClickComponents.clear();
}
