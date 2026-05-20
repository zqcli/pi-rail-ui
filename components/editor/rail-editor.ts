import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, SelectList, matchesKey, visibleWidth, type Component, type EditorTheme, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { SlashCommandOverlay } from "./slash-autocomplete";
import { CONVERSATION_SCROLL_LAYOUT, EDITOR_MOUSE_TRACKING_ENABLED, EDITOR_PASTE_MARKER_STYLE, SLASH_COMMAND_LAYOUT, RAIL_EDITOR_STYLE, applyTextColor } from "../../config";
import { selectorOutputSurfaceForTheme, railEditorSurface, type EditorSurfaceRenderer } from "../../rail/rail-surface";
import {
	CURSOR_POSITION_RE,
	SGR_MOUSE_RE,
	segmenter,
	wrapLine,
	clampPosition,
	comparePosition,
	indexForVisualCol,
	padToWidth,
	parseWheel,
	samePosition,
	visibleColForIndex,
	type ColumnRange,
	type MouseLayout,
	type ParsedMouse,
	type Position,
	type VisualRow,
} from "../../core/utils";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const PASTE_MARKER_RE = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g;

function parseMouse(data: string): ParsedMouse | undefined {
	const match = SGR_MOUSE_RE.exec(data);
	if (!match) return undefined;

	const code = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	const final = match[4];
	if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
	if ((code & 64) !== 0) return undefined; // Ignore wheel events.

	const release = final === "m" || (code & 3) === 3;
	const drag = !release && (code & 32) !== 0;
	const leftButton = (code & 3) === 0;
	if (!release && !leftButton) return undefined;

	return { x, y, action: release ? "release" : drag ? "drag" : "press" };
}

function parseCursorPosition(data: string): { row: number; col: number } | undefined {
	const match = CURSOR_POSITION_RE.exec(data);
	if (!match) return undefined;
	return { row: Number(match[1]), col: Number(match[2]) };
}

function requestCursorPosition(): void {
	if (process.stdout.isTTY) process.stdout.write("\x1b[6n");
}

export function enableMouseTracking(): void {
	if (process.stdout.isTTY) process.stdout.write(ENABLE_MOUSE);
}

export function disableMouseTracking(): void {
	if (process.stdout.isTTY) process.stdout.write(DISABLE_MOUSE);
}

export function enterAlternateScreen(): void {
	if (process.stdout.isTTY) process.stdout.write(ENTER_ALT_SCREEN);
}

export function exitAlternateScreen(): void {
	if (process.stdout.isTTY) process.stdout.write(EXIT_ALT_SCREEN);
}

export class MouseSelectableRailEditor extends CustomEditor {
	protected selection?: { anchor: Position; active: Position };
	private pendingMouse?: ParsedMouse;
	private mouseLayout?: MouseLayout;
	private screenOrigin?: {
		topRow: number;
		leftCol: number;
		visibleRows: number;
		contentWidth: number;
		contentStartCol: number;
	};

	setSelectionRange(anchor: Position, active: Position): void {
		this.selection = { anchor, active };
		this.tui.requestRender();
	}

	clearSelection(): void {
		if (!this.selection) return;
		this.selection = undefined;
		this.tui.requestRender();
	}

	protected setMouseLayout(layout: MouseLayout): void {
		const previous = this.mouseLayout;
		if (
			!previous ||
			previous.visibleMap.length !== layout.visibleMap.length ||
			previous.contentWidth !== layout.contentWidth ||
			previous.contentStartCol !== layout.contentStartCol ||
			previous.topPadding !== layout.topPadding
		) {
			this.screenOrigin = undefined;
		}
		this.mouseLayout = layout;
	}

	protected getSelectionRange(): { start: Position; end: Position } | undefined {
		if (!this.selection) return undefined;
		const { anchor, active } = this.selection;
		if (samePosition(anchor, active)) return undefined;
		return comparePosition(anchor, active) <= 0 ? { start: anchor, end: active } : { start: active, end: anchor };
	}

