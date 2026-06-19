import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../core/utils";
import { composeHistoryRows } from "../viewport-compose";
import type { ScrollbarMetrics } from "../state";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
	} catch (e) {
		failed++;
		console.log(`FAIL: ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

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
	"中文宽字符测试一二三四五六七八九十", // wide glyphs, will truncate
	"short",
	"", // empty
	"trailing-open\x1b[1m", // unclosed ANSI
	"extra line not shown",
];

console.log("viewport compose tests\n");

test("every row is exactly `width` visible columns (no scrollbar)", () => {
	const rows = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, undefined, undefined);
	assert(rows.length === ROWS, `row count ${rows.length}`);
	rows.forEach((r, i) => assert(visibleWidth(r) === WIDTH, `row ${i} width ${visibleWidth(r)} != ${WIDTH}`));
});

test("every row is exactly `width` visible columns (with scrollbar)", () => {
	const sb = makeScrollbar(1, 2, 3);
	const rows = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, sb, undefined);
	rows.forEach((r, i) => assert(visibleWidth(r) === WIDTH, `row ${i} width ${visibleWidth(r)} != ${WIDTH}`));
});

test("scrollbar column: thumb glyph on thumb rows, space on track rows", () => {
	const sb = makeScrollbar(1, 2, 3); // thumb covers rows 2,3,4
	const rows = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, sb, undefined);
	rows.forEach((r, i) => {
		const lastCol = stripAnsi(r).slice(-1);
		const inThumb = i >= 2 && i < 5;
		assert(lastCol === (inThumb ? THUMB : " "), `row ${i} last col ${JSON.stringify(lastCol)} inThumb=${inThumb}`);
	});
});

test("gutter prefix preserved (leading spaces) and content visible", () => {
	const rows = composeHistoryRows(lines, 0, 1, WIDTH, GUTTER, CONTENT, undefined, undefined);
	const plain = stripAnsi(rows[0]!);
	assert(plain.startsWith("  "), `expected ${GUTTER}-space gutter, got ${JSON.stringify(plain.slice(0, 4))}`);
	assert(plain.includes("plain ascii line"), "content text present");
});

test("wide CJK line stays width-exact (no split glyph overflow)", () => {
	const rows = composeHistoryRows([lines[2]!], 0, 1, WIDTH, GUTTER, CONTENT, makeScrollbar(1, 0, 1), undefined);
	assert(visibleWidth(rows[0]!) === WIDTH, `cjk row width ${visibleWidth(rows[0]!)}`);
});

test("selection highlight changes the affected row only", () => {
	const sel = { start: { line: 1, col: 0 }, end: { line: 1, col: 6 } };
	const withSel = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, undefined, sel);
	const without = composeHistoryRows(lines, 0, ROWS, WIDTH, GUTTER, CONTENT, undefined, undefined);
	assert(withSel[1] !== without[1], "selected row should differ");
	assert(withSel[0] === without[0], "non-selected row unchanged");
	assert(visibleWidth(withSel[1]!) === WIDTH, "highlighted row still width-exact");
});

// Micro-benchmark: repeated composes of wide ANSI rows (gutter cache warm).
test("benchmark: 2000 composes of a full window", () => {
	const wide = Array.from({ length: 40 }, (_, i) => `\x1b[3${i % 7}m row ${i} ${"数据".repeat(8)} value=${i}\x1b[0m`);
	const sb = makeScrollbar(1, 5, 8);
	const N = 2000;
	const t0 = Date.now();
	for (let i = 0; i < N; i++) composeHistoryRows(wide, i % 10, 30, 80, 2, 78, sb, undefined);
	const ms = Date.now() - t0;
	console.log(`  [bench] ${N} composes (30 rows, width 80) in ${ms}ms  (~${(ms / N).toFixed(3)}ms/compose)`);
});

setTimeout(() => {
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}, 50);
