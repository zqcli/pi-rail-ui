import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripAnsi } from "../../../core/utils";
import {
	executionComponentAtRow,
	handleExecutionClick,
	markExecutionRows,
} from "../../../components/executions/execution-click";

describe("execution click handling", () => {
	test("marks execution rows without adding visible text", () => {
		const component = {};
		const rows = markExecutionRows(component, ["first", "second"]);

		assert.deepEqual(rows.map(stripAnsi), ["first", "second"]);
		assert.equal(executionComponentAtRow(rows, 0), component);
		assert.equal(executionComponentAtRow(rows, 1), component);
	});

	test("toggles the clicked execution without taking over drag selection", () => {
		let renders = 0;
		const component = {
			expanded: false,
			toolName: "write",
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
			invalidate() {},
		};
		const lines = markExecutionRows(component, ["tool", "detail"]);
		const scrollView = {};
		const anchor = { row: 1, col: 3, scrollView };
		const tui = {
			selectionPressActive: true,
			selectionDragged: false,
			selectionInitialRange: undefined,
			pressedUrl: undefined,
			selectionAnchor: anchor,
			selectionFocus: anchor,
			selectionGranularity: "character",
			currentLayout: {
				root: { children: [{ scrollView, scrollContentLines: lines, children: [] }] },
			},
			getSelectionPoint: () => anchor,
			stopSelectionAutoScroll() {},
			requestRender: () => renders++,
		};

		assert.equal(handleExecutionClick(tui, { release: true, button: 0 }), true);
		assert.equal(component.expanded, true);
		assert.equal(tui.selectionAnchor, undefined);
		assert.equal(renders, 1);

		tui.selectionPressActive = true;
		tui.selectionDragged = true;
		tui.selectionAnchor = anchor;
		assert.equal(handleExecutionClick(tui, { release: true, button: 0 }), false);
	});
});