	protected selectionColumnsForRow(row: VisualRow): ColumnRange | undefined {
		const range = this.getSelectionRange();
		if (!range) return undefined;
		if (row.logicalLine < range.start.line || row.logicalLine > range.end.line) return undefined;

		let startIndex = row.startIndex;
		let endIndex = row.endIndex;
		if (row.logicalLine === range.start.line) startIndex = Math.max(startIndex, range.start.col);
		if (row.logicalLine === range.end.line) endIndex = Math.min(endIndex, range.end.col);
		if (endIndex <= startIndex) return undefined;

		return {
			startCol: visibleColForIndex(row.text, startIndex - row.startIndex),
			endCol: visibleColForIndex(row.text, endIndex - row.startIndex),
		};
	}

	protected editorLinesRef(): string[] {
		return ((this as any).state?.lines as string[] | undefined) ?? this.getLines();
	}

	private moveCursorToPosition(pos: Position): void {
		const target = clampPosition(pos, this.editorLinesRef());
		const editor = this as any;
		// Mouse movement can happen dozens of times per second while dragging.
		// Mutate the editor cursor directly instead of replaying arrow-key input
		// one cell at a time, which becomes O(distance) and very slow for large prompts.
		editor.cancelAutocomplete?.();
		editor.lastAction = null;
		editor.historyIndex = -1;
		editor.state.cursorLine = target.line;
		if (typeof editor.setCursorCol === "function") editor.setCursorCol(target.col);
		else editor.state.cursorCol = target.col;
		this.tui.requestRender();
	}

	private positionFromLocal(localRow: number, localCol: number): Position | undefined {
		const layout = this.mouseLayout;
		if (!layout || layout.visibleMap.length === 0) return undefined;

		const contentCol = Math.max(0, Math.min(layout.contentWidth, localCol - layout.contentStartCol));
		if (localRow < layout.topPadding) {
			const first = layout.visibleMap[0]!;
			return { line: first.logicalLine, col: first.startIndex };
		}

		const bodyRow = localRow - layout.topPadding;
		if (bodyRow >= layout.visibleMap.length) {
			const last = layout.visibleMap[layout.visibleMap.length - 1]!;
			return { line: last.logicalLine, col: last.endIndex };
		}

		const row = layout.visibleMap[bodyRow]!;
		return { line: row.logicalLine, col: row.startIndex + indexForVisualCol(row.text, contentCol) };
	}

	private resolveMouseFromOrigin(mouse: ParsedMouse, origin: { topRow: number; leftCol: number }): void {
		const localRow = mouse.y - origin.topRow;
		const localCol = mouse.x - origin.leftCol;
		const pos = this.positionFromLocal(localRow, localCol);
		if (!pos) return;

		if (mouse.action === "press") {
			this.selection = { anchor: pos, active: pos };
			this.moveCursorToPosition(pos);
			return;
		}

		if (mouse.action === "drag") {
			if (!this.selection) this.selection = { anchor: pos, active: pos };
			else this.selection.active = pos;
			this.moveCursorToPosition(pos);
			return;
		}

		if (this.selection) this.selection.active = pos;
		if (!this.getSelectionRange()) this.selection = undefined;
		this.tui.requestRender();
	}

	private resolveMouse(mouse: ParsedMouse, cursor: { row: number; col: number }): void {
		const layout = this.mouseLayout;
		if (!layout) return;

		const origin = {
			topRow: cursor.row - layout.cursorLocalRow,
			leftCol: cursor.col - layout.cursorLocalCol,
			visibleRows: layout.visibleMap.length,
			contentWidth: layout.contentWidth,
			contentStartCol: layout.contentStartCol,
		};
		this.screenOrigin = origin;
		this.resolveMouseFromOrigin(mouse, origin);
	}

	private deleteSelection(): boolean {
		const range = this.getSelectionRange();
		if (!range) return false;

		const lines = this.getLines();
		const start = clampPosition(range.start, lines);
		const end = clampPosition(range.end, lines);
		if (comparePosition(start, end) >= 0) return false;

		if (start.line === end.line) {
			const line = lines[start.line] ?? "";
			lines[start.line] = line.slice(0, start.col) + line.slice(end.col);
		} else {
			const first = lines[start.line] ?? "";
			const last = lines[end.line] ?? "";
			lines.splice(start.line, end.line - start.line + 1, first.slice(0, start.col) + last.slice(end.col));
		}

		this.selection = undefined;
		this.setText(lines.join("\n"));
		this.moveCursorToPosition(start);
		return true;
	}

