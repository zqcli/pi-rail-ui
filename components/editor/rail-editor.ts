import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { completeSkillCommandWithoutSubmit } from "./rail-editor-autocomplete";
import { EDITOR_PASTE_MARKER_STYLE, SLASH_COMMAND_LAYOUT, applyTextColor } from "../../config";
import { stripAnsi } from "../../core/utils";
import { railEditorSurface, type EditorSurfaceRenderer } from "../../rail/rail-surface";

const PASTE_MARKER_RE = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const NATIVE_EDITOR_BORDER_RE = /^(?:─+|─── [↑↓].*|─{0,3}\.{1,3})$/u;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type NativeVisualLine = { logicalLine: number; startCol: number; length: number };
type EditorMouseRow = NativeVisualLine & { text: string };
type EditorMouseLayout = { contentStartCol: number; rows: Array<EditorMouseRow | undefined> };

function selectListThemeForRailSlashMenu(theme: EditorTheme, appTheme: Theme): EditorTheme {
	return {
		...theme,
		selectList: {
			...theme.selectList,
			selectedText: (text: string) => applyTextColor(appTheme, SLASH_COMMAND_LAYOUT.selectedText, text),
		},
	};
}

function highlightPasteMarkers(text: string, appTheme: Theme): string {
	if (!text.includes("[paste #")) return text;
	return text.replace(PASTE_MARKER_RE, (marker) => {
		const coloredMarker = applyTextColor(appTheme, EDITOR_PASTE_MARKER_STYLE.foreground, marker);
		return `${EDITOR_PASTE_MARKER_STYLE.background}${EDITOR_PASTE_MARKER_STYLE.bold}${coloredMarker}${EDITOR_PASTE_MARKER_STYLE.reset}`;
	});
}

function isNativeEditorBorder(row: string | undefined): boolean {
	return row !== undefined && NATIVE_EDITOR_BORDER_RE.test(stripAnsi(row));
}

function splitNativeEditorRows(rows: string[]): { body: string[]; completion: string[] } {
	if (!isNativeEditorBorder(rows[0])) return { body: rows, completion: [] };
	let bottomBorder = -1;
	for (let index = rows.length - 1; index > 0; index--) {
		if (isNativeEditorBorder(rows[index])) {
			bottomBorder = index;
			break;
		}
	}
	if (bottomBorder < 0) return { body: rows.slice(1), completion: [] };
	return {
		body: rows.slice(1, bottomBorder),
		completion: rows.slice(bottomBorder + 1),
	};
}

function terminalRowsForNativeEditor(visibleLines: number): number {
	let rows = Math.max(1, Math.ceil(visibleLines / 0.3));
	while (Math.max(5, Math.floor(rows * 0.3)) < visibleLines) rows++;
	return rows;
}

function fitEditorBodyRows(rows: string[], targetRows: number): { rows: string[]; sourceRows: Array<number | undefined> } {
	if (rows.length === targetRows) return { rows, sourceRows: rows.map((_, index) => index) };
	if (rows.length < targetRows) {
		const blankRows = targetRows - rows.length;
		const topPadding = Math.floor(blankRows / 2);
		return {
			rows: [
				...Array.from({ length: topPadding }, () => ""),
				...rows,
				...Array.from({ length: blankRows - topPadding }, () => ""),
			],
			sourceRows: [
				...Array.from({ length: topPadding }, () => undefined),
				...rows.map((_, index) => index),
				...Array.from({ length: blankRows - topPadding }, () => undefined),
			],
		};
	}

	const cursorRow = rows.findIndex((row) => row.includes(CURSOR_MARKER));
	const start = cursorRow < 0
		? 0
		: Math.max(0, Math.min(rows.length - targetRows, cursorRow - targetRows + 1));
	return {
		rows: rows.slice(start, start + targetRows),
		sourceRows: Array.from({ length: targetRows }, (_, index) => start + index),
	};
}

function indexForVisibleColumn(text: string, targetColumn: number): number {
	if (targetColumn <= 0) return 0;
	let column = 0;
	for (const segment of graphemeSegmenter.segment(text)) {
		const nextColumn = column + visibleWidth(segment.segment);
		if (targetColumn < nextColumn) return segment.index;
		column = nextColumn;
	}
	return text.length;
}

