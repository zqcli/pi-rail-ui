import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	AUTO_COLLAPSE_RENDERING_KEY,
	applyDefaultAutoCollapse,
	bashOutputLines,
	collapsedPreviewLimit,
} from "../../../components/executions/execution-presentation-policy";

class ToolWithCustomRenderer {
	expanded = true;
	isPartial = false;
	result = {};
	args = { content: "large\ncontent" };
	toolCallId = "call-1";
	toolName = "write";
	setExpandedCalls = 0;

	hasRendererDefinition(): boolean {
		return true;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.setExpandedCalls++;
	}
}

describe("execution presentation policy", () => {
	test("keeps bash output snapshot and preview limit behind the policy interface", () => {
		assert.deepEqual(bashOutputLines({ outputLines: ["a", "b"] }), ["a", "b"]);
		assert.deepEqual(bashOutputLines({ getOutput: () => "a\nb" }), ["a", "b"]);
		assert.equal(collapsedPreviewLimit("bashExecution") > 0, true);
	});

	test("avoids expanded render while remembering a custom-renderer decision", () => {
		const component = new ToolWithCustomRenderer();
		let renders = 0;

		applyDefaultAutoCollapse(component, "toolExecution", () => {
			renders++;
			return ["expanded"];
		}, { avoidExpandedRender: true });
		applyDefaultAutoCollapse(component, "toolExecution", () => {
			renders++;
			return ["expanded"];
		}, { avoidExpandedRender: true });

		assert.equal(renders, 0);
		assert.equal(component.expanded, true);
		assert.equal(component.setExpandedCalls, 0);
		assert.equal((component as unknown as Record<symbol, unknown>)[AUTO_COLLAPSE_RENDERING_KEY], false);
	});
});
