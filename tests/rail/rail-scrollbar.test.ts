import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { drawRailScrollbar, isRailScrollbarView, markRailScrollbarView } from "../../rail/rail-scrollbar";

const THUMB_CELL = "\x1b[38;2;137;180;250m█\x1b[0m";

function fakeScrollView(over: { currentScrollTop?: number; currentScrollbar?: string } = {}) {
	const view: any = {
		primary: true,
		currentScrollbar: over.currentScrollbar ?? "always",
		currentScrollTop: over.currentScrollTop ?? 10,
		setScrollbar(value: string) {
			this.currentScrollbar = value;
		},
	};
	return view;
}

function fakeLayout(scrollView: any, totalRows: number, viewportHeight = 20): any {
	const box = {
		scrollView,
		rect: { x: 0, y: 0, width: 80, height: viewportHeight },
		children: [],
		scrollContentLines: Array.from({ length: totalRows }, () => " ".repeat(80)),
	};
	return { primaryScrollView: scrollView, root: { children: [box] } };
}

function screen(rows: number): string[] {
	return Array.from({ length: rows }, () => " ".repeat(80));
}

describe("rail scrollbar", () => {
	test("hides the native scrollbar and draws the legacy blue thumb", () => {
		const scrollView = fakeScrollView();
		markRailScrollbarView(scrollView);
		const layout = fakeLayout(scrollView, 100);

		const out = drawRailScrollbar(screen(24), layout, 80);

		assert.equal(scrollView.currentScrollbar, "hidden");
		// thumbSize = min(floor(20^2/100), floor(20*0.65)) = 4; thumbTop = 2
		assert.equal(out[2]!.includes(THUMB_CELL), true);
		assert.equal(out[5]!.includes(THUMB_CELL), true);
		assert.equal(out[1]!.includes(THUMB_CELL), false);
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

	test("ignores unmarked scroll views", () => {
		const scrollView = fakeScrollView();
		const layout = fakeLayout(scrollView, 100);

		const out = drawRailScrollbar(screen(24), layout, 80);

		assert.equal(scrollView.currentScrollbar, "always");
		assert.equal(out[0]!.includes(THUMB_CELL), false);
	});
});