export class RailEditor extends CustomEditor {
	private readonly keybindingManager: KeybindingsManager;
	private mouseLayout?: EditorMouseLayout | undefined;
	private mouseVisualCache?: { width: number; rows: EditorMouseRow[] } | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly appTheme: Theme,
		private readonly surface: EditorSurfaceRenderer = railEditorSurface,
	) {
		const themedEditorTheme = selectListThemeForRailSlashMenu(theme, appTheme);
		super(tui, themedEditorTheme, keybindings);
		this.keybindingManager = keybindings;
	}

	override handleInput(data: string): void {
		this.mouseVisualCache = undefined;
		if (completeSkillCommandWithoutSubmit({
			editor: this,
			data,
			keybindings: this.keybindingManager,
			requestRender: () => this.tui.requestRender(),
		})) return;
		super.handleInput(data);
	}

	moveCursorToMousePosition(localRow: number, localCol: number): boolean {
		const layout = this.mouseLayout;
		const row = layout?.rows[localRow];
		if (!layout || !row) return false;

		const targetColumn = Math.max(0, localCol - layout.contentStartCol);
		const cursorCol = row.startCol + indexForVisibleColumn(row.text, targetColumn);
		const editor = this as any;
		editor.cancelAutocomplete?.();
		editor.lastAction = null;
		editor.exitHistoryBrowsing?.();
		editor.preferredVisualCol = null;
		editor.snappedFromCursorCol = null;
		editor.state.cursorLine = row.logicalLine;
		if (typeof editor.setCursorCol === "function") editor.setCursorCol(cursorCol);
		else editor.state.cursorCol = cursorCol;
		this.tui.requestRender();
		return true;
	}

	override setText(text: string): void {
		this.mouseVisualCache = undefined;
		super.setText(text);
	}

	override insertTextAtCursor(text: string): void {
		this.mouseVisualCache = undefined;
		super.insertTextAtCursor(text);
	}

	override render(width: number): string[] {
		// Pi's editor remains the owner of wrapping, cursor placement, paste
		// markers, autocomplete rows, and internal editor scrolling. Rail removes
		// Pi's horizontal frame, applies the configured height window, and adds its
		// own visual surface around the remaining native rows.
		const terminalRows = Math.max(1, Math.floor(this.tui.terminal.rows));
		const maxInputHeight = this.surface.maxInputHeight(terminalRows);
		const originalTui = this.tui;
		const nativeMaxInputHeight = Math.max(5, Math.floor(terminalRows * 0.3));
		if (maxInputHeight !== undefined && maxInputHeight > nativeMaxInputHeight) {
			const renderRows = terminalRowsForNativeEditor(maxInputHeight);
			const terminal = originalTui.terminal;
			const renderTerminal = new Proxy(terminal, {
				get(target, property) {
					if (property === "rows") return renderRows;
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			this.tui = new Proxy(originalTui, {
				get(target, property, receiver) {
					if (property === "terminal") return renderTerminal;
					return Reflect.get(target, property, receiver);
				},
			});
		}

		let nativeRows: string[];
		try {
			const nativeWidth = width < this.surface.minRenderableWidth()
				? Math.max(1, width)
				: this.surface.contentWidth(width);
			nativeRows = super.render(nativeWidth);
		} finally {
			this.tui = originalTui;
		}

		const native = splitNativeEditorRows(nativeRows);
		const targetRows = this.surface.targetInputHeight(native.body.length, terminalRows);
		const fitted = fitEditorBodyRows(native.body, targetRows);
		const editor = this as any;
		const cachedVisualRows = this.mouseVisualCache;
		let visualRows: EditorMouseRow[] | undefined;
		if (cachedVisualRows && cachedVisualRows.width === editor.lastWidth) visualRows = cachedVisualRows.rows;
		if (!visualRows) {
			const visualLines = editor.buildVisualLineMap(editor.lastWidth) as NativeVisualLine[];
			const layoutLines = editor.layoutText(editor.lastWidth) as Array<{ text: string }>;
			visualRows = visualLines.map((visual, index) => ({
				...visual,
				text: layoutLines[index]?.text ?? "",
			}));
			this.mouseVisualCache = { width: editor.lastWidth, rows: visualRows };
		}
		const scrollOffset = Math.max(0, Number(editor.scrollOffset) || 0);
		const visibleVisualLines = visualRows.slice(scrollOffset, scrollOffset + native.body.length);
		this.mouseLayout = {
			contentStartCol: (width < this.surface.minRenderableWidth() ? 0 : this.surface.contentStartCol()) + this.getPaddingX(),
			rows: [
				...fitted.sourceRows.map((sourceRow) => {
					if (sourceRow === undefined) return undefined;
					const visual = visibleVisualLines[sourceRow];
					return visual ? { ...visual } : undefined;
				}),
				...native.completion.map(() => undefined),
			],
		};
		const rows = [...fitted.rows, ...native.completion];
		if (width < this.surface.minRenderableWidth()) return rows;
		return rows.map((row) => this.surface.renderSurfaceRow(width, highlightPasteMarkers(row, this.appTheme)));
	}
}
