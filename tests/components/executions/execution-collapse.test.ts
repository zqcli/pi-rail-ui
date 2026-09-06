import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { MouseRegion, Text, TuiAltScreen, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { BashExecutionComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
	AUTO_COLLAPSE_RENDERING_KEY,
	applyDefaultAutoCollapse,
	bashOutputLines,
	collapsedSimpleContentRows,
	collapsedSimpleLine,
	executionHiddenLineCount,
} from "../../../components/executions/execution-collapse";
import { renderExecutionRail } from "../../../components/executions/execution-rail";
import { defineRailSection, withRailSectionScrollAnchor } from "../../../rail/rail-section";
import {
	installExecutionRails,
	uninstallExecutionRails,
} from "../../../components/executions/tool-execution";

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

const mouseEvent = (type: string, button = "left") => ({
	type,
	button,
	x: 2,
	y: 0,
	screenX: 2,
	screenY: 0,
	width: 80,
	height: 3,
	shift: false,
	alt: false,
	ctrl: false,
});

class FakeTerminal {
	columns = 40;
	rows = 12;
	private inputHandler: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void): void {
		this.inputHandler = onInput;
	}

	send(data: string): void {
		this.inputHandler?.(data);
	}

	stop(): void {}
	drainInput(): Promise<void> { return Promise.resolve(); }
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	get kittyProtocolActive(): boolean { return false; }
}

function altScreenFor(component: unknown): { tui: TuiAltScreen; terminal: FakeTerminal } {
	const terminal = new FakeTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, { copySelection: async () => true });
	tui.setLayoutRoot(component as any);
	tui.start();
	tui.renderNow(true);
	return { tui, terminal };
}

