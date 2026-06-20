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

const wide = Array.from({ length: 40 }, (_, index) => `\x1b[3${index % 7}m row ${index} ${"数据".repeat(8)} value=${index}\x1b[0m`);
const scrollbar = makeScrollbar(1, 5, 8);
const iterations = 2000;
const start = Date.now();

for (let index = 0; index < iterations; index++) {
	composeHistoryRows(wide, index % 10, 30, 80, 2, 78, scrollbar, undefined);
}

const elapsed = Date.now() - start;
console.log(`${iterations} composes (30 rows, width 80) in ${elapsed}ms (~${(elapsed / iterations).toFixed(3)}ms/compose)`);
