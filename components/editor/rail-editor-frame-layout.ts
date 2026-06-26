import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
	EDITOR_PASTE_MARKER_STYLE,
	RAIL_EDITOR_STYLE,
	applyTextColor,
	type ThemeLike,
} from "../../config";
import {
	padToWidth,
	segmenter,
	visibleColForIndex,
	wrapLine,
	type ColumnRange,
	type Position,
	type VisualRow,
} from "../../core/utils";
import type { RailEditorFrameInput } from "./rail-editor-frame";

const PASTE_MARKER_RE = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g;

type SelectionRange = { start: Position; end: Position } | undefined;

type VisualMapCache = {
	layoutWidth: number;
	lineRows: Array<{ text: string; rows: VisualRow[] }>;
	map: VisualRow[];
};

export type RailEditorFrameLayout = {
	rows: string[];
	visibleMap: VisualRow[];
	contentWidth: number;
	topPadding: number;
	bottomPadding: number;
};

export class RailEditorFrameLayoutPlanner {
	private editorScrollOffset = 0;
	private editorScrollMax = 0;
	private editorManualScroll = false;
	private visualMapCache?: VisualMapCache | undefined;
	private rowRenderCache = new Map<string, string>();

	resetContent(): void {
		this.visualMapCache = undefined;
		this.rowRenderCache.clear();
	}

	markTextInput(): void {
		this.editorManualScroll = false;
	}

	scrollBy(deltaRows: number): void {
		this.editorManualScroll = true;
		this.editorScrollOffset = Math.max(0, Math.min(this.editorScrollMax, this.editorScrollOffset + deltaRows));
	}

	layout(input: RailEditorFrameInput): RailEditorFrameLayout {
		const contentWidth = input.surface.contentWidth(input.width);
		const body = this.editorBodyRows(input, contentWidth);
		const targetRows = input.surface.targetInputHeight(body.visibleMap.length, input.terminalRows);
		const blankRows = Math.max(0, targetRows - body.rows.length);
		const topPadding = Math.floor(blankRows / 2);
		return {
			...body,
			contentWidth,
			topPadding,
			bottomPadding: blankRows - topPadding,
		};
	}

	private cursorVisualIndex(visualMap: VisualRow[], lines: string[], cursor: Position): number {
		for (let index = 0; index < visualMap.length; index++) {
			const row = visualMap[index]!;
			if (row.logicalLine !== cursor.line) continue;
			const lineEnd = (lines[row.logicalLine] ?? "").length;
			if (cursor.col >= row.startIndex && (cursor.col < row.endIndex || (row.endIndex === lineEnd && cursor.col === row.endIndex))) {
				return index;
			}
		}
		return Math.max(0, visualMap.length - 1);
	}

	private highlightPasteMarkers(text: string, appTheme: ThemeLike): string {
		if (!text.includes("[paste #")) return text;
		return text.replace(PASTE_MARKER_RE, (marker) => {
			const coloredMarker = applyTextColor(appTheme, EDITOR_PASTE_MARKER_STYLE.foreground, marker);
			return `${EDITOR_PASTE_MARKER_STYLE.background}${EDITOR_PASTE_MARKER_STYLE.bold}${coloredMarker}${EDITOR_PASTE_MARKER_STYLE.reset}`;
		});
	}

	private selectionColumnsForRow(row: VisualRow, selection: SelectionRange): ColumnRange | undefined {
		if (!selection) return undefined;
		if (row.logicalLine < selection.start.line || row.logicalLine > selection.end.line) return undefined;

		let startIndex = row.startIndex;
		let endIndex = row.endIndex;
		if (row.logicalLine === selection.start.line) startIndex = Math.max(startIndex, selection.start.col);
		if (row.logicalLine === selection.end.line) endIndex = Math.min(endIndex, selection.end.col);
		if (endIndex <= startIndex) return undefined;

		return {
			startCol: visibleColForIndex(row.text, startIndex - row.startIndex),
			endCol: visibleColForIndex(row.text, endIndex - row.startIndex),
		};
	}

	private renderVisualRow(row: VisualRow, input: RailEditorFrameInput, contentWidth: number): string {
		let text = row.text;
		const lineEnd = (input.lines[row.logicalLine] ?? "").length;
		const cursorInRow =
			input.cursor.line === row.logicalLine &&
			input.cursor.col >= row.startIndex &&
			(input.cursor.col < row.endIndex || (row.endIndex === lineEnd && input.cursor.col === row.endIndex));

		if (cursorInRow) {
			const localCol = Math.max(0, input.cursor.col - row.startIndex);
			const before = text.slice(0, localCol);
			const after = text.slice(localCol);
			const marker = input.focused && !input.autocompleteActive ? CURSOR_MARKER : "";
			const first = segmenter.segment(after)[Symbol.iterator]().next().value?.segment;
			if (first) {
				text = `${before}${marker}\x1b[7m${first}\x1b[0m${after.slice(first.length)}`;
			} else {
				text = `${before}${marker}\x1b[7m \x1b[0m`;
			}
		}

		text = this.highlightPasteMarkers(text, input.appTheme);

		const textWidth = Math.max(1, contentWidth - input.paddingX * 2);
		const textVisibleWidth = visibleWidth(text);
		const fitted = textVisibleWidth <= textWidth ? text + " ".repeat(textWidth - textVisibleWidth) : padToWidth(text, textWidth);
		return `${" ".repeat(input.paddingX)}${fitted}${" ".repeat(input.paddingX)}`;
	}

