import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, ScrollView, TuiAltScreen, VStack, type TuiAltScreenOptions } from "@earendil-works/pi-tui";

// Rail fully delegates the transcript scrollbar to Pi. These tests drive the
// real fullscreen TUI with SGR mouse input through the same public Terminal
// seam a real terminal uses, locking the native viewport contract Rail now
// relies on: track press jump, thumb drag before release, Jump-to-latest
// follow-end restore, Alt+wheel acceleration, and drag selection.
const COLUMNS = 100;
const ROWS = 30;
const LINE_COUNT = 200;
const MAX_SCROLL_TOP = LINE_COUNT - ROWS; // 170

class Line {
	constructor(readonly text: string) {}
	render(): string[] { return [this.text]; }
	invalidate(): void {}
}

const press = (button: number, x: number, y: number) => `\x1b[<${button};${x + 1};${y + 1}M`;
const release = (button: number, x: number, y: number) => `\x1b[<${button};${x + 1};${y + 1}m`;

function setup(options: { copySelection?: (text: string) => Promise<boolean> } = {}) {
	const writes: string[] = [];
	let onInput: ((data: string) => void) | undefined;
	const terminal: any = {
		columns: COLUMNS,
		rows: ROWS,
		write: (data: string) => writes.push(data),
		start: (handler: (data: string) => void) => { onInput = handler; },
		stop: () => undefined,
		drainInput: async () => undefined,
		hideCursor: () => undefined,
		showCursor: () => undefined,
		clearLine: () => undefined,
		clearFromCursor: () => undefined,
		clearScreen: () => undefined,
		moveBy: () => undefined,
		setTitle: () => undefined,
		setProgress: () => undefined,
		get kittyProtocolActive() { return false; },
	};
	const content = new Container();
	for (let index = 0; index < LINE_COUNT; index++) content.addChild(new Line(`line ${index}`));
	const scrollView = new ScrollView(content, { follow: "end", primary: true, scrollbar: "always" });
	const altOptions: TuiAltScreenOptions = {
		scrollToEndIndicator: () => "Jump to latest message",
		...(options.copySelection ? { copySelection: options.copySelection } : {}),
	};
	const tui = new TuiAltScreen(terminal, false, undefined, altOptions);
	tui.setLayoutRoot(new VStack([{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 }]));
	tui.start();
	tui.renderNow(true);
	return { tui, scrollView, writes, send: (data: string) => onInput?.(data) };
}

test("native scrollbar track press jumps scrollTop before release and disengages follow-end", (t) => {
	const { tui, scrollView, send } = setup();
	t.after(() => tui.stop());

	assert.equal(scrollView.scrollTop, MAX_SCROLL_TOP);
	assert.equal(scrollView.isFollowingEnd, true);

	// Press in the last column on the track above the thumb (row 10). Pi jumps
	// immediately on the press: thumbHeight = round(30*30/200) = 5,
	// grabOffset = floor(5/2) = 2, scrollTop = round((10-2)/(30-5)*170) = 54.
	send(press(0, COLUMNS - 1, 10));
	assert.equal(scrollView.scrollTop, 54);
	assert.equal(scrollView.isFollowingEnd, false);

	send(release(0, COLUMNS - 1, 10));
	assert.equal(scrollView.scrollTop, 54);
});

test("jump-to-latest indicator restores follow-end after a track jump", (t) => {
	const { tui, scrollView, writes, send } = setup();
	t.after(() => tui.stop());

	send(press(0, COLUMNS - 1, 10));
	send(release(0, COLUMNS - 1, 10));
	writes.length = 0;
	tui.renderNow(true);
	// The label is centered on the last clip row, left of the scrollbar column:
	// column = floor((99 - 20) / 2) = 39, spanning columns 39..58 at row 29.
	assert.match(writes.join(""), /Jump to latest message/);

	send(press(0, 40, ROWS - 1));
	assert.equal(scrollView.scrollTop, MAX_SCROLL_TOP);
	assert.equal(scrollView.isFollowingEnd, true);
	send(release(0, 40, ROWS - 1));
});

test("native scrollbar thumb drag moves scrollTop before release", (t) => {
	const { tui, scrollView, send } = setup();
	t.after(() => tui.stop());

	// Jump to a mid-track position, then grab the thumb where it now sits.
	send(press(0, COLUMNS - 1, 5));
	// scrollTop = round((5-2)/25*170) = 20.
	send(release(0, COLUMNS - 1, 5));
	assert.equal(scrollView.scrollTop, 20);

	// Thumb for scrollTop 20: thumbTop = round(20/170*25) = 3, rows 3..7.
	// Pressing the thumb must not move yet; grabOffset = 4 - 3 = 1.
	send(press(0, COLUMNS - 1, 4));
	assert.equal(scrollView.scrollTop, 20);

	// Drag to row 15: scrollTop = round((15-1)/25*170) = 95, before release.
	send(press(32, COLUMNS - 1, 15));
	assert.equal(scrollView.scrollTop, 95);
	send(release(0, COLUMNS - 1, 15));
	assert.equal(scrollView.scrollTop, 95);
	assert.equal(scrollView.isFollowingEnd, false);
});

test("native alt+wheel scrolls five wheel steps", (t) => {
	const { tui, scrollView, send } = setup();
	t.after(() => tui.stop());

	// Starts at the end (170). Normal wheel up moves one step (wheelScrollLines
	// defaults to 1); Alt+wheel up (button 64|8) multiplies it by 5.
	send("\x1b[<64;51;11M");
	assert.equal(scrollView.scrollTop, MAX_SCROLL_TOP - 1);

	send("\x1b[<72;51;11M");
	assert.equal(scrollView.scrollTop, MAX_SCROLL_TOP - 6);
});

test("native transcript drag selects and copies text on release", async (t) => {
	let copied = "";
	const { tui, send } = setup({ copySelection: async (text) => { copied = text; return true; } });
	t.after(() => tui.stop());

	// Pi's native line selection, as pinned from 0.85.1: a drag from local
	// cell (10,5) to (40,8) maps to content rows 175..178 and copies as a
	// line range. The partial anchor row contributes only its leading
	// newline, and the remaining complete lines are newline-terminated.
	send(press(0, 10, 5));
	send(press(32, 40, 8));
	send(release(0, 40, 8));

	assert.equal(tui.hasActiveSelection(), true);
	assert.equal(copied, "\nline 176\nline 177\nline 178");
});