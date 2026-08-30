import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { completeSlashCommandWithoutSubmit } from "../../../components/editor/rail-editor-autocomplete";

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

		const handled = completeSlashCommandWithoutSubmit({
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

	test("keeps parameterized Rail command completions in the editor", () => {
		const provider = new CombinedAutocompleteProvider([{ name: "rail-oai-fast" }], process.cwd());
		const editor = {
			state: { lines: ["/rail-oai-f"], cursorLine: 0, cursorCol: 11 },
			autocompleteState: {} as unknown,
			autocompleteProvider: provider,
			autocompletePrefix: "/rail-oai-f",
			autocompleteList: { getSelectedItem: () => ({ value: "rail-oai-fast", label: "rail-oai-fast" }) },
			setCursorCol(col: number) {
				this.state.cursorCol = col;
			},
			cancelAutocomplete() {
				this.autocompleteState = null;
			},
			getText() {
				return this.state.lines.join("\n");
			},
		};

		const handled = completeSlashCommandWithoutSubmit({
			editor,
			data: "enter",
			keybindings: { matches: () => true },
			requestRender: () => {},
		});

		assert.equal(handled, true);
		assert.equal(editor.getText(), "/rail-oai-fast ");
		assert.equal(editor.autocompleteState, null);
	});

	test("leaves slash commands without parameters to the editor implementation", () => {
		const editor = {
			state: { lines: ["/set"], cursorLine: 0, cursorCol: 4 },
			autocompleteState: {},
			autocompleteProvider: new CombinedAutocompleteProvider([{ name: "settings" }], process.cwd()),
			autocompletePrefix: "/set",
			autocompleteList: { getSelectedItem: () => ({ value: "settings", label: "settings" }) },
		};

		const handled = completeSlashCommandWithoutSubmit({
			editor,
			data: "enter",
			keybindings: { matches: () => true },
			requestRender: () => assert.fail("should not render"),
		});

		assert.equal(handled, false);
		assert.equal(editor.state.lines[0], "/set");
	});
});