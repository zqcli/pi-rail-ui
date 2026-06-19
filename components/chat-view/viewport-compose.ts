import { CONVERSATION_SELECTION_STYLE, RAIL_EDITOR_STYLE } from "../../config";
import { OSC133_ZONE_END, OSC133_ZONE_FINAL, OSC133_ZONE_START, applyColumnHighlight, padToWidth } from "../../core/utils";
import type { ScrollbarMetrics } from "./state";

const LEADING_ZERO_WIDTH_ROW_MARKERS = [OSC133_ZONE_START, OSC133_ZONE_END, OSC133_ZONE_FINAL] as const;
const GLOBAL_LEFT_GUTTER_ROW_CACHE_LIMIT = 8192;
const GLOBAL_LEFT_GUTTER_ROW_CACHE_MAX_LINE_LENGTH = 16384;
const globalLeftGutterRowCache = {
	width: -1,
	gutter: -1,
	rows: new Map<string, string>(),
};

function splitLeadingZeroWidthRowMarkers(line: string): { markers: string; body: string } {
	let markers = "";
	let body = line;
	let matched = true;
	while (matched) {
		matched = false;
		for (const marker of LEADING_ZERO_WIDTH_ROW_MARKERS) {
			if (!body.startsWith(marker)) continue;
			markers += marker;
			body = body.slice(marker.length);
			matched = true;
			break;
		}
	}
	return { markers, body };
}

function addGlobalLeftGutter(line: string, width: number, gutter: number, targetWidth = width): string {
	if (globalLeftGutterRowCache.width !== width || globalLeftGutterRowCache.gutter !== gutter) {
		globalLeftGutterRowCache.width = width;
		globalLeftGutterRowCache.gutter = gutter;
		globalLeftGutterRowCache.rows.clear();
	}

	// History rows reserve the scrollbar column by padding to a smaller target,
	// so the key must distinguish the two target widths used per frame.
	const key = targetWidth === width ? line : `${targetWidth}\u0000${line}`;
	const cached = globalLeftGutterRowCache.rows.get(key);
	if (cached !== undefined) {
		globalLeftGutterRowCache.rows.delete(key);
		globalLeftGutterRowCache.rows.set(key, cached);
		return cached;
	}

	const prefixWidth = Math.min(gutter, Math.max(0, width - 1));
	const contentWidth = Math.max(0, targetWidth - prefixWidth);
	const { markers, body } = splitLeadingZeroWidthRowMarkers(line);
	const rendered = `${markers}${" ".repeat(prefixWidth)}${padToWidth(body, contentWidth)}`;
	if (line.length <= GLOBAL_LEFT_GUTTER_ROW_CACHE_MAX_LINE_LENGTH) {
		globalLeftGutterRowCache.rows.set(key, rendered);
		while (globalLeftGutterRowCache.rows.size > GLOBAL_LEFT_GUTTER_ROW_CACHE_LIMIT) {
			const oldestKey = globalLeftGutterRowCache.rows.keys().next().value;
			if (oldestKey === undefined) break;
			globalLeftGutterRowCache.rows.delete(oldestKey);
		}
	}
	return rendered;
}

export function addGlobalLeftGutterToRows(lines: string[], width: number, gutter: number): string[] {
	return lines.map((line) => addGlobalLeftGutter(line, width, gutter));
}

function highlightHistoryLine(
	line: string,
	lineIndex: number,
	range: { start: { line: number; col: number }; end: { line: number; col: number } } | undefined,
	width: number,
): string {
	if (!range || lineIndex < range.start.line || lineIndex > range.end.line) return line;

	const startCol = lineIndex === range.start.line ? range.start.col : 0;
	const endCol = lineIndex === range.end.line ? range.end.col : width;
	return applyColumnHighlight(line, startCol, endCol, CONVERSATION_SELECTION_STYLE, RAIL_EDITOR_STYLE.reset);
}

// Composite the visible history window: gutter each line (padded so the
// scrollbar column fits) and append the scrollbar cell. Pure + exported so the
// output can be golden-tested against the straightforward construction.
export function composeHistoryRows(
	historyLines: string[],
	start: number,
	historyRows: number,
	width: number,
	leftGutterWidth: number,
	contentWidth: number,
	scrollbar: ScrollbarMetrics | undefined,
	selection: { start: { line: number; col: number }; end: { line: number; col: number } } | undefined,
): string[] {
	const targetWidth = scrollbar ? width - scrollbar.width : width;
	const rows: string[] = [];
	for (let index = 0; index < historyRows; index++) {
		const lineIndex = start + index;
		const highlighted = highlightHistoryLine(historyLines[lineIndex] ?? "", lineIndex, selection, contentWidth);
		const guttered = addGlobalLeftGutter(highlighted, width, leftGutterWidth, targetWidth);
		if (!scrollbar) {
			rows.push(guttered);
			continue;
		}
		const isThumb = index >= scrollbar.thumbStart && index < scrollbar.thumbStart + scrollbar.thumbSize;
		rows.push(`${guttered}${RAIL_EDITOR_STYLE.reset}${isThumb ? scrollbar.thumbBar : scrollbar.trackBar}`);
	}
	return rows;
}
