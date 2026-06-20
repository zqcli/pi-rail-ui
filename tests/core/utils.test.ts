import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	applyColumnHighlight,
	buildVisualMap,
	clampPosition,
	indexForVisualCol,
	parseWheel,
	splitDefaultEditor,
	stripAnsi,
	visibleBodySlice,
	visibleColForIndex,
	wrapLine,
} from "../../core/utils";

describe("ANSI and width helpers", () => {
	test("strips CSI and OSC ANSI sequences", () => {
		assert.equal(stripAnsi("\x1b[31mred\x1b[0m \x1b]133;A\x07zone"), "red zone");
	});

	test("maps between string indexes and visual columns for wide glyphs", () => {
		const text = "a中b";

		assert.equal(visibleColForIndex(text, 2), 3);
		assert.equal(indexForVisualCol(text, 2), 1);
		assert.equal(indexForVisualCol(text, 4), text.length);
	});

	test("applies highlight without losing the active SGR style after reset", () => {
		const highlighted = applyColumnHighlight("\x1b[31mabcde\x1b[0m", 1, 3, "\x1b[7m", "\x1b[0m");

		assert.equal(highlighted, "\x1b[31ma\x1b[7mbc\x1b[0m\x1b[31mde\x1b[0m");
		assert.equal(stripAnsi(highlighted), "abcde");
	});
});

describe("editor and visual row helpers", () => {
	test("splits the default editor body from completion rows", () => {
		const split = splitDefaultEditor(["top border", "body", "─── ↓ 2 more ─", "completion"]);

		assert.deepEqual(split, { body: ["body"], completions: ["completion"] });
	});

	test("chooses a cursor-centered visible body slice", () => {
		const slice = visibleBodySlice(["0", "1", "2", "3 CURSOR", "4", "5"], 3, "CURSOR");

		assert.deepEqual(slice, { lines: ["2", "3 CURSOR", "4"], start: 2 });
	});

	test("wraps at whitespace when possible", () => {
		const chunks = wrapLine("alpha beta", 6);

		assert.deepEqual(chunks.map((chunk) => chunk.text), ["alpha ", "beta"]);
		assert.deepEqual(chunks.map((chunk) => [chunk.startIndex, chunk.endIndex]), [[0, 6], [6, 10]]);
	});

	test("builds a non-empty visual map for empty input", () => {
		assert.deepEqual(buildVisualMap([], 12), [{ logicalLine: 0, startIndex: 0, endIndex: 0, text: "" }]);
	});

	test("keeps wrapped CJK rows within the target width", () => {
		const chunks = wrapLine("数据数据数据", 4);

		assert.deepEqual(chunks.map((chunk) => visibleWidth(chunk.text)), [4, 4, 4]);
	});
});

describe("position and mouse helpers", () => {
	test("clamps positions to existing line bounds", () => {
		assert.deepEqual(clampPosition({ line: 9, col: 50 }, ["abc", "de"]), { line: 1, col: 2 });
	});

	test("parses SGR wheel events", () => {
		assert.deepEqual(parseWheel("\x1b[<64;12;4M"), { direction: 1, x: 12, y: 4 });
		assert.deepEqual(parseWheel("\x1b[<65;7;8M"), { direction: -1, x: 7, y: 8 });
		assert.equal(parseWheel("\x1b[<64;12;4m"), undefined);
	});
});
