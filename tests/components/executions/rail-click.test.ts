import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripAnsi } from "../../../core/utils";
import { defineRailSection } from "../../../rail/rail-section";
import {
	handleRailSectionClick,
	markRailClickRows,
	railClickComponentAtRow,
	unregisterRailClickComponent,
} from "../../../components/executions/rail-click";

describe("rail section click handling", () => {
	test("unregisters disposed click targets", () => {
		const component = {};
		const rows = markRailClickRows(component, ["row"]);
		assert.equal(railClickComponentAtRow(rows, 0), component);
		unregisterRailClickComponent(component);
		assert.equal(railClickComponentAtRow(rows, 0), undefined);
	});

	test("marks clickable rows without adding visible text", () => {
		const component = {};
		const rows = markRailClickRows(component, ["first", "second"]);

		assert.deepEqual(rows.map(stripAnsi), ["first", "second"]);
		assert.equal(railClickComponentAtRow(rows, 0), component);
		assert.equal(railClickComponentAtRow(rows, 1), component);
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
		const lines = markRailClickRows(component, ["tool", "detail"]);
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

		assert.equal(handleRailSectionClick(tui, { release: true, button: 0 }), true);
		assert.equal(component.expanded, true);
		assert.equal(tui.selectionAnchor, undefined);
		assert.equal(renders, 1);

		tui.selectionPressActive = true;
		tui.selectionDragged = true;
		tui.selectionAnchor = anchor;
		assert.equal(handleRailSectionClick(tui, { release: true, button: 0 }), false);
	});

	test("accepts the generic SGR primary-button release code", () => {
		const component = {
			expanded: false,
			toolName: "write",
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
			invalidate() {},
		};
		const lines = markRailClickRows(component, ["tool"]);
		const scrollView = {};
		const anchor = { row: 0, col: 2, scrollView };
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
			requestRender() {},
		};

		assert.equal(handleRailSectionClick(tui, { release: true, button: 3 }), true);
		assert.equal(component.expanded, true);
	});

	test("toggles a collapsible thinking section on plain click", () => {
		const component: any = defineRailSection({
			expanded: false,
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
			invalidate() {},
		}, "assistantThinking");
		const lines = markRailClickRows(component, ["thinking", "detail"]);
		const scrollView = {};
		const anchor = { row: 0, col: 2, scrollView };
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
			requestRender() {},
		};

		assert.equal(handleRailSectionClick(tui, { release: true, button: 0 }), true);
		assert.equal(component.expanded, true);

		tui.selectionPressActive = true;
		tui.selectionAnchor = anchor;
		assert.equal(handleRailSectionClick(tui, { release: true, button: 0 }), true);
		assert.equal(component.expanded, false);
	});

	test("pins the scroll position so expansion stays at the clicked row", () => {
		const component: any = defineRailSection({
			expanded: false,
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
			invalidate() {},
		}, "assistantThinking");
		const lines = markRailClickRows(component, ["thinking", "detail"]);
		const scrollView = { followingEnd: true };
		const anchor = { row: 0, col: 2, scrollView };
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
			requestRender() {},
		};

		assert.equal(handleRailSectionClick(tui, { release: true, button: 0 }), true);
		assert.equal(component.expanded, true);
		assert.equal(scrollView.followingEnd, false);
	});

	test("does not toggle sections without clickToToggle", () => {
		const component: any = defineRailSection({
			expanded: false,
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
			invalidate() {},
		}, "assistantReply");
		const lines = markRailClickRows(component, ["reply"]);
		const scrollView = {};
		const anchor = { row: 0, col: 1, scrollView };
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
			requestRender() {},
		};

		assert.equal(handleRailSectionClick(tui, { release: true, button: 0 }), false);
		assert.equal(component.expanded, false);
	});
});
