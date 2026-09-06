import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CombinedAutocompleteProvider, type EditorTheme } from "@earendil-works/pi-tui";
import { RailEditor } from "../../../components/editor";
import { RAIL_EDITOR_SURFACE_STYLE } from "../../../config";
import { stripAnsi } from "../../../core/utils";
import { EditorSurfaceRenderer } from "../../../rail/rail-surface";

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

function assertAutocompleteStaysInEditor(prefix: string, value: string, data = "enter"): void {
	let renderRequests = 0;
	const tui = {
		terminal: { rows: 24, columns: 80 },
		requestRender() { renderRequests += 1; },
	};
	const keybindings = {
		matches(data: string, keybinding: string) {
			return data === "enter" && keybinding === "tui.select.confirm";
		},
	};
	const editor = new RailEditor(tui as any, editorTheme, keybindings as any, appTheme as any);
	let submitted: string | undefined;
	let changed: string | undefined;

	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: value }], process.cwd()));
	editor.setText(prefix);
	editor.onSubmit = (text) => { submitted = text; };
	editor.onChange = (text) => { changed = text; };
	Object.assign(editor as any, {
		autocompleteState: {},
		autocompletePrefix: prefix,
		autocompleteList: { getSelectedItem: () => ({ value, label: value }) },
	});

	editor.handleInput(data);

	assert.equal(submitted, undefined);
	assert.equal(editor.getText(), `/${value} `);
	assert.equal(changed, `/${value} `);
	assert.equal((editor as any).autocompleteState, null);
	if (data === "enter") assert.ok(renderRequests > 0);
}

describe("RailEditor", () => {	test("replaces Pi's horizontal editor borders with the Rail surface", () => {
		const tui = {
			terminal: { rows: 24, columns: 80 },
			requestRender() {},
		};
		const keybindings = { matches: () => false };
		const editor = new RailEditor(tui as any, editorTheme, keybindings as any, appTheme as any);

		const rows = editor.render(80).map(stripAnsi);

		assert.equal(rows.some((row) => row.includes("────")), false);
	});

	test("uses the configured Rail editor height policy", () => {
		const tui = {
			terminal: { rows: 24, columns: 80 },
			requestRender() {},
		};
		const keybindings = { matches: () => false };
		const surface = new (EditorSurfaceRenderer as any)(RAIL_EDITOR_SURFACE_STYLE, {
			minHeight: 6,
			maxHeight: 6,
			maxHeightRatio: 1,
		});
		const editor = new RailEditor(tui as any, editorTheme, keybindings as any, appTheme as any, surface);

		assert.equal(editor.render(80).length, 6);
	});

	test("caps long input at the configured maximum while keeping the cursor visible", () => {
		const tui = {
			terminal: { rows: 24, columns: 80 },
			requestRender() {},
		};
		const keybindings = { matches: () => false };
		const surface = new EditorSurfaceRenderer(RAIL_EDITOR_SURFACE_STYLE, {
			minHeight: 2,
			maxHeight: 4,
			maxHeightRatio: 1,
		});
		const editor = new RailEditor(tui as any, editorTheme, keybindings as any, appTheme as any, surface);
		editor.focused = true;
		editor.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));

		const rows = editor.render(80);

		assert.equal(rows.length, 4);
		assert.equal(rows.some((row) => row.includes("line 12")), true);
		assert.equal(rows.some((row) => row.includes("\x1b_pi:c\x07")), true);
	});

	test("keeps selected skill autocomplete in the editor instead of submitting immediately", () => {
		assertAutocompleteStaysInEditor("/ski", "skill:web-access");
	});

	test("keeps parameterized Rail command autocomplete in the editor", () => {
		assertAutocompleteStaysInEditor("/rail-oai-s", "rail-oai-search");
	});

	test("Tab applies the selected autocomplete without submitting", () => {
		assertAutocompleteStaysInEditor("/ski", "skill:web-access", "\t");
	});
});
