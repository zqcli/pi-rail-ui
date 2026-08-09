import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Container, ScrollView, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { getScrollbarGeometry } from "@earendil-works/pi-tui/dist/layout.js";
import { drawRailScrollbar, isRailScrollbarView, markRailScrollbarView } from "../../rail/rail-scrollbar";

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
	test("hides the native paint path and draws the legacy blue thumb", () => {
		const scrollView = fakeScrollView();
		markRailScrollbarView(scrollView);
		const layout = fakeLayout(scrollView, 100);

		const out = drawRailScrollbar(screen(24), layout, 80);

		assert.equal(scrollView.currentScrollbar, "hidden");
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
		assert.equal(scrollView.currentScrollbar, "hidden");
	});

	test("draws nothing when content fits the viewport", () => {
		const scrollView = fakeScrollView();
		markRailScrollbarView(scrollView);
		const layout = fakeLayout(scrollView, 10, 20);

		const out = drawRailScrollbar(screen(24), layout, 80);

		assert.equal(out[0]!.includes(THUMB_CELL), false);
	});

	test("keeps content frozen during drag, previews the thumb, and commits on release", async () => {
		class Line {
			constructor(readonly text: string) {}
			render(): string[] { return [this.text]; }
			invalidate(): void {}
		}

		const writes: string[] = [];
		const terminal: any = {
			columns: 100,
			rows: 40,
			write(data: string) { writes.push(data); },
			onData() {},
			hideCursor() {},
			showCursor() {},
		};
		const altScreen: any = new TuiAltScreen(terminal, false, undefined, {});
		const documentContainer = new Container();
		for (let index = 0; index < 200; index++) documentContainer.addChild(new Line(`line ${index}`));
		const scrollView: any = new ScrollView(documentContainer, { follow: "end", primary: true, scrollbar: "auto" });
		altScreen.setLayoutRoot(new VStack([{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 }]));
		altScreen.altScreenActive = true;

		let renders = 0;
		const originalDoRender = altScreen.doRender.bind(altScreen);
		altScreen.doRender = () => {
			renders++;
			return originalDoRender();
		};

		const originalScrollbarStyle = scrollView.scrollbarStyle;
		const { installRailScrollbar, uninstallRailScrollbar } = await import("../../rail/rail-scrollbar");
		await installRailScrollbar();
		try {
			altScreen.doRender();
			scrollView.scrollToEnd();
			altScreen.cancelRenderTimer?.();
			altScreen.renderRequested = false;
			altScreen.doRender();
			writes.length = 0;
			renders = 0;

			const layout = altScreen.currentLayout;
			const scrollBox = layout.root.children.find((child: any) => child.scrollView === layout.primaryScrollView);
			const totalRows = scrollBox.scrollContentLines.length;
			const trackHeight = scrollBox.rect.height;
			const thumbHeight = Math.max(2, Math.min(trackHeight, Math.round((trackHeight * trackHeight) / totalRows)));
			const thumbTop = scrollBox.rect.y + Math.round((scrollView.scrollTop / (totalRows - trackHeight)) * (trackHeight - thumbHeight));
			const column = scrollBox.rect.x + scrollBox.rect.width - 1;
			const initialScrollTop = scrollView.scrollTop;
			const mouse = (button: number, x: number, y: number, release = false) =>
				`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
			let scrollCalls = 0;
			const originalScrollTo = scrollView.scrollTo.bind(scrollView);
			scrollView.scrollTo = (value: number) => {
				scrollCalls++;
				originalScrollTo(value);
			};

			altScreen.handleViewportInput(mouse(0, column, thumbTop + 1));
			altScreen.handleViewportInput(mouse(32, column, thumbTop - 8));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(scrollView.scrollTop, initialScrollTop);
			assert.equal(scrollCalls, 0);
			assert.equal(renders, 0);
			assert.ok(writes.some((write) => write.includes(THUMB_CELL)));

			altScreen.handleViewportInput(mouse(0, column, thumbTop - 8, true));
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.notEqual(scrollView.scrollTop, initialScrollTop);
			assert.equal(renders, 1);
		} finally {
			uninstallRailScrollbar();
		}
		assert.equal(scrollView.currentScrollbar, "auto");
		assert.equal(scrollView.scrollbarStyle, originalScrollbarStyle);
	});

	test("ignores unmarked scroll views", () => {
		const scrollView = fakeScrollView();
		const layout = fakeLayout(scrollView, 100);

		const out = drawRailScrollbar(screen(24), layout, 80);

		assert.equal(scrollView.currentScrollbar, "always");
		assert.equal(out[0]!.includes(THUMB_CELL), false);
	});
});