	private renderEditorScrollbar(line: string, rowIndex: number, visibleRows: number, totalRows: number, start: number, contentWidth: number): string {
		if (contentWidth <= 1 || totalRows <= visibleRows) return line;

		const thumbSize = Math.max(1, Math.floor((visibleRows * visibleRows) / totalRows));
		const maxThumbStart = Math.max(0, visibleRows - thumbSize);
		const maxScrollStart = Math.max(1, totalRows - visibleRows);
		const thumbStart = Math.round((start / maxScrollStart) * maxThumbStart);
		const isThumb = rowIndex >= thumbStart && rowIndex < thumbStart + thumbSize;
		const bar = isThumb ? `${RAIL_EDITOR_STYLE.rail}┃${RAIL_EDITOR_STYLE.reset}` : "│";
		return `${padToWidth(line, contentWidth - 1)}${bar}`;
	}

	private getCachedVisualMap(layoutWidth: number, lines: string[]): VisualRow[] {
		const previous = this.visualMapCache?.layoutWidth === layoutWidth ? this.visualMapCache : undefined;
		let changed = !previous || previous.lineRows.length !== lines.length;
		const lineRows: Array<{ text: string; rows: VisualRow[] }> = new Array(lines.length);
		const map: VisualRow[] = [];

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const text = lines[lineIndex] ?? "";
			const cached = previous?.lineRows[lineIndex];
			let entry: { text: string; rows: VisualRow[] };
			if (cached?.text === text) {
				entry = cached;
			} else {
				changed = true;
				entry = {
					text,
					rows: wrapLine(text, layoutWidth).map((chunk) => ({
						logicalLine: lineIndex,
						startIndex: chunk.startIndex,
						endIndex: chunk.endIndex,
						text: chunk.text,
					})),
				};
			}
			lineRows[lineIndex] = entry;
			map.push(...entry.rows);
		}

		const normalizedMap = map.length > 0 ? map : [{ logicalLine: 0, startIndex: 0, endIndex: 0, text: "" }];
		if (!changed && previous) return previous.map;
		this.visualMapCache = { layoutWidth, lineRows, map: normalizedMap };
		return normalizedMap;
	}

	private renderedBodyRow(
		row: VisualRow,
		index: number,
		visibleRows: number,
		totalRows: number,
		start: number,
		contentWidth: number,
		input: RailEditorFrameInput,
	): string {
		const lineEnd = (input.lines[row.logicalLine] ?? "").length;
		const cursorInRow =
			input.cursor.line === row.logicalLine &&
			input.cursor.col >= row.startIndex &&
			(input.cursor.col < row.endIndex || (row.endIndex === lineEnd && input.cursor.col === row.endIndex));
		const selection = this.selectionColumnsForRow(row, input.selection);
		const key = [
			contentWidth,
			input.paddingX,
			index,
			visibleRows,
			totalRows,
			start,
			row.logicalLine,
			row.startIndex,
			row.endIndex,
			row.text,
			cursorInRow ? `${input.cursor.line}:${input.cursor.col}:${input.focused ? 1 : 0}:${input.autocompleteActive ? 1 : 0}` : "",
			selection ? `${selection.startCol}:${selection.endCol}` : "",
		].join("\u001f");
		const cached = this.rowRenderCache.get(key);
		if (cached !== undefined) return cached;

		const rawLine = this.renderVisualRow(row, input, contentWidth);
		const selectedLine = selection
			? input.surface.highlightColumns(rawLine, selection.startCol + input.paddingX, selection.endCol + input.paddingX)
			: rawLine;
		const rendered = this.renderEditorScrollbar(selectedLine, index, visibleRows, totalRows, start, contentWidth);
		if (this.rowRenderCache.size > 512) this.rowRenderCache.clear();
		this.rowRenderCache.set(key, rendered);
		return rendered;
	}

	private editorBodyRows(input: RailEditorFrameInput, contentWidth: number): { rows: string[]; visibleMap: VisualRow[] } {
		const innerWidth = Math.max(1, contentWidth - input.paddingX * 2);
		const layoutWidth = Math.max(1, innerWidth - (input.paddingX ? 0 : 1));
		const visualMap = this.getCachedVisualMap(layoutWidth, input.lines);
		const targetRows = input.surface.targetInputHeight(visualMap.length, input.terminalRows);
		this.editorScrollMax = Math.max(0, visualMap.length - targetRows);

		if (!this.editorManualScroll) {
			const cursorIndex = this.cursorVisualIndex(visualMap, input.lines, input.cursor);
			if (cursorIndex < this.editorScrollOffset) this.editorScrollOffset = cursorIndex;
			else if (cursorIndex >= this.editorScrollOffset + targetRows) this.editorScrollOffset = cursorIndex - targetRows + 1;
		}
		this.editorScrollOffset = Math.max(0, Math.min(this.editorScrollOffset, this.editorScrollMax));

		const visibleRows = visualMap.slice(this.editorScrollOffset, this.editorScrollOffset + targetRows);
		return {
			visibleMap: visibleRows,
			rows: visibleRows.map((row, index) =>
				this.renderedBodyRow(row, index, targetRows, visualMap.length, this.editorScrollOffset, contentWidth, input),
			),
		};
	}
}