describe("execution click handling", () => {
	let ui: any;

	before(() => {
		initTheme("dark", true);
		ui = { requestRender() {}, terminal: { columns: 60, rows: 30 } };
	});

	afterEach(() => {
		uninstallExecutionRails();
	});

	function makeTool(toolDefinition: unknown): ToolExecutionComponent {
		return new ToolExecutionComponent("demo", "call-t", {}, {}, toolDefinition as any, ui, process.cwd());
	}

	function buttonClick(x: number, y: number, width: number, height: number): TuiMouseEvent {
		return { type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false };
	}

	test("generic tool toggles once on click and pins through the active anchor", async () => {
		await installExecutionRails(darkToolTheme as any);
		const component = makeTool(undefined);
		component.updateResult({ content: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `row ${index}`).join("\n") }], details: {}, isError: false }, false);
		component.setExpanded(false);
		const rows = component.render(50);
		let pins = 0;

		const result = withRailSectionScrollAnchor(() => { pins++; }, () =>
			(ToolExecutionComponent.prototype as any).handleMouse.call(component, buttonClick(5, 0, 50, rows.length)));

		assert.deepEqual(result, { handled: true });
		assert.equal((component as any).expanded, true);
		assert.equal(pins, 1);
	});

	test("press, release, and drag never toggle and let Pi's selection own them", async () => {
		await installExecutionRails(darkToolTheme as any);
		const component = makeTool(undefined);
		component.updateResult({ content: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `row ${index}`).join("\n") }], details: {}, isError: false }, false);
		component.setExpanded(false);
		const rows = component.render(50);

		for (const type of ["press", "release", "drag"] as const) {
			const result = (ToolExecutionComponent.prototype as any).handleMouse.call(
				component,
				{ ...buttonClick(5, 0, 50, rows.length), type });
			assert.equal(result, undefined);
		}
		assert.equal((component as any).expanded, false);
	});

	test("non-toggleable generic tools consume the click without toggling", async () => {
		await installExecutionRails(darkToolTheme as any);
		const component = makeTool(undefined);
		component.updateResult({ content: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `row ${index}`).join("\n") }], details: {}, isError: false }, false);
		component.setExpanded(false);
		defineRailSection(component, "toolExecution", { clickToToggle: false });
		const rows = component.render(50);

		const result = (ToolExecutionComponent.prototype as any).handleMouse.call(
			component,
			buttonClick(5, 0, 50, rows.length));

		assert.deepEqual(result, { handled: true });
		assert.equal((component as any).expanded, false);
	});

	test("a generic tool with clickToToggle disabled never toggles (parent probe)", async () => {
		await installExecutionRails(darkToolTheme as any);
		const tool = makeTool(undefined);
		tool.updateResult({ content: [{ type: "text", text: "line 1\nline 2\nline 3" }], details: {}, isError: false }, false);
		defineRailSection(tool, "toolExecution", { clickToToggle: false });
		const rows = tool.render(50);
		const before = (tool as any).expanded;

		for (let y = 0; y < rows.length; y++) {
			tool.handleMouse(buttonClick(5, y, 50, rows.length));
			if ((tool as any).expanded !== before) break;
		}

		assert.equal((tool as any).expanded, before);
	});

	test("a custom renderer control consumes its own click before any Rail toggle (parent probe)", async () => {
		let buttonClicks = 0;
		const def: any = {
			renderCall: () => new MouseRegion(new Text("ACTION BUTTON", 0, 0), (event) => {
				if (event.type !== "click") return undefined;
				buttonClicks++;
				return { handled: true };
			}),
		};
		await installExecutionRails(darkToolTheme as any);
		const custom = makeTool(def);
		custom.updateResult({ content: [{ type: "text", text: "short output" }], details: {}, isError: false }, false);
		custom.setExpanded(true);
		const rows = custom.render(50);
		const buttonRow = rows.findIndex((line: string) => line.includes("ACTION BUTTON"));
		assert.notEqual(buttonRow, -1, "button not rendered");

		const result = custom.handleMouse(buttonClick(5, buttonRow, 50, rows.length));

		assert.equal(buttonClicks, 1);
		assert.equal((custom as any).expanded, true);
		assert.ok(result);
	});

	test("a custom renderer with clickToToggle disabled consumes clicks without toggling or rebuilding", async () => {
		let renderCalls = 0;
		await installExecutionRails(darkToolTheme as any);
		const custom = makeTool({ renderCall: () => {
			renderCalls++;
			return new Text("body", 0, 0);
		} });
		custom.updateResult({ content: [{ type: "text", text: "short" }], details: {}, isError: false }, false);
		custom.setExpanded(true);
		defineRailSection(custom, "toolExecution", { clickToToggle: false });
		const rows = custom.render(50);
		const renderCallsBefore = renderCalls;

		custom.handleMouse(buttonClick(5, 1, 50, rows.length));

		assert.equal((custom as any).expanded, true);
		assert.equal(renderCalls - renderCallsBefore, 0);
	});

	test("an enabled renderer toggles exactly once and pins exactly once", async () => {
		let toggles = 0;
		await installExecutionRails(darkToolTheme as any);
		const tool = makeTool({ renderCall: () => new Text("RENDERER HEADER", 0, 0) });
		tool.updateResult({ content: [{ type: "text", text: "result text" }], details: {}, isError: false }, false);
		tool.setExpanded(true);
		const originalSetExpanded = tool.setExpanded.bind(tool);
		tool.setExpanded = (expanded: boolean) => {
			toggles++;
			originalSetExpanded(expanded);
		};
		const rows = tool.render(50);
		const headerRow = rows.findIndex((line: string) => line.includes("RENDERER HEADER"));
		assert.notEqual(headerRow, -1);
		const togglesBefore = toggles;
		let pins = 0;

		withRailSectionScrollAnchor(() => { pins++; }, () =>
			tool.handleMouse(buttonClick(5, headerRow, 50, rows.length)));

		assert.equal((tool as any).expanded, false);
		assert.equal(toggles - togglesBefore, 1);
		assert.equal(pins, 1);
	});

	test("a custom child that toggles its own expanded state is not rolled back", async () => {
		await installExecutionRails(darkToolTheme as any);
		let owner: any;
		const tool = makeTool({
			renderCall: () => new MouseRegion(new Text("SELF TOGGLE", 0, 0), (event) => {
				if (event.type !== "click") return undefined;
				owner.setExpanded(!owner.expanded);
				return { handled: true };
			}),
		});
		owner = tool;
		tool.updateResult({ content: [{ type: "text", text: "x" }], details: {}, isError: false }, false);
		tool.setExpanded(true);
		defineRailSection(tool, "toolExecution", { clickToToggle: false });
		const rows = tool.render(50);
		const row = rows.findIndex((line: string) => line.includes("SELF TOGGLE"));
		assert.notEqual(row, -1);

		tool.handleMouse(buttonClick(5, row, 50, rows.length));

		// The child control's own toggle stands; Rail must not roll it back.
		assert.equal((tool as any).expanded, false);
	});

	test("a self-render control receives content-space mouse coordinates", async () => {
		const seen: Array<{ x: number; y: number; width: number; height: number }> = [];
		const def: any = {
			renderShell: "self",
			renderCall: () => new MouseRegion(new Text("SELF CONTROL", 0, 0), (event) => {
				if (event.type !== "click") return undefined;
				seen.push({ x: event.x, y: event.y, width: event.width, height: event.height });
				return { handled: true };
			}),
		};
		await installExecutionRails(darkToolTheme as any);
		const tool = makeTool(def);
		tool.updateResult({ content: [{ type: "text", text: "x" }], details: {}, isError: false }, false);
		tool.setExpanded(true);
		const rows = tool.render(50);
		const row = rows.findIndex((line: string) => line.includes("SELF CONTROL"));
		assert.notEqual(row, -1);

		tool.handleMouse(buttonClick(5, row, 50, rows.length));

		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.width, 49, "content width excludes the rail surface inset");
		assert.equal(seen[0]!.x, 4, "x excludes the rail surface inset");
		assert.equal(seen[0]!.y, 0, "self shell strips its leading blank row");
	});

	test("simple-collapsed renderer rows cannot hit a hidden child button and toggle the block instead", async () => {
		let buttonClicks = 0;
		const def: any = {
			renderCall: () => new MouseRegion(new Text("HIDDEN BUTTON", 0, 0), (event) => {
				if (event.type !== "click") return undefined;
				buttonClicks++;
				return { handled: true };
			}),
		};
		await installExecutionRails(darkToolTheme as any);
		const tool = makeTool(undefined);
		tool.updateResult({
			content: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `row ${index}`).join("\n") }],
			details: {},
			isError: false,
		}, false);
		Object.defineProperty(tool, "toolDefinition", {
			value: def,
			configurable: true,
		});
		tool.setExpanded(false);
		const rows = tool.render(50);
		assert.equal(rows.some((line: string) => line.includes("HIDDEN BUTTON")), false);

		tool.handleMouse(buttonClick(5, 0, 50, rows.length));

		assert.equal((tool as any).expanded, true);
		assert.equal(buttonClicks, 0);
	});

	test("a component built before install keeps native clicks, then Rail, then native again", async () => {
		const tool = makeTool({ renderCall: () => new Text("OLD COMPONENT", 0, 0) });
		tool.updateResult({ content: [{ type: "text", text: "x" }], details: {}, isError: false }, false);
		tool.setExpanded(true);
		defineRailSection(tool, "toolExecution", { clickToToggle: false });

		// Built (and rendered) before any rail install: its own native region
		// toggles on click, ignoring the pending rail config.
		const nativeRows = (tool as any).render(50);
		const nativeRow = nativeRows.findIndex((line: string) => line.includes("OLD COMPONENT"));
		assert.notEqual(nativeRow, -1);
		tool.handleMouse(buttonClick(5, nativeRow, 50, nativeRows.length));
		assert.equal((tool as any).expanded, false);

		await installExecutionRails(darkToolTheme as any);
		// Rail active: the rebuild refreshes the region and the collapsed simple
		// rows hide the renderer content; a whole-block click honors the config.
		const railRows = (tool as any).render(50);
		assert.equal(railRows.some((line: string) => line.includes("OLD COMPONENT")), false);
		tool.handleMouse(buttonClick(5, 0, 50, railRows.length));
		assert.equal((tool as any).expanded, false);

		uninstallExecutionRails();
		// Rail off: the same rail-aware region restores the native toggle.
		(tool as any).setExpanded(true);
		const restoredRows = (tool as any).render(50);
		const restoredRow = restoredRows.findIndex((line: string) => line.includes("OLD COMPONENT"));
		assert.notEqual(restoredRow, -1);
		tool.handleMouse(buttonClick(5, restoredRow, 50, restoredRows.length));
		assert.equal((tool as any).expanded, false);

		await installExecutionRails(darkToolTheme as any);
		const reenabledRows = (tool as any).render(50);
		tool.handleMouse(buttonClick(5, 0, 50, reenabledRows.length));
		// Rail is back: the refreshed region consumes again instead of toggling.
		assert.equal((tool as any).expanded, false);
	});

	test("a fullscreen SGR press/drag/release reaches a self-render control with translated coordinates", async () => {
		const phaseEvents: Array<{ type: string; x: number; y: number; width: number }> = [];
		const def: any = {
			renderShell: "self",
			renderCall: () => ({
				render: () => ["PHASE CONTROL"],
				invalidate() {},
				handleMouse(event: any) {
					phaseEvents.push({ type: event.type, x: event.x, y: event.y, width: event.width });
					return event.type === "press" ? { handled: true, capture: true } : { handled: true };
				},
			}),
		};
		await installExecutionRails(darkToolTheme as any);
		const tool = makeTool(def);
		tool.updateResult({ content: [{ type: "text", text: "x" }], details: {}, isError: false }, false);
		tool.setExpanded(true);
		const { tui, terminal } = altScreenFor(tool);
		try {
			const rows = tool.render(40);
			const phaseRow = rows.findIndex((line: string) => line.includes("PHASE CONTROL"));
			assert.notEqual(phaseRow, -1);

			terminal.send(`\x1b[<0;6;${phaseRow + 1}M`);
			terminal.send(`\x1b[<32;10;${phaseRow + 1}M`);
			terminal.send(`\x1b[<0;10;${phaseRow + 1}m`);
			tui.renderNow(true);

			const seen = phaseEvents.filter((event) => event.type !== "click");
			assert.deepEqual(seen.map((event) => event.type), ["press", "drag", "release"]);
			for (const event of seen) {
				assert.equal(event.width, 39, "content width excludes the rail surface inset");
				assert.equal(event.y, 0, "self shell strips its leading blank row");
			}
			assert.deepEqual(seen.map((event) => event.x), [5, 9, 9].map((x: number) => x - 1));
		} finally {
			tui.stop();
		}
	});

	test("a fullscreen press on simple-collapsed rows never reaches the hidden control", async () => {
		const phaseEvents: string[] = [];
		const def: any = {
			renderShell: "self",
			renderCall: () => ({
				render: () => ["PHASE CONTROL"],
				invalidate() {},
				handleMouse(event: any) {
					phaseEvents.push(event.type);
					return { handled: true };
				},
			}),
		};
		await installExecutionRails(darkToolTheme as any);
		const tool = makeTool(def);
		tool.updateResult({ content: [{ type: "text", text: "x" }], details: {}, isError: false }, false);
		tool.setExpanded(false);
		const { tui, terminal } = altScreenFor(tool);
		try {
			const rows = tool.render(40);
			assert.equal(rows.some((line: string) => line.includes("PHASE CONTROL")), false);

			terminal.send("\x1b[<0;6;1M");
			terminal.send("\x1b[<0;6;1m");
			tui.renderNow(true);

			assert.equal(phaseEvents.length, 0);
		} finally {
			tui.stop();
		}
	});

	test("installed prototype handleMouse routes clicks through the seam and stays on native for press", async () => {
		await installExecutionRails(darkToolTheme as any);
		const tool = makeTool(undefined);
		tool.updateResult({ content: [{ type: "text", text: "line 1\nline 2\nline 3" }], details: {}, isError: false }, false);
		defineRailSection(tool, "toolExecution");

		assert.equal(
			(ToolExecutionComponent.prototype as any).handleMouse.call(tool, mouseEvent("press")),
			undefined,
		);
		assert.deepEqual(
			(ToolExecutionComponent.prototype as any).handleMouse.call(tool, mouseEvent("click")),
			{ handled: true },
		);
		assert.equal((tool as any).expanded, true);

		const bash: any = {
			expanded: false,
			children: [],
			command: "echo hi",
			getCommand() {
				return this.command;
			},
			setExpanded(expanded: boolean) {
				this.expanded = expanded;
			},
			invalidate() {},
		};
		assert.equal((BashExecutionComponent.prototype as any).handleMouse.call(bash, mouseEvent("press")), undefined);
		assert.equal(bash.expanded, false);
		assert.deepEqual(
			(BashExecutionComponent.prototype as any).handleMouse.call(bash, mouseEvent("click")),
			{ handled: true },
		);
		assert.equal(bash.expanded, true);
	});
});

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
		assert.ok(first.some((row) => row.includes("\x1b[38;2;123;159;136m▎")));
		assert.ok(first.some((row) => row.includes("\x1b[48;2;41;49;46m")));
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
		assert.ok((rows[0] ?? "").includes("\x1b[38;2;123;159;136m▎"));
		assert.ok((rows[0] ?? "").includes("\x1b[48;2;41;49;46m"));
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
		assert.ok((rows[0] ?? "").includes("\x1b[38;2;188;120;136m▎"));
		assert.ok((rows[0] ?? "").includes("\x1b[48;2;52;43;47m"));
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
