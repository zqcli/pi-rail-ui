import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RailEditorFrameLayoutPlanner } from "../../../components/editor/rail-editor-frame-layout";
import { railEditorSurface } from "../../../rail/rail-surface";

const theme = {
	fg(_name: string, value: string) {
		return value;
	},
};

function input(overrides: Partial<Parameters<RailEditorFrameLayoutPlanner["layout"]>[0]> = {}) {
	return {
		width: 32,
		terminalRows: 20,
		lines: ["hello world"],
		cursor: { line: 0, col: 5 },
		focused: true,
		paddingX: 0,
		autocompleteActive: false,
		autocompletePrefix: "",
		selection: undefined,
		completionRows: [],
		surface: railEditorSurface,
		appTheme: theme,
		...overrides,
	};
}

describe("RailEditorFrameLayoutPlanner", () => {
	test("plans body rows, padding, and mouse-visible map behind one interface", () => {
		const planner = new RailEditorFrameLayoutPlanner();
		const layout = planner.layout(input());

		assert.equal(layout.rows.length, 1);
		assert.equal(layout.visibleMap[0]?.logicalLine, 0);
		assert.equal(layout.topPadding, 1);
		assert.equal(layout.bottomPadding, 2);
		assert.ok(layout.rows[0]?.includes("hello"));
	});

	test("applies selection decoration before surface wrapping", () => {
		const planner = new RailEditorFrameLayoutPlanner();
		const layout = planner.layout(input({
			cursor: { line: 0, col: 0 },
			selection: { start: { line: 0, col: 0 }, end: { line: 0, col: 5 } },
		}));

		assert.ok(layout.rows.join("\n").includes("\x1b[7m"));
	});
});
