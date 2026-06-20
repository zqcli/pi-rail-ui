import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	applyTextColor,
	bg,
	fg,
	isThemeReference,
	railAnsiForTheme,
	resolveBackground,
	resolveTextColor,
} from "../../config/colors";
import type { ColorSpec, ThemeLike } from "../../config/types";

const blue: ColorSpec = { rgb: [1, 2, 3] };
const red: ColorSpec = { rgb: [200, 10, 20] };

describe("color ANSI helpers", () => {
	test("renders foreground and background RGB ANSI sequences", () => {
		assert.equal(fg(blue, "blue"), "\x1b[38;2;1;2;3m");
		assert.equal(bg(red, "red"), "\x1b[48;2;200;10;20m");
	});

	test("rejects invalid RGB specs", () => {
		assert.throws(() => fg({ rgb: [1, 2, 300] } as ColorSpec, "invalid"), /Invalid RGB color/);
	});

	test("detects theme color references", () => {
		assert.equal(isThemeReference("theme:muted"), true);
		assert.equal(isThemeReference("editor.rail"), false);
	});
});

describe("color reference resolution", () => {
	test("resolves background references", () => {
		assert.equal(resolveBackground("transparent", "editor-bg"), "");
		assert.equal(resolveBackground("editor.background", "editor-bg"), "editor-bg");
		assert.equal(resolveBackground("theme:bashMode", "editor-bg"), "");
		assert.equal(resolveBackground(blue, "editor-bg"), "\x1b[48;2;1;2;3m");
	});

	test("resolves text color references", () => {
		assert.deepEqual(resolveTextColor("editor.rail", { editorRail: "rail" }), { ansi: "rail" });
		assert.deepEqual(resolveTextColor("theme:muted", { editorRail: "rail" }), { themeKey: "muted" });
		assert.deepEqual(resolveTextColor("transparent", { editorRail: "rail" }), {});
		assert.deepEqual(resolveTextColor(blue, { editorRail: "rail" }), { ansi: "\x1b[38;2;1;2;3m" });
	});

	test("applies static and theme-backed text colors", () => {
		const theme: ThemeLike = { fg: (name, value) => `<${name}>${value}</${name}>` };

		assert.equal(applyTextColor(theme, { themeKey: "accent" }, "value"), "<accent>value</accent>");
		assert.equal(applyTextColor(undefined, { ansi: "ansi:" }, "value"), "ansi:value");
		assert.equal(applyTextColor(undefined, {}, "value"), "value");
	});

	test("extracts a theme rail ANSI prefix with a sentinel", () => {
		const theme: ThemeLike = { fg: (name, value) => `<${name}>${value}</${name}>` };
		const brokenTheme: ThemeLike = { fg: () => "missing sentinel" };

		assert.equal(railAnsiForTheme(theme, { themeKey: "accent" }), "<accent>");
		assert.equal(railAnsiForTheme(brokenTheme, { themeKey: "accent" }), undefined);
		assert.equal(railAnsiForTheme(theme, { ansi: "static" }), "static");
	});
});