	protected handleMouseWheel(_wheel: ParsedWheel): boolean {
		return false;
	}

	handleInput(data: string): void {
		if (data.charCodeAt(0) === 0x1b) {
			const wheel = parseWheel(data);
			if (wheel && this.handleMouseWheel(wheel)) return;

			const mouse = parseMouse(data);
			if (mouse) {
				if (!EDITOR_MOUSE_TRACKING_ENABLED && !CONVERSATION_SCROLL_LAYOUT.enabled) return;
				const origin = this.screenOrigin;
				const layout = this.mouseLayout;
				if (
					origin &&
					layout &&
					origin.visibleRows === layout.visibleMap.length &&
					origin.contentWidth === layout.contentWidth &&
					origin.contentStartCol === layout.contentStartCol
				) {
					this.resolveMouseFromOrigin(mouse, origin);
					return;
				}
				this.pendingMouse = mouse;
				requestCursorPosition();
				return;
			}

			const cursor = parseCursorPosition(data);
			if (cursor) {
				const pending = this.pendingMouse;
				this.pendingMouse = undefined;
				if (pending) this.resolveMouse(pending, cursor);
				return;
			}
		}

		if (this.getSelectionRange()) {
			if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
				this.deleteSelection();
				return;
			}

			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				if (this.deleteSelection()) {
					super.handleInput(data);
					return;
				}
			}

			this.clearSelection();
		}

		super.handleInput(data);
	}
}

const activeRailEditors = new Set<RailEditor>();

function selectListThemeForRailSlashMenu(theme: EditorTheme, appTheme: Theme): EditorTheme {
	return {
		...theme,
		selectList: {
			...theme.selectList,
			selectedText: (text: string) => applyTextColor(appTheme, SLASH_COMMAND_LAYOUT.selectedText, text),
		},
	};
}

export function hideAllEditorOverlays(): void {
	for (const editor of activeRailEditors) editor.hideSlashOverlay();
	activeRailEditors.clear();
}

type SlashAutocompleteLevel = "top" | "nested";

