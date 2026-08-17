import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiAltScreen, type EditorTheme, visibleWidth } from "@earendil-works/pi-tui";
import { RailEditor } from "../../../components/editor";
import { patchRailSectionClickHandling } from "../../../components/executions/rail-click";
import { createPatchLifecycle } from "../../../core/patching";
import { stripAnsi } from "../../../core/utils";
import { GutterContainer } from "../../../rail/gutter";

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
const appTheme = { fg(_name: string, value: string) { return value; } };
const clickLifecycle = createPatchLifecycle("rail-editor-click-test-patch", () => ({}));

async function installClickHandling(): Promise<void> {
	clickLifecycle.activate();
	await patchRailSectionClickHandling(clickLifecycle);
}

function uninstallClickHandling(): void {
	clickLifecycle.deactivate();
}

test("clicking visible editor text moves the cursor through fullscreen mouse input", async () => {
	const terminal: any = {
		columns: 40,
		rows: 20,
		write() {},
		onData() {},
		hideCursor() {},
		showCursor() {},
	};
	const tui: any = new TuiAltScreen(terminal, false, undefined, {});
	const editor = new RailEditor(tui, editorTheme, { matches: () => false } as any, appTheme as any);
	editor.setText("abcdefghijklmnopqrstuvwxyz 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ");
	tui.setLayoutRoot(editor);
	tui.setFocus(editor);
	tui.altScreenActive = true;

	await installClickHandling();
	try {
		tui.doRender();
		const rows = tui.currentLayout.lines.map(stripAnsi);
		const row = rows.findIndex((line: string) => line.includes("abcdefghijklm"));
		assert.notEqual(row, -1);
		const column = rows[row].indexOf("m");
		assert.notEqual(column, -1);
		const mouse = (release: boolean) => `\x1b[<0;${column + 1};${row + 1}${release ? "m" : "M"}`;

		tui.handleViewportInput(mouse(false));
		tui.handleViewportInput(mouse(true));

		assert.deepEqual(editor.getCursor(), { line: 0, col: 12 });
	} finally {
		uninstallClickHandling();
	}
});

test("dragging across editor text selects it and copies on release", async () => {
	let copied: string | undefined;
	const terminal: any = {
		columns: 40,
		rows: 20,
		write() {},
		onData() {},
		hideCursor() {},
		showCursor() {},
	};
	const tui: any = new TuiAltScreen(terminal, false, undefined, {
		copySelection: async (text: string) => {
			copied = text;
			return true;
		},
	});
	const editor = new RailEditor(tui, editorTheme, { matches: () => false } as any, appTheme as any);
	editor.setText("alpha select omega");
	tui.setLayoutRoot(new GutterContainer(editor));
	tui.setFocus(editor);
	tui.altScreenActive = true;

	await installClickHandling();
	try {
		tui.doRender();
		const rows = tui.currentLayout.lines.map(stripAnsi);
		const row = rows.findIndex((line: string) => line.includes("alpha select omega"));
		assert.notEqual(row, -1);
		const startColumn = rows[row].indexOf("select");
		const endColumn = startColumn + "select".length - 1;
		assert.notEqual(startColumn, -1);
		const mouse = (button: number, column: number, release = false) =>
			`\x1b[<${button};${column + 1};${row + 1}${release ? "m" : "M"}`;

		tui.handleViewportInput(mouse(0, startColumn));
		assert.equal(tui.selectionPressActive, true);
		tui.handleViewportInput(mouse(32, endColumn));
		tui.handleViewportInput(mouse(0, endColumn, true));
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(copied, "select");
	} finally {
		uninstallClickHandling();
	}
});

test("maps a guttered click on a wrapped editor row to the logical cursor", async () => {
	const terminal: any = {
		columns: 40,
		rows: 20,
		write() {},
		onData() {},
		hideCursor() {},
		showCursor() {},
	};
	const tui: any = new TuiAltScreen(terminal, false, undefined, {});
	const editor = new RailEditor(tui, editorTheme, { matches: () => false } as any, appTheme as any);
	const text = "abcdefghijklmnopqrstuvwxyz 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	editor.setText(text);
	tui.setLayoutRoot(new GutterContainer(editor));
	tui.setFocus(editor);
	tui.altScreenActive = true;

	await installClickHandling();
	try {
		tui.doRender();
		const rows = tui.currentLayout.lines.map(stripAnsi);
		const row = rows.findIndex((line: string) => line.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
		assert.notEqual(row, -1);
		const column = rows[row].indexOf("M");
		assert.notEqual(column, -1);
		const mouse = (release: boolean) => `\x1b[<0;${column + 1};${row + 1}${release ? "m" : "M"}`;

		tui.handleViewportInput(mouse(false));
		tui.handleViewportInput(mouse(true));

		assert.deepEqual(editor.getCursor(), { line: 0, col: text.indexOf("M") });
	} finally {
		uninstallClickHandling();
	}
});

test("maps a click through the native editor scroll offset", async () => {
	const terminal: any = {
		columns: 60,
		rows: 20,
		write() {},
		onData() {},
		hideCursor() {},
		showCursor() {},
	};
	const tui: any = new TuiAltScreen(terminal, false, undefined, {});
	const editor = new RailEditor(tui, editorTheme, { matches: () => false } as any, appTheme as any);
	const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}: click target`);
	editor.setText(lines.join("\n"));
	tui.setLayoutRoot(new GutterContainer(editor));
	tui.setFocus(editor);
	tui.altScreenActive = true;

	await installClickHandling();
	try {
		tui.doRender();
		const rendered = tui.currentLayout.lines.map(stripAnsi);
		const row = rendered.findIndex((line: string) => line.includes("line 9: click target"));
		assert.notEqual(row, -1);
		const column = rendered[row].indexOf("target");
		assert.notEqual(column, -1);
		const mouse = (release: boolean) => `\x1b[<0;${column + 1};${row + 1}${release ? "m" : "M"}`;

		tui.handleViewportInput(mouse(false));
		tui.handleViewportInput(mouse(true));

		assert.deepEqual(editor.getCursor(), { line: 8, col: lines[8]!.indexOf("target") });
	} finally {
		uninstallClickHandling();
	}
});

test("maps terminal cells to the start of a wide editor grapheme", async () => {
	const terminal: any = {
		columns: 40,
		rows: 20,
		write() {},
		onData() {},
		hideCursor() {},
		showCursor() {},
	};
	const tui: any = new TuiAltScreen(terminal, false, undefined, {});
	const editor = new RailEditor(tui, editorTheme, { matches: () => false } as any, appTheme as any);
	const text = "alpha 中文内容 omega";
	editor.setText(text);
	tui.setLayoutRoot(new GutterContainer(editor));
	tui.setFocus(editor);
	tui.altScreenActive = true;

	await installClickHandling();
	try {
		tui.doRender();
		const rendered = tui.currentLayout.lines.map(stripAnsi);
		const row = rendered.findIndex((line: string) => line.includes(text));
		assert.notEqual(row, -1);
		const stringIndex = rendered[row].indexOf("内");
		assert.notEqual(stringIndex, -1);
		const column = visibleWidth(rendered[row].slice(0, stringIndex));
		const mouse = (release: boolean) => `\x1b[<0;${column + 1};${row + 1}${release ? "m" : "M"}`;

		tui.handleViewportInput(mouse(false));
		tui.handleViewportInput(mouse(true));

		assert.deepEqual(editor.getCursor(), { line: 0, col: text.indexOf("内") });
	} finally {
		uninstallClickHandling();
	}
});