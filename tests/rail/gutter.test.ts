import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Container, ScrollView } from "@earendil-works/pi-tui";
import { RailSectionBlock } from "../../rail/rail-section-block";
import {
	GutterContainer,
	installGutterWrappers,
	uninstallGutterWrappers,
} from "../../rail/gutter";

const click = (x: number, y: number, width: number, height: number): any =>
	({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false });

describe("GutterContainer", () => {
	test("insets inner rows by the configured left gutter", () => {
		const inner = { render: () => ["abc", "def"], invalidate() {} };
		const wrapper = new GutterContainer(inner);

		const rows = wrapper.render(80);

		assert.deepEqual(rows, [" abc", " def"]);
		assert.equal(rows[0]!.length, 4);
	});

	test("keeps OSC 133 prompt markers at the start of the line", () => {
		const marker = "\x1b]133;A\x07";
		const inner = { render: () => [`${marker}content`], invalidate() {} };
		const wrapper = new GutterContainer(inner);

		assert.deepEqual(wrapper.render(80), [`${marker} content`]);
	});

	test("leaves blank separator rows untouched", () => {
		const inner = { render: () => ["", "text"], invalidate() {} };
		const wrapper = new GutterContainer(inner);

		assert.deepEqual(wrapper.render(80), ["", " text"]);
	});

	test("forwards mouse events to the wrapped component with the gutter offset removed", () => {
		const received: Array<Record<string, number>> = [];
		const inner = {
			render: () => ["content"],
			invalidate() {},
			handleMouse(event: any) {
				received.push({ x: event.x, y: event.y, width: event.width });
				return { handled: true, focus: true };
			},
		};
		const wrapper = new GutterContainer(inner as any);

		const result = wrapper.handleMouse({ type: "click", button: "left", x: 5, y: 0, screenX: 5, screenY: 0, width: 80, height: 1, shift: false, alt: false, ctrl: false } as any);

		assert.deepEqual(received, [{ x: 4, y: 0, width: 79 }]);
		assert.equal((result as any)?.handled, true);
		assert.equal((result as any)?.focus, true);
		assert.equal((result as any)?.target?.component, inner);
		assert.equal((result as any)?.target?.originX, 1); // gutter inset retained in origin
		assert.equal((result as any)?.target?.originY, 0);
	});

	test("drops clicks on the gutter column itself", () => {
		let forwarded = 0;
		const inner = {
			render: () => ["content"],
			invalidate() {},
			handleMouse: () => { forwarded++; return undefined; },
		};
		const wrapper = new GutterContainer(inner as any);

		assert.equal(wrapper.handleMouse({ type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 1, shift: false, alt: false, ctrl: false } as any), undefined);
		assert.equal(forwarded, 0);
	});

	test("passes mouse through unchanged when the gutter is disabled", () => {
		const received: any[] = [];
		const inner = {
			render: () => ["content"],
			invalidate() {},
			handleMouse: (event: any) => { received.push(event); return { handled: true } as const; },
		};
		const wrapper = new GutterContainer(inner as any);

		const event = { type: "click" as const, button: "left" as const, x: 0, y: 0, screenX: 0, screenY: 0, width: 1, height: 1, shift: false, alt: false, ctrl: false };
		assert.equal((wrapper.handleMouse(event as any) as any)?.handled, true);
		assert.equal((wrapper.handleMouse(event as any) as any)?.target?.component, inner);
	});

	test("forwards hits at every wrapped row without re-rendering at the full width", () => {
		const widths: number[] = [];
		let hits = 0;
		const child = {
			render(width: number) {
				widths.push(width);
				// At the gutter-reduced width the content wraps to two rows; at the
				// full width it would collapse to one, which must not re-run here.
				return width === 39 ? ["one", "two"] : ["one"];
			},
			invalidate() {},
			handleMouse() { hits++; return { handled: true }; },
		};
		const inner = new Container();
		inner.addChild(child as any);
		const wrapper = new GutterContainer(inner as any);

		wrapper.render(40);
		assert.deepEqual(widths, [39]);

		// Row 1 only exists in the guttered (two-row) layout; a full-width
		// fallback render would drop it and swallow the hit.
		const result = wrapper.handleMouse({ type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1, width: 40, height: 2, shift: false, alt: false, ctrl: false } as any);

		assert.equal(hits, 1);
		assert.equal((result as any)?.target?.component, child);
		assert.equal((result as any)?.target?.width, 39);
	});

	test("a real toggle click through a guttered document pins the transcript; presses do not", () => {
		const view = new ScrollView(new Container(), { follow: "end" });
		assert.equal((view as any).isFollowingEnd, true);

		const inner = {
			expanded: false,
			render: () => ["toggle row", "body row"],
			invalidate() {},
			setExpanded(expanded: boolean) { this.expanded = expanded; },
		};
		const section = new RailSectionBlock(inner as any, "toolExecution");
		const doc = { children: [section] };
		const mode = {
			fullscreenLayoutRoot: { entries: [] },
			documentContainer: doc,
			transcriptScrollView: view,
		};
		installGutterWrappers(mode);

		const docWrapper = doc.children[0]!;
		// A left click toggles the section; the document wrapper's anchor pins
		// the transcript at its current scrollTop (follow detached) first.
		docWrapper.handleMouse(click(3, 0, 60, 2));
		assert.equal(inner.expanded, true);
		assert.equal((view as any).isFollowingEnd, false);
		assert.equal((view as any).followSuppressedAtEnd, true);

		// A selection press toggles nothing and never pins.
		docWrapper.handleMouse({ ...click(3, 1, 60, 2), type: "press" });
		assert.equal(inner.expanded, true);
		assert.equal((view as any).isFollowingEnd, false);
		assert.equal((view as any).followSuppressedAtEnd, true);
	});

	test("dock wrappers forward input without a scroll anchor and never pin", () => {
		const view = new ScrollView(new Container(), { follow: "end" });

		const inner = {
			expanded: false,
			render: () => ["toggle row"],
			invalidate() {},
			setExpanded(expanded: boolean) { this.expanded = expanded; },
		};
		const section = new RailSectionBlock(inner as any, "toolExecution");
		const dock = { entries: [{ component: section }] };
		const mode = {
			fullscreenLayoutRoot: { entries: [{ component: dock }] },
			documentContainer: { children: [] },
			transcriptScrollView: view,
		};
		assert.equal(installGutterWrappers(mode), true);

		// A toggle in the dock still works but is not anchored to the transcript.
		dock.entries[0]!.component!.handleMouse(click(3, 0, 60, 1));
		assert.equal(inner.expanded, true);
		assert.equal((view as any).isFollowingEnd, true);
	});
});

