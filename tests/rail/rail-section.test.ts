import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	RailSectionBlock,
	canToggleRailSection,
	defineRailSection,
	resolveRailSection,
	setRailSectionExpanded,
	setRailUiActive,
	wasRailSectionManuallyToggled,
} from "../../rail/rail-section";

class StaticComponent {
	invalidations = 0;
	widths: number[] = [];

	constructor(private readonly lines: string[]) {}

	render(width: number): string[] {
		this.widths.push(width);
		return this.lines;
	}

	invalidate(): void {
		this.invalidations++;
	}
}

class ToggleableTool {
	expanded = false;
	invalidated = false;
	toolName = "read";

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {
		this.invalidated = true;
	}
}

describe("rail section metadata", () => {
	test("resolves explicit metadata and merges overrides", () => {
		const target = defineRailSection(
			{},
			"custom",
			{
				selectable: false,
				layout: { contentStartCol: 3 },
				selection: { includeLeadingBlankRows: true },
			},
		);

		const section = resolveRailSection(target);
		assert.equal(section?.kind, "custom");
		assert.equal(section?.config.selectable, false);
		assert.equal(section?.config.layout.contentStartCol, 3);
		assert.equal(section?.config.selection.includeLeadingBlankRows, true);
	});

	test("detects built-in tool-like components as tool execution sections", () => {
		const section = resolveRailSection(new ToggleableTool());

		assert.equal(section?.kind, "toolExecution");
		assert.equal(section?.config.collapsible, true);
		assert.equal(section?.config.clickToToggle, true);
	});
});

describe("rail section toggling", () => {
	test("expands collapsible sections and marks them as manual", () => {
		const component = new ToggleableTool();
		const section = resolveRailSection(component);
		assert.ok(section);

		assert.equal(canToggleRailSection(section), true);
		setRailSectionExpanded(section, true);

		assert.equal(component.expanded, true);
		assert.equal(component.invalidated, true);
		assert.equal(wasRailSectionManuallyToggled(component), true);
	});

	test("sets explicit expanded state without double toggling", () => {
		const component = new ToggleableTool();
		const section = resolveRailSection(component);
		assert.ok(section);

		setRailSectionExpanded(section, false);

		assert.equal(component.expanded, false);
		assert.equal(component.invalidated, true);
		assert.equal(wasRailSectionManuallyToggled(component), true);
	});
});

describe("RailSectionBlock", () => {
	test("renders through the wrapped component while rail UI is inactive", () => {
		const inner = new StaticComponent(["inner"]);
		const block = new RailSectionBlock(inner, "userMessage");
		setRailUiActive(false);

		try {
			assert.deepEqual(block.render(12), ["inner"]);
			assert.deepEqual(inner.widths, [12]);
		} finally {
			setRailUiActive(true);
		}
	});

	test("wraps active rows with the configured rail surface width", () => {
		const inner = new StaticComponent(["abc"]);
		const block = new RailSectionBlock(inner, "userMessage");
		setRailUiActive(true);

		const rows = block.render(8);

		assert.equal(rows.length, 1);
		assert.equal(visibleWidth(rows[0] ?? ""), 8);
		assert.ok((rows[0] ?? "").includes("abc"));
		assert.deepEqual(inner.widths, [7]);
	});

	test("invalidates both the block cache and the wrapped component", () => {
		const inner = new StaticComponent(["abc"]);
		const block = new RailSectionBlock(inner, "userMessage");

		block.invalidate();

		assert.equal(inner.invalidations, 1);
	});
});
