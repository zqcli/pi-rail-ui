import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../core/utils";
import { composeHistoryRows } from "../../components/chat-view/viewport-compose";
import type { ScrollbarMetrics } from "../../components/chat-view/state";

const THUMB = "█";

function makeScrollbar(width: number, thumbStart: number, thumbSize: number): ScrollbarMetrics {
	return {
		width,
		thumbSize,
		thumbStart,
		maxThumbStart: 0,
		maxScrollStart: 1,
		xStart: 1,
		xEnd: width,
		thumbBar: `\x1b[38;2;120;120;120m${THUMB.repeat(width)}\x1b[0m`,
		trackBar: `\x1b[48;2;20;20;20m${" ".repeat(width)}\x1b[0m`,
	};
}

const WIDTH = 24;
const GUTTER = 2;
const CONTENT = WIDTH - GUTTER;
const ROWS = 6;
const lines = [
	"plain ascii line",
	"\x1b[31mred colored\x1b[0m text",
	"中文宽字符测试一二三四五六七八九十",
	"short",
	"",
	"trailing-open\x1b[1m",
	"extra line not shown",
];

describe("composeHistoryRows", () => {
	test("renders every row to exactly the target width without a scrollbar", () => {
		const rows = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, undefined, undefined);

		assert.equal(rows.length, ROWS);
		rows.forEach((row) => assert.equal(visibleWidth(row), WIDTH));
	});

	test("renders every row to exactly the target width with a scrollbar", () => {
		const rows = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, makeScrollbar(1, 2, 3), undefined);

		rows.forEach((row) => assert.equal(visibleWidth(row), WIDTH));
	});

	test("uses the thumb glyph only on scrollbar thumb rows", () => {
		const rows = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, makeScrollbar(1, 2, 3), undefined);

		rows.forEach((row, index) => {
			const lastCol = stripAnsi(row).slice(-1);
			const inThumb = index >= 2 && index < 5;
			assert.equal(lastCol, inThumb ? THUMB : " ");
		});
	});

	test("resets history row style before appending the scrollbar", () => {
		const row = composeHistoryRows(["open\x1b[1m"], 0, 1, WIDTH, GUTTER, CONTENT, makeScrollbar(1, 0, 1), undefined)[0];
		assert.ok(row);
		const scrollbarStart = row.indexOf("\x1b[38;2;120;120;120m");

		assert.ok(scrollbarStart > 0);
		assert.ok(row.slice(0, scrollbarStart).endsWith("\x1b[0m"));
	});

	test("preserves the global gutter and content", () => {
		const rows = composeHistoryRows(lines, 0, 1, WIDTH, GUTTER, CONTENT, undefined, undefined);
		const plain = stripAnsi(rows[0] ?? "");

		assert.ok(plain.startsWith(" ".repeat(GUTTER)));
		assert.ok(plain.includes("plain ascii line"));
	});

	test("keeps wide CJK rows width-exact", () => {
		const rows = composeHistoryRows([lines[2] ?? ""], 0, 1, WIDTH, GUTTER, CONTENT, makeScrollbar(1, 0, 1), undefined);

		assert.equal(visibleWidth(rows[0] ?? ""), WIDTH);
	});

	test("selection highlight changes only the affected row and preserves width", () => {
		const selection = { start: { line: 1, col: 0 }, end: { line: 1, col: 6 } };
		const withSelection = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, undefined, selection);
		const withoutSelection = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, undefined, undefined);

		assert.notEqual(withSelection[1], withoutSelection[1]);
		assert.equal(withSelection[0], withoutSelection[0]);
		assert.equal(visibleWidth(withSelection[1] ?? ""), WIDTH);
	});

	test("keeps leading OSC row markers before the global gutter", () => {
		const marker = "\x1b]133;A\x07";
		const row = composeHistoryRows([`${marker}prompt`], 0, 1, WIDTH, GUTTER, CONTENT, undefined, undefined)[0];

		assert.ok(row?.startsWith(marker));
		assert.equal(stripAnsi(row ?? "").startsWith(" ".repeat(GUTTER)), true);
	});
});