describe("gutter wrapper installation", () => {
	test("wraps transcript and dock containers and restores them on uninstall", () => {
		const chat = { render: () => [], invalidate() {} };
		const header = { render: () => [], invalidate() {} };
		const doc = { children: [header, chat] };
		const pending = { render: () => [], invalidate() {} };
		const editor = { render: () => [], invalidate() {} };
		const dock = { entries: [{ component: pending }, { component: editor }] };
		const root = { entries: [{ component: {} }, { component: dock }] };
		const mode = { fullscreenLayoutRoot: root, documentContainer: doc };

		assert.equal(installGutterWrappers(mode), true);
		assert.notEqual(doc.children[0], header);
		assert.notEqual(doc.children[1], chat);
		assert.notEqual(dock.entries[0]!.component, pending);
		assert.notEqual(dock.entries[1]!.component, editor);

		installGutterWrappers(mode);
		uninstallGutterWrappers();

		assert.equal(doc.children[0], header);
		assert.equal(doc.children[1], chat);
		assert.equal(dock.entries[0]!.component, pending);
		assert.equal(dock.entries[1]!.component, editor);
	});

	test("re-installs wrappers after uninstall instead of skipping on the stale marker", () => {
		const view = new ScrollView(new Container(), { follow: "end" });
		const inner = {
			expanded: false,
			render: () => ["toggle row"],
			invalidate() {},
			setExpanded(expanded: boolean) { this.expanded = expanded; },
		};
		const section = new RailSectionBlock(inner as any, "toolExecution");
		const doc = { children: [section] };
		const mode = {
			fullscreenLayoutRoot: { entries: [] },
			documentContainer: doc,
			transcriptScrollView: view,
		};

		assert.equal(installGutterWrappers(mode), true);
		const first = doc.children[0];
		assert.notEqual(first, section);
		uninstallGutterWrappers();
		assert.equal(doc.children[0], section);

		// A second enable must re-wrap with fresh gutter+anchor; the stale inner
		// marker must not skip it, and the toggle must pin the transcript again.
		assert.equal(installGutterWrappers(mode), true);
		assert.notEqual(doc.children[0], section);
		assert.equal((doc.children[0] as any).render(60).length, 1);

		doc.children[0]!.handleMouse(click(3, 0, 60, 1));
		assert.equal(inner.expanded, true);
		assert.equal((view as any).isFollowingEnd, false);

		uninstallGutterWrappers();
		assert.equal(doc.children[0], section);
	});
	test("clears the inner wrapper marker on uninstall without touching foreign markers", () => {
		const child = { render: () => ["msg"], invalidate() {} };
		const other = {};
		// Simulate a foreign owner rebinding the marker after wrap.
		const doc = { children: [child] };
		const mode = { fullscreenLayoutRoot: { entries: [] }, documentContainer: doc };
		installGutterWrappers(mode);
		(child as any)[Symbol.for("pi-rail-ui.gutter-wrapped")] = other;

		uninstallGutterWrappers();

		// The foreign marker is preserved; the child is restored.
		assert.equal((child as any)[Symbol.for("pi-rail-ui.gutter-wrapped")], other);
		assert.equal(doc.children[0], child);
	});
});
