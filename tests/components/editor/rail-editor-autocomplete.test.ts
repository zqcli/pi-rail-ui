import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { completeSkillCommandWithoutSubmit } from "../../../components/editor/rail-editor-autocomplete";

describe("rail editor autocomplete seam", () => {
	test("applies selected skill completion without crossing the submit path", () => {
		let changed = "";
		let rendered = false;
		const provider = new CombinedAutocompleteProvider([
			{ name: "skill:web-access", description: "Search the web" },
		], process.cwd());
		const editor = {
			state: { lines: ["/ski"], cursorLine: 0, cursorCol: 4 },
			autocompleteState: {} as unknown,
			autocompleteProvider: provider,
			autocompletePrefix: "/ski",
			autocompleteList: { getSelectedItem: () => ({ value: "skill:web-access", label: "skill:web-access" }) },
			pushUndoSnapshot() {},
			setCursorCol(col: number) {
				this.state.cursorCol = col;
			},
			cancelAutocomplete() {
				this.autocompleteState = null;
			},
			getText() {
				return this.state.lines.join("\n");
			},
			onChange(text: string) {
				changed = text;
			},
		};

		const handled = completeSkillCommandWithoutSubmit({
			editor,
			data: "enter",
			keybindings: { matches: (data, keybinding) => data === "enter" && keybinding === "tui.select.confirm" },
			requestRender: () => { rendered = true; },
		});

		assert.equal(handled, true);
		assert.equal(editor.getText(), "/skill:web-access ");
		assert.equal(editor.state.cursorCol, "/skill:web-access ".length);
		assert.equal(editor.autocompleteState, null);
		assert.equal(changed, "/skill:web-access ");
		assert.equal(rendered, true);
	});

	test("leaves non-skill slash completions to the editor implementation", () => {
		const editor = {
			state: { lines: ["/set"], cursorLine: 0, cursorCol: 4 },
			autocompleteState: {},
			autocompleteProvider: new CombinedAutocompleteProvider([{ name: "settings" }], process.cwd()),
			autocompletePrefix: "/set",
			autocompleteList: { getSelectedItem: () => ({ value: "settings", label: "settings" }) },
		};

		const handled = completeSkillCommandWithoutSubmit({
			editor,
			data: "enter",
			keybindings: { matches: () => true },
			requestRender: () => assert.fail("should not render"),
		});

		assert.equal(handled, false);
		assert.equal(editor.state.lines[0], "/set");
	});
});