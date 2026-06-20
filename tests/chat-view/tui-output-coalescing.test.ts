import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { coalesceTerminalOutputChunks, withCoalescedTerminalOutput } from "../../components/chat-view/tui-output-coalescing";

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

describe("coalesceTerminalOutputChunks", () => {
	test("moves cursor restore before synchronized-output end", () => {
		const output = coalesceTerminalOutputChunks([
			`${BEGIN_SYNC}history${END_SYNC}`,
			"\x1b[2A\x1b[10G",
			HIDE_CURSOR,
		]);

		assert.equal(output, `${BEGIN_SYNC}history\x1b[2A\x1b[10G${HIDE_CURSOR}${END_SYNC}`);
	});

	test("keeps already coalesced output unchanged", () => {
		const input = `${BEGIN_SYNC}history\x1b[10G${HIDE_CURSOR}${END_SYNC}`;

		assert.equal(coalesceTerminalOutputChunks([input]), input);
	});

	test("keeps non-synchronized output unchanged", () => {
		const input = "history\x1b[10G";

		assert.equal(coalesceTerminalOutputChunks([input]), input);
	});
});

describe("withCoalescedTerminalOutput", () => {
	test("captures render writes and flushes once", () => {
		const writes: string[] = [];
		const terminal = {
			write(data: string) {
				writes.push(data);
			},
			hideCursor() {
				writes.push("original-hide");
			},
		};

		withCoalescedTerminalOutput({ terminal }, () => {
			terminal.write(`${BEGIN_SYNC}body${END_SYNC}`);
			terminal.write("\x1b[5G");
			terminal.hideCursor();
		});

		assert.deepEqual(writes, [`${BEGIN_SYNC}body\x1b[5G${HIDE_CURSOR}${END_SYNC}`]);
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

		assert.equal(terminal.write, originalWrite);
		assert.equal(terminal.showCursor, originalShowCursor);
		assert.deepEqual(writes, [`${BEGIN_SYNC}body${SHOW_CURSOR}${END_SYNC}`]);
	});

	test("restores terminal methods and rethrows render errors", () => {
		const writes: string[] = [];
		const terminal = {
			write(data: string) {
				writes.push(data);
			},
		};
		const originalWrite = terminal.write;

		assert.throws(
			() =>
				withCoalescedTerminalOutput({ terminal }, () => {
					terminal.write("partial");
					throw new Error("render failed");
				}),
			/render failed/,
		);
		assert.equal(terminal.write, originalWrite);
		assert.deepEqual(writes, ["partial"]);
	});
});
