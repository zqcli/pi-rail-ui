import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, matchesKey, type Component, type EditorTheme, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { SlashCommandOverlay } from "./slash-autocomplete";
import { completeSkillCommandWithoutSubmit } from "./rail-editor-autocomplete";
import { CONVERSATION_SCROLL_LAYOUT, EDITOR_MOUSE_TRACKING_ENABLED, SLASH_COMMAND_LAYOUT, applyTextColor } from "../../config";
import { selectorOutputSurfaceForTheme, railEditorSurface, type EditorSurfaceRenderer } from "../../rail/rail-surface";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { showFooterSelectionNotice } from "../footer";
import { RailEditorFrameRenderer } from "./rail-editor-frame";
import { RailEditorSelectionEngine, type RailEditorSelectionHost } from "./rail-editor-selection";
import {
	CURSOR_POSITION_RE,
	SGR_MOUSE_RE,
	clampPosition,
	parseWheel,
	type ParsedMouse,
	type ParsedWheel,
	type Position,
} from "../../core/utils";

// 1007 keeps wheel events from falling through to the terminal's native
// scrollback while the app-level chat viewport is active.
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1007l";

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

export class MouseSelectableRailEditor extends CustomEditor {
	private readonly selectionEngine = new RailEditorSelectionEngine();

	setSelectionRange(anchor: Position, active: Position): void {
		this.selectionEngine.setSelectionRange(anchor, active);
		this.tui.requestRender();
	}

	clearSelection(): void {
		if (this.selectionEngine.clearSelection()) this.tui.requestRender();
	}

	protected setMouseLayout(layout: Parameters<RailEditorSelectionEngine["setMouseLayout"]>[0]): void {
		this.selectionEngine.setMouseLayout(layout);
	}

	protected getSelectionRange(): { start: Position; end: Position } | undefined {
		return this.selectionEngine.selectionRange();
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

	private deleteSelection(): boolean {
		return this.selectionEngine.deleteSelection(this.selectionHost());
	}

	protected handleMouseWheel(_wheel: ParsedWheel): boolean {
		return false;
	}

	private copySelectionTextToClipboard(text: string): void {
		if (!text) return;
		void copyToClipboard(text).then(
			() => showFooterSelectionNotice(this.tui),
			() => {
				// pi's copyToClipboard throws on failure; selection copy should stay
				// silent rather than interrupt the editing flow.
			},
		);
	}

	private selectionHost(): RailEditorSelectionHost {
		return {
			lines: () => this.editorLinesRef(),
			setText: (text) => this.setText(text),
			moveCursorToPosition: (pos) => this.moveCursorToPosition(pos),
			copyText: (text) => this.copySelectionTextToClipboard(text),
			requestRender: () => this.tui.requestRender(),
		};
	}

	override handleInput(data: string): void {
		if (data.charCodeAt(0) === 0x1b) {
			const wheel = parseWheel(data);
			if (wheel && this.handleMouseWheel(wheel)) return;

			const mouse = parseMouse(data);
			if (mouse) {
				if (!EDITOR_MOUSE_TRACKING_ENABLED && !CONVERSATION_SCROLL_LAYOUT.enabled) return;
				this.selectionEngine.handleMouse(mouse, this.selectionHost(), requestCursorPosition);
				return;
			}

			const cursor = parseCursorPosition(data);
			if (cursor) {
				this.selectionEngine.handleCursorPosition(cursor, this.selectionHost());
				return;
			}
		}

		if (this.getSelectionRange()) {
			if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
				this.deleteSelection();
				return;
			}

			// Printable input replaces the selection. Check only the first char so
			// multi-char IME commits behave like single ASCII keystrokes; escape
			// sequences and control keys (charCode < 32) still fall through below.
			if (data.charCodeAt(0) >= 32) {
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
	private slashOverlay?: OverlayHandle | undefined;
	private slashOverlaySignature?: string | undefined;
	private readonly slashOverlaySurface: EditorSurfaceRenderer;
	private readonly selectListTheme: EditorTheme["selectList"];
	private readonly keybindingManager: KeybindingsManager;
	private readonly frameRenderer = new RailEditorFrameRenderer();

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
		this.selectListTheme = themedEditorTheme.selectList;
		this.slashOverlaySurface = selectorOutputSurfaceForTheme(appTheme);
		(this as any).createAutocompleteList = (prefix: string, items: any[]) => this.createRailAutocompleteList(prefix, items);
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

	private createRailAutocompleteList(prefix: string, items: any[]): SelectList {
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

	protected override handleMouseWheel(wheel: ParsedWheel): boolean {
		if (!EDITOR_MOUSE_TRACKING_ENABLED && !CONVERSATION_SCROLL_LAYOUT.enabled) return false;
		this.frameRenderer.scrollBy(-wheel.direction * CONVERSATION_SCROLL_LAYOUT.wheelStepRows);
		this.tui.requestRender();
		return true;
	}

	override setText(text: string): void {
		this.frameRenderer.resetContent();
		super.setText(text);
	}

	override insertTextAtCursor(text: string): void {
		this.frameRenderer.resetRender();
		super.insertTextAtCursor(text);
	}

	override handleInput(data: string): void {
		const isEscapeSequence = data.charCodeAt(0) === 0x1b;
		const isMouseOrCursor = isEscapeSequence && Boolean(parseWheel(data) || parseMouse(data) || parseCursorPosition(data));
		if (!isMouseOrCursor) {
			this.frameRenderer.markTextInput();
		}
		if (completeSkillCommandWithoutSubmit({ editor: this, data, keybindings: this.keybindingManager, requestRender: () => this.tui.requestRender() })) return;
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

	override render(width: number): string[] {
		if (width < this.surface.minRenderableWidth()) {
			this.hideSlashOverlay();
			return super.render(width);
		}

		const slashAutocompleteLevel = this.getSlashAutocompleteLevel();
		const lines = this.editorLinesRef();
		const contentWidth = this.surface.contentWidth(width);
		const completionRows = this.defaultCompletionRows(contentWidth, slashAutocompleteLevel);
		const autocomplete = this as any;
		const result = this.frameRenderer.render({
			width,
			terminalRows: this.tui.terminal.rows,
			lines,
			cursor: this.getCursor(),
			focused: this.focused,
			paddingX: this.getPaddingX?.() ?? 0,
			autocompleteActive: Boolean(autocomplete.autocompleteState),
			autocompletePrefix: autocomplete.autocompletePrefix ?? "",
			slashAutocompleteLevel,
			selection: this.getSelectionRange(),
			completionRows,
			surface: this.surface,
			appTheme: this.appTheme,
		});

		this.setMouseLayout(result.mouseLayout);
		this.syncSlashOverlay(slashAutocompleteLevel, result.rows.length, width);
		return result.rows;
	}
}
