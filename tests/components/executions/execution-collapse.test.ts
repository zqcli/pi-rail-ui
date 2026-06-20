import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	AUTO_COLLAPSE_RENDERING_KEY,
	applyDefaultAutoCollapse,
	bashOutputLines,
	collapsedSimpleContentRows,
	collapsedSimpleLine,
	executionHiddenLineCount,
} from "../../../components/executions/execution-collapse";

class BashComponent {
	expanded: boolean;
	setExpandedCalls = 0;

	constructor(
		expanded: boolean,
		readonly command: string,
		readonly outputLines: string[],
	) {
		this.expanded = expanded;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.setExpandedCalls++;
	}
}

class ToolComponent {
	expanded = true;
	isPartial = false;
	result = {};
	toolCallId = "call-1";
	toolName = "write";

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
}

describe("execution output accounting", () => {
	test("reads bash output from cached lines or string output", () => {
		assert.deepEqual(bashOutputLines({ outputLines: ["a", "b"] }), ["a", "b"]);
		assert.deepEqual(bashOutputLines({ getOutput: () => "a\nb" }), ["a", "b"]);
		assert.deepEqual(bashOutputLines({ getOutput: () => "" }), []);
	});

	test("counts hidden tool content from rich args and text output", () => {
		const component = {
			args: { oldText: "old\ntext", newText: "new" },
			getTextOutput: () => "out\nmore",
		};

		assert.equal(executionHiddenLineCount(component, "toolExecution"), 5);
	});
});

describe("collapsed simple rendering", () => {
	test("flattens control whitespace for single-line previews", () => {
		assert.equal(collapsedSimpleLine("one\n\t two   three"), "one two three");
	});

	test("returns title, detail, and hint rows without outer padding", () => {
		const rows = collapsedSimpleContentRows("title\n", "detail\tvalue", 3, undefined);

		assert.equal(rows.length, 3);
		assert.equal(rows[0], "title ");
		assert.equal(rows[1], "detail value");
		assert.match(rows[2] ?? "", /\.\.\. \(3 more lines,/);
	});
});

describe("applyDefaultAutoCollapse", () => {
	test("collapses long bash executions by the configured row limit", () => {
		const component = new BashComponent(true, "printf", Array.from({ length: 25 }, (_, index) => `line ${index}`));

		applyDefaultAutoCollapse(component, "bashExecution", () => []);

		assert.equal(component.expanded, false);
		assert.equal(component.setExpandedCalls, 1);
		assert.equal((component as unknown as Record<symbol, unknown>)[AUTO_COLLAPSE_RENDERING_KEY], false);
	});

	test("expands short bash executions by the configured row limit", () => {
		const component = new BashComponent(false, "echo ok", ["ok"]);

		applyDefaultAutoCollapse(component, "bashExecution", () => []);

		assert.equal(component.expanded, true);
		assert.equal(component.setExpandedCalls, 1);
	});

	test("honors collapse-by-default tool names", () => {
		const component = new ToolComponent();

		applyDefaultAutoCollapse(component, "toolExecution", () => ["expanded"]);

		assert.equal(component.expanded, false);
	});
});
