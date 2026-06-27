import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type AutocompleteProviderLike = {
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
};

type EditorAutocompleteInternals = {
	state?: { lines: string[]; cursorLine: number; cursorCol: number } | undefined;
	autocompleteState?: unknown;
	autocompleteProvider?: AutocompleteProviderLike | undefined;
	autocompletePrefix?: unknown;
	autocompleteList?: { getSelectedItem?(): AutocompleteItem | null } | undefined;
	pushUndoSnapshot?(): void;
	setCursorCol?(col: number): void;
	cancelAutocomplete?(): void;
	onChange?: ((text: string) => void) | undefined;
	lastAction?: unknown;
	getText?(): string;
};

export type SkillAutocompleteCompletionInput = {
	editor: unknown;
	data: string;
	keybindings: Pick<KeybindingsManager, "matches">;
	requestRender(): void;
};

function selectedSkillCommand(editor: EditorAutocompleteInternals): AutocompleteItem | undefined {
	const selected = editor.autocompleteList?.getSelectedItem?.();
	if (!selected || typeof selected.value !== "string" || !selected.value.startsWith("skill:")) return undefined;
	return selected;
}

export function completeSkillCommandWithoutSubmit(input: SkillAutocompleteCompletionInput): boolean {
	if (!input.keybindings.matches(input.data, "tui.select.confirm")) return false;

	const editor = input.editor as EditorAutocompleteInternals;
	const prefix = editor.autocompletePrefix;
	const state = editor.state;
	const selected = selectedSkillCommand(editor);
	if (!editor.autocompleteState || !editor.autocompleteProvider || typeof prefix !== "string" || !prefix.startsWith("/")) return false;
	if (!state || !Array.isArray(state.lines) || !selected) return false;

	editor.pushUndoSnapshot?.();
	editor.lastAction = null;
	const result = editor.autocompleteProvider.applyCompletion(
		state.lines,
		state.cursorLine,
		state.cursorCol,
		selected,
		prefix,
	);
	state.lines = result.lines;
	state.cursorLine = result.cursorLine;
	if (typeof editor.setCursorCol === "function") editor.setCursorCol(result.cursorCol);
	else state.cursorCol = result.cursorCol;
	editor.cancelAutocomplete?.();
	editor.onChange?.(editor.getText?.() ?? state.lines.join("\n"));
	input.requestRender();
	return true;
}