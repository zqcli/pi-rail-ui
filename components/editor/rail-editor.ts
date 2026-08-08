import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { completeSkillCommandWithoutSubmit } from "./rail-editor-autocomplete";
import { EDITOR_PASTE_MARKER_STYLE, SLASH_COMMAND_LAYOUT, applyTextColor } from "../../config";
import { stripAnsi } from "../../core/utils";
import { railEditorSurface, type EditorSurfaceRenderer } from "../../rail/rail-surface";

const PASTE_MARKER_RE = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const NATIVE_EDITOR_BORDER_RE = /^(?:─+|─── [↑↓].*|─{0,3}\.{1,3})$/u;

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

function fitEditorBodyRows(rows: string[], targetRows: number): string[] {
	if (rows.length === targetRows) return rows;
	if (rows.length < targetRows) {
		const blankRows = targetRows - rows.length;
		const topPadding = Math.floor(blankRows / 2);
		return [
			...Array.from({ length: topPadding }, () => ""),
			...rows,
			...Array.from({ length: blankRows - topPadding }, () => ""),
		];
	}

	const cursorRow = rows.findIndex((row) => row.includes(CURSOR_MARKER));
	const start = cursorRow < 0
		? 0
		: Math.max(0, Math.min(rows.length - targetRows, cursorRow - targetRows + 1));
	return rows.slice(start, start + targetRows);
}

export class RailEditor extends CustomEditor {
	private readonly keybindingManager: KeybindingsManager;

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
		if (completeSkillCommandWithoutSubmit({
			editor: this,
			data,
			keybindings: this.keybindingManager,
			requestRender: () => this.tui.requestRender(),
		})) return;
		super.handleInput(data);
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
		const rows = [...fitEditorBodyRows(native.body, targetRows), ...native.completion];
		if (width < this.surface.minRenderableWidth()) return rows;
		return rows.map((row) => this.surface.renderSurfaceRow(width, highlightPasteMarkers(row, this.appTheme)));
	}
}
