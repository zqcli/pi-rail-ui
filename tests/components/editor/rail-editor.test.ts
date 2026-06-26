import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CombinedAutocompleteProvider, type EditorTheme } from "@earendil-works/pi-tui";
import { RailEditor, hideAllEditorOverlays } from "../../../components/editor";

const passthrough = (text: string) => text;

const editorTheme: EditorTheme = {
	borderColor: passthrough,
	selectList: {
		selectedPrefix: passthrough,
		selectedText: passthrough,
		description: passthrough,
		scrollInfo: passthrough,
		noMatch: passthrough,
	},
};

const appTheme = {
	fg(_name: string, value: string) {
		return value;
	},
};

describe("RailEditor", () => {
	test("keeps selected skill autocomplete in the editor instead of submitting immediately", () => {
		let renderRequests = 0;
		const tui = {
			terminal: { rows: 24, columns: 80 },
			requestRender() {
				renderRequests += 1;
			},
			showOverlay() {
				return { hide() {} };
			},
		};
		const keybindings = {
			matches(data: string, keybinding: string) {
				return data === "enter" && keybinding === "tui.select.confirm";
			},
		};
		const editor = new RailEditor(tui as any, editorTheme, keybindings as any, appTheme as any);
		const provider = new CombinedAutocompleteProvider([
			{ name: "skill:web-access", description: "Search the web" },
		], process.cwd());
		let submitted: string | undefined;
		let changed: string | undefined;

		try {
			editor.setAutocompleteProvider(provider);
			editor.setText("/ski");
			editor.onSubmit = (text) => {
				submitted = text;
			};
			editor.onChange = (text) => {
				changed = text;
			};
			Object.assign(editor as any, {
				autocompleteState: {},
				autocompletePrefix: "/ski",
				autocompleteList: {
					getSelectedItem: () => ({ value: "skill:web-access", label: "skill:web-access" }),
				},
			});

			editor.handleInput("enter");

			assert.equal(submitted, undefined);
			assert.equal(editor.getText(), "/skill:web-access ");
			assert.equal(changed, "/skill:web-access ");
			assert.equal((editor as any).autocompleteState, null);
			assert.ok(renderRequests > 0);
		} finally {
			hideAllEditorOverlays();
		}
	});
});