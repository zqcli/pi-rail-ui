import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitToWidth, padToWidth, stripAnsi } from "../../core/utils";

test("strips CSI and OSC ANSI sequences", () => {
	assert.equal(stripAnsi("\x1b[31mred\x1b[0m \x1b]133;A\x07zone"), "red zone");
});

test("fits and pads visible terminal width", () => {
	assert.equal(visibleWidth(padToWidth("数据", 6)), 6);
	assert.equal(stripAnsi(fitToWidth("abcdefgh", 5)), "abcd…");
	assert.equal(fitToWidth("text", 0), "");
});
