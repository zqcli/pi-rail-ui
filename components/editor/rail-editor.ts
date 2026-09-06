import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { completeSlashCommandWithoutSubmit } from "./rail-editor-autocomplete";
import { EDITOR_PASTE_MARKER_STYLE, SLASH_COMMAND_LAYOUT, applyTextColor } from "../../config";
import { railEditorSurface, type EditorSurfaceRenderer } from "../../rail/rail-surface";

const PASTE_MARKER_RE = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g;
// Controlled bottom-border marker separates body rows from the completion rows
// below it (native rows: blank top, body, sentinel bottom, completion). The
// marker is stripped before the final render; the top border is "" at index 0.
const BOTTOM_BORDER_SENTINEL = "\x1b]rail-editor-bottom\x07";

/**
 * Per-screen-row native editor row index (built during render) for mouse
 * translation: body rows resolve into the native 1-based body offset, padded
 * blank rows are `undefined`. Wrap/grapheme/scroll/autocomplete resolution is
 * left to the native Editor via `super.handleMouse`.
 */
type RailMouseGeometry = { nativeWidth: number; nativeHeight: number };

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

export class RailEditor extends CustomEditor {
	private readonly keybindingManager: KeybindingsManager;
	private railMouseRows?: Array<number | undefined> | undefined;
	private railMouseGeometry?: RailMouseGeometry | undefined;

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
		if (completeSlashCommandWithoutSubmit({
			editor: this,
			data,
			keybindings: this.keybindingManager,
			requestRender: () => this.tui.requestRender(),
		})) return;
		super.handleInput(data);
	}

	// Rail owns the editor chrome; Pi owns the native frame. Blank/deterministic
	// border hooks make the body/completion boundary exact (no pattern matching).
	override renderTopBorder(_width: number, _hiddenLineCount: number): string {
		return "";
	}

	override renderBottomBorder(_width: number, _hiddenLineCount: number): string {
		return BOTTOM_BORDER_SENTINEL;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const rows = this.railMouseRows;
		const geometry = this.railMouseGeometry;
		if (!rows || !geometry) return super.handleMouse(event);

		const nativeY = rows[event.y];
		if (nativeY === undefined) {
			// Padded blank rail row: mirror the native border-click contract
			// (left-click focuses only; selection owns non-click events).
			if (event.type !== "click" || event.button !== "left") return undefined;
			return { handled: true, focus: true };
		}

		const railOffset = event.width < this.surface.minRenderableWidth() ? 0 : this.surface.contentStartCol();
		const translated: TuiMouseEvent = {
			...event,
			x: event.x - railOffset,
			y: nativeY,
			width: geometry.nativeWidth,
			height: geometry.nativeHeight,
		};
		return super.handleMouse(translated);
	}

	override render(width: number): string[] {
		// Pi's editor remains the owner of wrapping, cursor placement, paste
		// markers, autocomplete rows, and internal editor scrolling. Rail removes
		// Pi's horizontal frame (deterministic border markers above), applies the
		// configured height window, and adds its own visual surface around the
		// native rows.
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
		let nativeWidth: number;
		try {
			nativeWidth = width < this.surface.minRenderableWidth()
				? Math.max(1, width)
				: this.surface.contentWidth(width);
			nativeRows = super.render(nativeWidth);
		} finally {
			this.tui = originalTui;
		}

		// bottomIdx is the sentinel border row: body is [1, bottomIdx),
		// completion rows are [bottomIdx + 1, ...).
		const bottomIdx = nativeRows.lastIndexOf(BOTTOM_BORDER_SENTINEL);
		const body = bottomIdx > 1 ? nativeRows.slice(1, bottomIdx) : [];
		const completion = bottomIdx >= 0 ? nativeRows.slice(bottomIdx + 1) : [];
		const targetRows = this.surface.targetInputHeight(body.length, terminalRows);
		const fitted = fitEditorBodyRows(body, targetRows);

		this.railMouseRows = fitted.sourceRows.map((sourceRow) => sourceRow === undefined ? undefined : sourceRow + 1);
		for (let index = 0; index < completion.length; index++) {
			this.railMouseRows.push(bottomIdx + 1 + index);
		}
		this.railMouseGeometry = { nativeWidth, nativeHeight: nativeRows.length };

		const rows = [...fitted.rows, ...completion];
		if (width < this.surface.minRenderableWidth()) return rows;
		return rows.map((row) => this.surface.renderSurfaceRow(width, highlightPasteMarkers(row, this.appTheme)));
	}
}