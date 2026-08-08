import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GutterContainer, installGutterWrappers, uninstallGutterWrappers } from "../../rail/gutter";

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

	test("no-ops without a fullscreen layout root", () => {
		assert.equal(installGutterWrappers({}), false);
	});
});
