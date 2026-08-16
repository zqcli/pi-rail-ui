import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	AUTO_COLLAPSE_RENDERING_KEY,
	applyDefaultAutoCollapse,
	bashOutputLines,
	collapsedSimpleContentRows,
	collapsedSimpleLine,
	executionHiddenLineCount,
} from "../../../components/executions/execution-collapse";
import { renderExecutionRail } from "../../../components/executions/execution-rail";

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

const darkToolTheme = {
	fg(name: string, value: string) {
		const colors: Record<string, string> = {
			toolTitle: "\x1b[38;2;212;212;212m",
			toolOutput: "\x1b[38;2;128;128;128m",
			muted: "\x1b[38;2;128;128;128m",
		};
		return `${colors[name] ?? ""}${value}`;
	},
};

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

	test("reuses completed collapsed tool rows while the transcript scrolls", () => {
		const component = {
			expanded: false,
			isPartial: false,
			result: { isError: false },
			args: { content: "line\n".repeat(5000), path: "/tmp/output.txt" },
			toolCallId: "call-cache",
			toolName: "write",
			hasRendererDefinition: () => false,
			getTextOutput: () => "created",
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
		};
		const original = () => assert.fail("collapsed simple tools should not use the native expanded renderer");

		const first = renderExecutionRail(component, 80, original, { active: true });
		const second = renderExecutionRail(component, 80, original, { active: true });

		assert.strictEqual(second, first);
		assert.ok(first.some((row) => row.includes("\x1b[38;2;166;227;161m▎")));
		assert.ok(first.some((row) => row.includes("\x1b[48;2;38;52;46m")));
		assert.equal(first.filter(Boolean).every((row) => visibleWidth(row) === 80), true);
	});
});

describe("tool execution rail surface", () => {
	test("renders completed successful tools with the recommended success rail and surface", () => {
		const component = {
			expanded: true,
			isPartial: false,
			result: { isError: false },
			args: { path: "src/index.ts" },
			toolCallId: "call-success",
			toolName: "read",
			hasRendererDefinition: () => true,
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
		};
		const widths: number[] = [];
		const nativeSuccessBg = "\x1b[48;2;40;50;40m";
		const nativeTitleFg = "\x1b[38;2;212;212;212m";
		const nativeOutputFg = "\x1b[38;2;128;128;128m";
		const original = (width: number) => {
			widths.push(width);
			return [`${nativeSuccessBg}${nativeTitleFg}read ${nativeOutputFg}done\x1b[49m`];
		};

		const rows = renderExecutionRail(component, 80, original, { active: true, theme: darkToolTheme });

		assert.ok(widths.length > 0);
		assert.deepEqual([...new Set(widths)], [79]);
		assert.equal(rows.length, 1);
		assert.ok((rows[0] ?? "").includes("\x1b[38;2;166;227;161m▎"));
		assert.ok((rows[0] ?? "").includes("\x1b[48;2;38;52;46m"));
		assert.equal((rows[0] ?? "").includes(nativeSuccessBg), false);
		assert.ok((rows[0] ?? "").includes("\x1b[38;2;205;214;244m"));
		assert.equal((rows[0] ?? "").includes(nativeTitleFg), false);
		assert.ok((rows[0] ?? "").includes("\x1b[38;2;166;173;200m"));
		assert.equal((rows[0] ?? "").includes(nativeOutputFg), false);
		assert.equal(visibleWidth(rows[0] ?? ""), 80);
	});

	test("renders failed tools with the recommended error rail and surface", () => {
		const component = {
			expanded: true,
			isPartial: false,
			result: { isError: true },
			args: { command: "npm run check" },
			toolCallId: "call-error",
			toolName: "bash",
			hasRendererDefinition: () => true,
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
		};
		const nativeErrorBg = "\x1b[48;2;60;40;40m";
		const original = () => [`${nativeErrorBg}failed\x1b[49m`];

		const rows = renderExecutionRail(component, 80, original, { active: true });

		assert.equal(rows.length, 1);
		assert.ok((rows[0] ?? "").includes("\x1b[38;2;243;139;168m▎"));
		assert.ok((rows[0] ?? "").includes("\x1b[48;2;58;39;48m"));
		assert.equal((rows[0] ?? "").includes(nativeErrorBg), false);
		assert.equal(visibleWidth(rows[0] ?? ""), 80);
	});

	test("renders partial tools with the recommended pending rail and surface", () => {
		const component = {
			expanded: true,
			isPartial: true,
			args: { path: "src/index.ts" },
			toolCallId: "call-pending",
			toolName: "read",
			hasRendererDefinition: () => true,
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
		};
		const nativePendingBg = "\x1b[48;2;40;40;50m";
		const original = () => [`${nativePendingBg}reading\x1b[49m`];

		const rows = renderExecutionRail(component, 80, original, { active: true });

		assert.equal(rows.length, 1);
		assert.ok((rows[0] ?? "").includes("\x1b[38;2;137;180;250m▎"));
		assert.ok((rows[0] ?? "").includes("\x1b[48;2;40;43;61m"));
		assert.equal((rows[0] ?? "").includes(nativePendingBg), false);
		assert.equal(visibleWidth(rows[0] ?? ""), 80);
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
