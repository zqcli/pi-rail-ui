import { coalesceTerminalOutputChunks, withCoalescedTerminalOutput } from "../tui-output-coalescing";

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const assert = (cond: boolean, msg: string) => {
	if (!cond) throw new Error(msg);
};

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
	process.stdout.write(`  ${name} ... `);
	try {
		fn();
		console.log("PASS");
		passed++;
	} catch (e: unknown) {
		console.log(`FAIL: ${e}`);
		failed++;
	}
}

console.log("TUI output coalescing tests\n");

test("moves cursor restore before synchronized-output end", () => {
	const output = coalesceTerminalOutputChunks([
		`${BEGIN_SYNC}history${END_SYNC}`,
		"\x1b[2A\x1b[10G",
		HIDE_CURSOR,
	]);
	assert(output === `${BEGIN_SYNC}history\x1b[2A\x1b[10G${HIDE_CURSOR}${END_SYNC}`, JSON.stringify(output));
});

test("keeps already coalesced output unchanged", () => {
	const input = `${BEGIN_SYNC}history\x1b[10G${HIDE_CURSOR}${END_SYNC}`;
	const output = coalesceTerminalOutputChunks([input]);
	assert(output === input, JSON.stringify(output));
});

test("keeps non-synchronized output unchanged", () => {
	const input = "history\x1b[10G";
	const output = coalesceTerminalOutputChunks([input]);
	assert(output === input, JSON.stringify(output));
});

test("captures doRender writes and flushes once", () => {
	const writes: string[] = [];
	const terminal = {
		write(data: string) {
			writes.push(data);
		},
		hideCursor() {
			writes.push("original-hide");
		},
	};
	const tui = { terminal };
	withCoalescedTerminalOutput(tui, () => {
		terminal.write(`${BEGIN_SYNC}body${END_SYNC}`);
		terminal.write("\x1b[5G");
		terminal.hideCursor();
	});
	assert(writes.length === 1, `expected 1 write, got ${writes.length}: ${JSON.stringify(writes)}`);
	assert(writes[0] === `${BEGIN_SYNC}body\x1b[5G${HIDE_CURSOR}${END_SYNC}`, JSON.stringify(writes[0]));
});

test("restores terminal methods after capture", () => {
	const writes: string[] = [];
	const terminal = {
		write(data: string) {
			writes.push(data);
		},
		showCursor() {
			writes.push("original-show");
		},
	};
	const originalWrite = terminal.write;
	const originalShowCursor = terminal.showCursor;
	withCoalescedTerminalOutput({ terminal }, () => {
		terminal.write(`${BEGIN_SYNC}body${END_SYNC}`);
		terminal.showCursor();
	});
	assert(terminal.write === originalWrite, "write was not restored");
	assert(terminal.showCursor === originalShowCursor, "showCursor was not restored");
	assert(writes[0] === `${BEGIN_SYNC}body${SHOW_CURSOR}${END_SYNC}`, JSON.stringify(writes));
});

setTimeout(() => {
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}, 100);
