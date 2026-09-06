import assert from "node:assert/strict";
import { test } from "node:test";
import { CombinedAutocompleteProvider, TuiAltScreen, type EditorTheme, visibleWidth } from "@earendil-works/pi-tui";
import { RailEditor } from "../../../components/editor";
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

type Harness = {
	tui: any;
	input(data: string): void;
	lines(): string[];
	editor: RailEditor;
};

function harness(columns: number, rows: number, gutter: boolean, text?: string, options: Record<string, unknown> = {}): Harness {
	let onInput: ((data: string) => void) | undefined;
	const terminal: any = {
		columns,
		rows,
		start(cb: (data: string) => void) { onInput = cb; },
		stop() {},
		write() {},
		hideCursor() {},
		showCursor() {},
		moveBy() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		drainInput: async () => {},
	};
	const tui: any = new TuiAltScreen(terminal, false, undefined, options);
	const editor = new RailEditor(tui, editorTheme, { matches: () => false } as any, appTheme as any);
	if (text !== undefined) editor.setText(text);
	editor.focused = true;
	tui.setLayoutRoot(gutter ? new GutterContainer(editor) : editor);
	tui.setFocus(editor);
	tui.start();
	tui.renderNow();
	return {
		tui,
		editor,
		input: (data: string) => onInput?.(data),
		lines: () => tui.render(columns).map(stripAnsi),
	};
}

function cellAt(rows: string[], needle: string, char: string): { row: number; column: number } {
	const row = rows.findIndex((line: string) => line.includes(needle));
	assert.notEqual(row, -1, `needle ${JSON.stringify(needle)} not rendered`);
	const stringIndex = rows[row]!.indexOf(char);
	assert.notEqual(stringIndex, -1, `char ${JSON.stringify(char)} not rendered`);
	return { row, column: visibleWidth(rows[row]!.slice(0, stringIndex)) };
}

async function clickCell(h: Harness, row: number, column: number): Promise<void> {
	h.input(`\x1b[<0;${column + 1};${row + 1}M`);
	h.input(`\x1b[<0;${column + 1};${row + 1}m`);
	await new Promise((resolve) => setImmediate(resolve));
}

test("clicking visible editor text moves the cursor through fullscreen mouse input", async () => {
	const text = "abcdefghijklmnopqrstuvwxyz 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const h = harness(40, 20, false, text);
	const { row, column } = cellAt(h.lines(), "abcdefghijklm", "m");

	await clickCell(h, row, column);

	assert.deepEqual(h.editor.getCursor(), { line: 0, col: 12 });
	h.tui.stop();
});

test("dragging across guttered editor text selects it and copies on release", async () => {
	let copied: string | undefined;
	const h = harness(40, 20, true, "alpha select omega", {
		copySelection: async (text: string) => { copied = text; return true; },
	});
	const rows = h.lines();
	const row = rows.findIndex((line: string) => line.includes("alpha select omega"));
	assert.notEqual(row, -1);
	const startColumn = rows[row]!.indexOf("select");
	const endColumn = startColumn + "select".length - 1;
	const before = h.editor.getCursor();
	const mouse = (button: number, column: number, release = false) =>
		`\x1b[<${button};${column + 1};${row + 1}${release ? "m" : "M"}`;

	h.input(mouse(0, startColumn));
	h.input(mouse(32, endColumn));
	h.input(mouse(0, endColumn, true));
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(copied, "select");
	assert.deepEqual(h.editor.getCursor(), before);
	h.tui.stop();
});

test("maps a guttered click on a wrapped editor row to the logical cursor", async () => {
	const text = "abcdefghijklmnopqrstuvwxyz 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const h = harness(40, 20, true, text);
	const { row, column } = cellAt(h.lines(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "M");

	await clickCell(h, row, column);

	assert.deepEqual(h.editor.getCursor(), { line: 0, col: text.indexOf("M") });
	h.tui.stop();
});

test("maps a click through the native editor scroll offset in the gutter", async () => {
	const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}: click target`);
	const h = harness(60, 20, true, lines.join("\n"));
	const { row, column } = cellAt(h.lines(), "line 9: click target", "t");

	await clickCell(h, row, column);

	assert.deepEqual(h.editor.getCursor(), { line: 8, col: lines[8]!.indexOf("target") });
	h.tui.stop();
});

test("maps terminal cells to wide CJK graphemes and astral emoji", async () => {
	const text = "alpha 中文内容 omega 😀🔥 beta";
	const h = harness(40, 20, true, text);
	const rows = h.lines();

	const cjk = cellAt(rows, "alpha 中文内容 omega", "内");
	await clickCell(h, cjk.row, cjk.column);
	assert.deepEqual(h.editor.getCursor(), { line: 0, col: text.indexOf("内") });

	const emoji = cellAt(rows, "😀🔥 beta", "🔥");
	await clickCell(h, emoji.row, emoji.column);
	assert.deepEqual(h.editor.getCursor(), { line: 0, col: text.indexOf("🔥") });
	h.tui.stop();
});

test("clicks map through every editor padding level on narrow guttered windows", async () => {
	const text = "日本語の折り返し と emoji 😀 テスト 中文";
	for (let padding = 0; padding <= 3; padding++) {
		const h = harness(30, 20, true, text);
		(h.editor as any).setPaddingX(padding);
		h.tui.renderNow();
		const rows = h.lines();
		const row = rows.findIndex((line: string) => line.includes("テスト"));
		assert.notEqual(row, -1, `padding ${padding} did not render target row`);
		// Click the start of the second wrapped line ("テスト") and expect the
		// native grapheme/scroll mapping (not a Rail re-implementation) to land
		// on the same logical line's first grapheme.
		const column = visibleWidth(rows[row]!.slice(0, rows[row]!.indexOf("テスト")));
		await clickCell(h, row, column);
		const cursor = h.editor.getCursor();
		assert.equal(cursor.line, 0, `padding ${padding} should stay on logical line 0`);
		const logical = h.editor.getText().split("\n")[cursor.line]!;
		assert.ok(cursor.col >= 0 && cursor.col <= logical.length, `padding ${padding} cursor col out of range: ${cursor.col}`);
		h.tui.stop();
	}
});

test("clicks on padded blank rows focus without moving the cursor and only on the left button", async () => {
	const h = harness(40, 20, false, "single line");
	const before = h.editor.getCursor();

	await clickCell(h, 0, 0);
	assert.deepEqual(h.editor.getCursor(), before);

	// Right-button clicks on blank rows are left unhandled (selection owns them).
	h.input("\x1b[<2;1;1M");
	h.input("\x1b[<2;1;1m");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(h.editor.getCursor(), before);
	h.tui.stop();
});

test("clicking a real autocomplete candidate accepts it through the completion list", async () => {
	const h = harness(60, 20, true);
	const provider = new CombinedAutocompleteProvider([{ name: "rail-oai-search" }], "/tmp");
	h.editor.setAutocompleteProvider(provider);
	// Type a parameterized Rail command so the native editor performs
	// autocomplete with the real provider.
	for (const char of "/rail-oai-s") h.editor.handleInput(char);
	await new Promise((resolve) => setTimeout(resolve, 40));
	(h.tui as any).renderNow();
	const rows = h.lines();
	const row = rows.findIndex((line: string) => line.includes("rail-oai-search"));
	assert.notEqual(row, -1, "autocomplete row not rendered");
	const column = rows[row]!.indexOf("rail-oai-search");
	assert.notEqual(column, -1);

	await clickCell(h, row, column);

	assert.equal(h.editor.getText(), "/rail-oai-search ");
	h.tui.stop();
});