export class RailEditor extends MouseSelectableRailEditor {
	private slashOverlay?: OverlayHandle;
	private slashOverlaySignature?: string;
	private readonly slashOverlaySurface: EditorSurfaceRenderer;
	private readonly selectListTheme: EditorTheme["selectList"];
	private editorScrollOffset = 0;
	private editorScrollMax = 0;
	private editorManualScroll = false;
	private visualMapCache?: { layoutWidth: number; lineRows: Array<{ text: string; rows: VisualRow[] }>; map: VisualRow[] };
	private rowRenderCache = new Map<string, string>();
	private renderCache?: { signature: string; linesRef: string[]; rows: string[] };

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly appTheme: Theme,
		private readonly surface: EditorSurfaceRenderer = railEditorSurface,
	) {
		const themedEditorTheme = selectListThemeForRailSlashMenu(theme, appTheme);
		super(tui, themedEditorTheme, keybindings);
		this.selectListTheme = themedEditorTheme.selectList;
		this.slashOverlaySurface = selectorOutputSurfaceForTheme(appTheme);
		this.setAutocompleteMaxVisible(Math.max(SLASH_COMMAND_LAYOUT.firstLevelMaxRows, SLASH_COMMAND_LAYOUT.nestedMaxRows));
		activeRailEditors.add(this);
	}

	hideSlashOverlay(): void {
		this.slashOverlay?.hide();
		this.slashOverlay = undefined;
		this.slashOverlaySignature = undefined;
	}

	private getAutocompleteList(): Component | undefined {
		return (this as any).autocompleteList as Component | undefined;
	}

	private slashLevelFromEditorText(prefix?: string): SlashAutocompleteLevel | undefined {
		if (typeof prefix === "string" && prefix.trimStart().startsWith("/")) return "top";

		const cursor = this.getCursor();
		if (cursor.line !== 0) return undefined;
		const beforeCursor = (this.editorLinesRef()[0] ?? "").slice(0, cursor.col).trimStart();
		if (!beforeCursor.startsWith("/")) return undefined;
		return beforeCursor.includes(" ") ? "nested" : "top";
	}

	private getSlashAutocompleteLevel(): SlashAutocompleteLevel | undefined {
		if (!(this as any).autocompleteState || !this.getAutocompleteList()) return undefined;
		return this.slashLevelFromEditorText((this as any).autocompletePrefix);
	}

	private slashRowsForLevel(level: SlashAutocompleteLevel): number {
		return level === "top" ? SLASH_COMMAND_LAYOUT.firstLevelMaxRows : SLASH_COMMAND_LAYOUT.nestedMaxRows;
	}

	createAutocompleteList(prefix: string, items: any[]): SelectList {
		const level = this.slashLevelFromEditorText(prefix);
		const maxVisible = level ? this.slashRowsForLevel(level) : this.getAutocompleteMaxVisible();
		const layout = level
			? {
					minPrimaryColumnWidth: SLASH_COMMAND_LAYOUT.minPrimaryColumnWidth,
					maxPrimaryColumnWidth: SLASH_COMMAND_LAYOUT.maxPrimaryColumnWidth,
				}
			: undefined;
		return new SelectList(items, maxVisible, this.selectListTheme, layout);
	}

	private cursorVisualIndex(visualMap: VisualRow[], lines: string[], cursor = this.getCursor()): number {
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

	private highlightPasteMarkers(text: string): string {
		if (!text.includes("[paste #")) return text;
		return text.replace(PASTE_MARKER_RE, (marker) => {
			const coloredMarker = applyTextColor(this.appTheme, EDITOR_PASTE_MARKER_STYLE.foreground, marker);
			return `${EDITOR_PASTE_MARKER_STYLE.background}${EDITOR_PASTE_MARKER_STYLE.bold}${coloredMarker}${EDITOR_PASTE_MARKER_STYLE.reset}`;
		});
	}

	private renderVisualRow(row: VisualRow, contentWidth: number, paddingX: number, lines: string[], cursor = this.getCursor()): string {
		let text = row.text;
		const emitCursorMarker = this.focused && !(this as any).autocompleteState;
		const lineEnd = (lines[row.logicalLine] ?? "").length;
		const cursorInRow =
			cursor.line === row.logicalLine &&
			cursor.col >= row.startIndex &&
			(cursor.col < row.endIndex || (row.endIndex === lineEnd && cursor.col === row.endIndex));

		if (cursorInRow) {
			const localCol = Math.max(0, cursor.col - row.startIndex);
			const before = text.slice(0, localCol);
			const after = text.slice(localCol);
			const marker = emitCursorMarker ? CURSOR_MARKER : "";
			const first = segmenter.segment(after)[Symbol.iterator]().next().value?.segment;
			if (first) {
				text = `${before}${marker}\x1b[7m${first}\x1b[0m${after.slice(first.length)}`;
			} else {
				text = `${before}${marker}\x1b[7m \x1b[0m`;
			}
		}

		text = this.highlightPasteMarkers(text);

		const textWidth = Math.max(1, contentWidth - paddingX * 2);
		const textVisibleWidth = visibleWidth(text);
		const fitted = textVisibleWidth <= textWidth ? text + " ".repeat(textWidth - textVisibleWidth) : padToWidth(text, textWidth);
		return `${" ".repeat(paddingX)}${fitted}${" ".repeat(paddingX)}`;
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
		paddingX: number,
		lines: string[],
		cursor = this.getCursor(),
	): string {
		const lineEnd = (lines[row.logicalLine] ?? "").length;
		const cursorInRow =
			cursor.line === row.logicalLine &&
			cursor.col >= row.startIndex &&
			(cursor.col < row.endIndex || (row.endIndex === lineEnd && cursor.col === row.endIndex));
		const key = [
			contentWidth,
			paddingX,
			index,
			visibleRows,
			totalRows,
			start,
			row.logicalLine,
			row.startIndex,
			row.endIndex,
			row.text,
			cursorInRow ? `${cursor.line}:${cursor.col}:${this.focused ? 1 : 0}:${(this as any).autocompleteState ? 1 : 0}` : "",
		].join("\u001f");
		const cached = this.rowRenderCache.get(key);
		if (cached !== undefined) return cached;

		const line = this.renderVisualRow(row, contentWidth, paddingX, lines, cursor);
		const rendered = this.renderEditorScrollbar(line, index, visibleRows, totalRows, start, contentWidth);
		if (this.rowRenderCache.size > 512) this.rowRenderCache.clear();
		this.rowRenderCache.set(key, rendered);
		return rendered;
	}

	private editorBodyRows(width: number, lines: string[] = this.editorLinesRef()): { rows: string[]; visualMapStart: number; visibleMap: VisualRow[] } {
		const contentWidth = this.surface.contentWidth(width);
		const paddingX = this.getPaddingX?.() ?? 0;
		const innerWidth = Math.max(1, contentWidth - paddingX * 2);
		const layoutWidth = Math.max(1, innerWidth - (paddingX ? 0 : 1));
		const visualMap = this.getCachedVisualMap(layoutWidth, lines);
		const targetRows = this.surface.targetInputHeight(visualMap.length, this.tui.terminal.rows);
		this.editorScrollMax = Math.max(0, visualMap.length - targetRows);

		const cursor = this.getCursor();
		if (!this.editorManualScroll) {
			const cursorIndex = this.cursorVisualIndex(visualMap, lines, cursor);
			if (cursorIndex < this.editorScrollOffset) this.editorScrollOffset = cursorIndex;
			else if (cursorIndex >= this.editorScrollOffset + targetRows) this.editorScrollOffset = cursorIndex - targetRows + 1;
		}
		this.editorScrollOffset = Math.max(0, Math.min(this.editorScrollOffset, this.editorScrollMax));

		const visibleRows = visualMap.slice(this.editorScrollOffset, this.editorScrollOffset + targetRows);
		return {
			visualMapStart: this.editorScrollOffset,
			visibleMap: visibleRows,
			rows: visibleRows.map((row, index) =>
				this.renderedBodyRow(row, index, targetRows, visualMap.length, this.editorScrollOffset, contentWidth, paddingX, lines, cursor),
			),
		};
	}

	protected handleMouseWheel(wheel: ParsedWheel): boolean {
		if (!EDITOR_MOUSE_TRACKING_ENABLED && !CONVERSATION_SCROLL_LAYOUT.enabled) return false;
		this.editorManualScroll = true;
		this.editorScrollOffset = Math.max(
			0,
			Math.min(this.editorScrollMax, this.editorScrollOffset - wheel.direction * CONVERSATION_SCROLL_LAYOUT.wheelStepRows),
		);
		this.tui.requestRender();
		return true;
	}

	setText(text: string): void {
		this.visualMapCache = undefined;
		this.rowRenderCache.clear();
		this.renderCache = undefined;
		super.setText(text);
	}

	insertTextAtCursor(text: string): void {
		this.renderCache = undefined;
		super.insertTextAtCursor(text);
	}

	handleInput(data: string): void {
		const isEscapeSequence = data.charCodeAt(0) === 0x1b;
		const isMouseOrCursor = isEscapeSequence && Boolean(parseWheel(data) || parseMouse(data) || parseCursorPosition(data));
		if (!isMouseOrCursor) {
			this.editorManualScroll = false;
			this.renderCache = undefined;
		}
		super.handleInput(data);
	}

	private defaultCompletionRows(contentWidth: number, slashAutocompleteLevel: SlashAutocompleteLevel | undefined): string[] {
		if (slashAutocompleteLevel || !(this as any).autocompleteState) return [];
		return this.getAutocompleteList()?.render(contentWidth) ?? [];
	}

	private syncSlashOverlay(level: SlashAutocompleteLevel | undefined, editorRows: number, width: number): void {
		if (!level || width < this.slashOverlaySurface.minRenderableWidth()) {
			this.hideSlashOverlay();
			return;
		}

		const bottomMargin = editorRows + SLASH_COMMAND_LAYOUT.bottomReservedRows;
		const maxRows = this.slashRowsForLevel(level);
		const signature = `${level}:${width}:${bottomMargin}:${maxRows}`;
		if (this.slashOverlay && this.slashOverlaySignature === signature) return;

		this.hideSlashOverlay();
		this.slashOverlaySignature = signature;
		this.slashOverlay = this.tui.showOverlay(
			new SlashCommandOverlay(() => this.getAutocompleteList(), () => maxRows, this.slashOverlaySurface),
			{
				width,
				maxHeight: maxRows,
				anchor: "bottom-left",
				margin: { bottom: bottomMargin },
				nonCapturing: true,
			},
		);
	}

	private renderSurfaceRows(
		width: number,
		body: { rows: string[]; visualMapStart: number; visibleMap: VisualRow[] },
		contentWidth: number,
		completionRows: string[],
	): { rows: string[]; mouseLayout: MouseLayout } {
		const targetRows = this.surface.targetInputHeight(body.visibleMap.length, this.tui.terminal.rows);
		const blankRows = Math.max(0, targetRows - body.rows.length);
		const topPadding = Math.floor(blankRows / 2);
		const bottomPadding = blankRows - topPadding;
		const paddingX = this.getPaddingX?.() ?? 0;
		const rows: string[] = [];
		for (let i = 0; i < topPadding; i++) rows.push(this.surface.renderSurfaceRow(width));
		for (let index = 0; index < body.rows.length; index++) {
			const row = body.visibleMap[index];
			const selection = row ? this.selectionColumnsForRow(row) : undefined;
			const line = selection
				? this.surface.highlightColumns(body.rows[index] ?? "", selection.startCol + paddingX, selection.endCol + paddingX)
				: body.rows[index] ?? "";
			rows.push(this.surface.renderSurfaceRow(width, line));
		}
		for (let i = 0; i < bottomPadding; i++) rows.push(this.surface.renderSurfaceRow(width));
		for (const line of completionRows) rows.push(this.surface.renderCompletion(width, line));

		const cursorLocalRow = rows.findIndex((line) => line.includes(CURSOR_MARKER));
		const cursorLine = cursorLocalRow >= 0 ? rows[cursorLocalRow]! : rows[0] ?? "";
		const markerIndex = cursorLine.indexOf(CURSOR_MARKER);
		return {
			rows,
			mouseLayout: {
				contentStartCol: this.surface.contentStartCol(),
				contentWidth,
				topPadding,
				visibleMap: body.visibleMap,
				cursorLocalRow: Math.max(0, cursorLocalRow),
				cursorLocalCol: markerIndex >= 0 ? visibleWidth(cursorLine.slice(0, markerIndex)) : 0,
			},
		};
	}

	private renderSignature(width: number, lines: string[], slashAutocompleteLevel: SlashAutocompleteLevel | undefined): string {
		const cursor = this.getCursor();
		const selection = this.getSelectionRange();
		const autocomplete = this as any;
		return [
			width,
			this.tui.terminal.rows,
			this.focused ? 1 : 0,
			cursor.line,
			cursor.col,
			this.editorScrollOffset,
			this.editorManualScroll ? 1 : 0,
			slashAutocompleteLevel ?? "",
			autocomplete.autocompleteState ? 1 : 0,
			autocomplete.autocompletePrefix ?? "",
			selection ? `${selection.start.line}:${selection.start.col}:${selection.end.line}:${selection.end.col}` : "",
			lines.length,
		].join("\u001f");
	}

	render(width: number): string[] {
		if (width < this.surface.minRenderableWidth()) {
			this.hideSlashOverlay();
			return super.render(width);
		}

		const slashAutocompleteLevel = this.getSlashAutocompleteLevel();
		const lines = this.editorLinesRef();
		const signature = this.renderSignature(width, lines, slashAutocompleteLevel);
		if (this.renderCache?.linesRef === lines && this.renderCache.signature === signature) return this.renderCache.rows;

		const body = this.editorBodyRows(width, lines);
		const contentWidth = this.surface.contentWidth(width);
		const completionRows = this.defaultCompletionRows(contentWidth, slashAutocompleteLevel);
		const result = this.renderSurfaceRows(width, body, contentWidth, completionRows);

		this.setMouseLayout(result.mouseLayout);
		this.syncSlashOverlay(slashAutocompleteLevel, result.rows.length, width);
		this.renderCache = { signature, linesRef: lines, rows: result.rows };
		return result.rows;
	}
}
