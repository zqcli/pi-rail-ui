import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { getScrollbarGeometry } from "@earendil-works/pi-tui/dist/layout.js";
import {
	beginRailDrag,
	bumpRailDrag,
	drawRailScrollbar,
	endRailDrag,
	isRailScrollbarView,
	markRailScrollbarView,
	railRequestRender,
} from "../../rail/rail-scrollbar";

const THUMB_CELL = "\x1b[38;2;137;180;250m█\x1b[0m";

function fakeScrollView(over: { currentScrollTop?: number; currentScrollbar?: string } = {}) {
	const view: any = {
		primary: true,
		currentScrollbar: over.currentScrollbar ?? "always",
		currentScrollTop: over.currentScrollTop ?? 10,
		transientScrollbarVisible: false,
		get scrollTop() {
			return this.currentScrollTop;
		},
		setScrollbar(value: string) {
			this.currentScrollbar = value;
		},
		hideTransientScrollbar() {
			this.transientScrollbarVisible = false;
		},
	};
	return view;
}

function fakeLayout(scrollView: any, totalRows: number, viewportHeight = 20): any {
	const box = {
		scrollView,
		rect: { x: 0, y: 0, width: 80, height: viewportHeight },
		clip: { x: 0, y: 0, width: 80, height: viewportHeight },
		children: [],
		scrollContentLines: Array.from({ length: totalRows }, () => " ".repeat(80)),
	};
	return { primaryScrollView: scrollView, root: { children: [box] } };
}

function screen(rows: number): string[] {
	return Array.from({ length: rows }, () => " ".repeat(80));
}

describe("rail scrollbar", () => {
	test("keeps the native scrollbar auto-interactive and draws the legacy blue thumb", () => {
		const scrollView = fakeScrollView();
		markRailScrollbarView(scrollView);
		const layout = fakeLayout(scrollView, 100);

		const out = drawRailScrollbar(screen(24), layout, 80);

		assert.equal(scrollView.currentScrollbar, "auto");
		assert.equal(scrollView.transientScrollbarVisible, true);
		// thumbSize = max(2, min(20, round(20^2/100))) = 4; thumbTop = round(10/80*16) = 2
		assert.equal(out[2]!.includes(THUMB_CELL), true);
		assert.equal(out[5]!.includes(THUMB_CELL), true);
		assert.equal(out[1]!.includes(THUMB_CELL), false);
	});

	test("draws the thumb on the same rows the native drag geometry targets", () => {
		const scrollView = fakeScrollView();
		markRailScrollbarView(scrollView);
		const layout = fakeLayout(scrollView, 100);
		Object.defineProperty(scrollView, "isScrollbarVisible", { get: () => true });

		const out = drawRailScrollbar(screen(24), layout, 80);
		const box = layout.root.children[0];
		const geometry = getScrollbarGeometry(box)!;

		for (let row = 0; row < 24; row++) {
			const expected = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
			assert.equal(out[row]!.includes(THUMB_CELL), expected, `row ${row}`);
		}
	});

	test("keeps marking idempotent and restores the original scrollbar mode", () => {
		const scrollView = fakeScrollView({ currentScrollbar: "auto" });
		markRailScrollbarView(scrollView);
		markRailScrollbarView(scrollView);

		assert.equal(isRailScrollbarView(scrollView), true);
		assert.equal(scrollView.currentScrollbar, "auto");
	});

	test("draws nothing when content fits the viewport", () => {
		const scrollView = fakeScrollView();
		markRailScrollbarView(scrollView);
		const layout = fakeLayout(scrollView, 10, 20);

		const out = drawRailScrollbar(screen(24), layout, 80);

		assert.equal(out[0]!.includes(THUMB_CELL), false);
	});

	test("suspends renders while dragging and renders once on release", () => {
		let renders = 0;
		const tui = { requestRender: () => renders++ };

		beginRailDrag(tui);
		railRequestRender(tui);
		railRequestRender(tui);
		assert.equal(renders, 0);

		bumpRailDrag(tui);
		railRequestRender(tui);
		assert.equal(renders, 0);

		endRailDrag(tui);
		assert.equal(renders, 1);
	});

	test("inactivity during a drag releases the suspension", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			let renders = 0;
			const tui = { requestRender: () => renders++ };

			beginRailDrag(tui);
			railRequestRender(tui);
			assert.equal(renders, 0);

			mock.timers.tick(400);
			assert.equal(renders, 1);

			// A later render outside the drag window renders normally.
			railRequestRender(tui);
			assert.equal(renders, 2);
		} finally {
			mock.timers.reset();
		}
	});

	test("ignores unmarked scroll views", () => {
		const scrollView = fakeScrollView();
		const layout = fakeLayout(scrollView, 100);

		const out = drawRailScrollbar(screen(24), layout, 80);

		assert.equal(scrollView.currentScrollbar, "always");
		assert.equal(out[0]!.includes(THUMB_CELL), false);
	});
});
