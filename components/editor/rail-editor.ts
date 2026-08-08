import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { completeSkillCommandWithoutSubmit } from "./rail-editor-autocomplete";
import { EDITOR_PASTE_MARKER_STYLE, SLASH_COMMAND_LAYOUT, applyTextColor } from "../../config";
import { railEditorSurface, type EditorSurfaceRenderer } from "../../rail/rail-surface";

const PASTE_MARKER_RE = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g;

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
		if (width < this.surface.minRenderableWidth()) return super.render(Math.max(1, width));

		// Pi's editor remains the owner of wrapping, cursor placement, paste
		// markers, autocomplete rows, and internal editor scrolling. Rail only
		// adds the visual surface around the rows it produced.
		const nativeRows = super.render(this.surface.contentWidth(width));
		return nativeRows.map((row) => this.surface.renderSurfaceRow(width, highlightPasteMarkers(row, this.appTheme)));
	}
}
