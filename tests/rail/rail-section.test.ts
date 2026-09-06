import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TuiAltScreen, type Component, visibleWidth } from "@earendil-works/pi-tui";
import {
	RailSectionBlock,
	canToggleRailSection,
	defineRailSection,
	handleRailSectionClickToggle,
	resolveRailSection,
	setRailSectionExpanded,
	setRailUiActive,
	withRailSectionScrollAnchor,
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

class ToggleableInner {
	expanded = false;
	setExpandedCalls = 0;

	constructor(private readonly lines: string[]) {}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.setExpandedCalls++;
	}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

class MouseInner {
	clicks = 0;

	constructor(private readonly lines: string[]) {}

	handleMouse(): { handled: true } {
		this.clicks++;
		return { handled: true };
	}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

class FakeTerminal {
	columns = 40;
	rows = 12;
	private readonly writes: string[] = [];
	private inputHandler: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void): void {
		this.inputHandler = onInput;
	}

	send(data: string): void {
		this.inputHandler?.(data);
	}

	stop(): void {}
	drainInput(): Promise<void> { return Promise.resolve(); }
	write(data: string): void { this.writes.push(data); }
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

function altScreenFor(block: Component): { tui: TuiAltScreen; terminal: FakeTerminal } {
	const terminal = new FakeTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, { copySelection: async () => true });
	tui.setLayoutRoot(block);
	tui.start();
	tui.renderNow(true);
	return { tui, terminal };
}

function clickEvent(type: string) {
	return {
		type,
		button: "left",
		x: 2,
		y: 0,
		screenX: 2,
		screenY: 0,
		width: 12,
		height: 2,
		shift: false,
		alt: false,
		ctrl: false,
	};
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

describe("rail section component clicks", () => {
	test("toggles a clickable section once per click and consumes the event", () => {
		const component = new ToggleableTool();

		assert.deepEqual(handleRailSectionClickToggle(component, clickEvent("click") as any), { handled: true });
		assert.equal(component.expanded, true);
		assert.equal(wasRailSectionManuallyToggled(component), true);

		assert.deepEqual(handleRailSectionClickToggle(component, clickEvent("click") as any), { handled: true });
		assert.equal(component.expanded, false);
	});

	test("press and release never toggle, so native selection and drag copy keep working", () => {
		const component = new ToggleableTool();

		assert.equal(handleRailSectionClickToggle(component, clickEvent("press") as any), undefined);
		assert.equal(handleRailSectionClickToggle(component, clickEvent("release") as any), undefined);
		assert.equal(handleRailSectionClickToggle(component, clickEvent("drag") as any), undefined);
		assert.equal(component.expanded, false);
	});

	test("a right-button click is not treated as a toggle", () => {
		const component = new ToggleableTool();
		const right = { ...clickEvent("click"), button: "right" };

		assert.equal(handleRailSectionClickToggle(component, right as any), undefined);
		assert.equal(component.expanded, false);
	});

	test("leaves non-toggleable sections to the native pipeline unless suppression is requested", () => {
		const reply = defineRailSection(new ToggleableTool(), "assistantReply");

		assert.equal(handleRailSectionClickToggle(reply, clickEvent("click") as any), undefined);
		assert.equal((reply as any).expanded, false);

		assert.deepEqual(handleRailSectionClickToggle(reply, clickEvent("click") as any, true), { handled: true });
		assert.equal((reply as any).expanded, false);
	});

	test("invokes the active scroll anchor before toggling", () => {
		const component = new ToggleableTool();
		let expandedWhenPinned: boolean | undefined;
		const result = withRailSectionScrollAnchor(
			() => { expandedWhenPinned = component.expanded; },
			() => handleRailSectionClickToggle(component, clickEvent("click") as any),
		);

		assert.deepEqual(result, { handled: true });
		assert.equal(expandedWhenPinned, false, "anchor must run while the section is still collapsed");
		assert.equal(component.expanded, true);
	});

	test("does not pin when nothing toggles", () => {
		const component = new ToggleableTool();
		let pins = 0;
		const reply = defineRailSection(component, "assistantReply");

		withRailSectionScrollAnchor(
			() => { pins++; },
			() => handleRailSectionClickToggle(reply, clickEvent("click") as any),
		);

		assert.equal(pins, 0);
		assert.equal(component.expanded, false);
	});

	test("nested anchor scopes restore the previous anchor", () => {
		const outerA = new ToggleableTool();
		const outerB = new ToggleableTool();
		const inner = new ToggleableTool();
		const order: string[] = [];

		withRailSectionScrollAnchor(() => order.push("outer"), () => {
			handleRailSectionClickToggle(outerA, clickEvent("click") as any);
			withRailSectionScrollAnchor(() => order.push("inner"), () => {
				handleRailSectionClickToggle(inner, clickEvent("click") as any);
				return undefined;
			});
			handleRailSectionClickToggle(outerB, clickEvent("click") as any);
			return undefined;
		});

		assert.deepEqual(order, ["outer", "inner", "outer"]);
		assert.equal(outerA.expanded, true);
		assert.equal(outerB.expanded, true);
		assert.equal(inner.expanded, true);
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

	test("clicking a RailSectionBlock toggles its toggleable inner component", () => {
		const inner = new ToggleableInner(["row one", "row two"]);
		const block = new RailSectionBlock(inner, "hostedSearch");

		assert.deepEqual(block.handleMouse(clickEvent("click") as any), { handled: true });
		assert.equal(inner.expanded, true);
		assert.equal(inner.setExpandedCalls, 1);
		assert.equal(block.handleMouse(clickEvent("press") as any), undefined);
		assert.equal(inner.setExpandedCalls, 1);
	});

	test("restores inner mouse handling when rail UI is inactive", () => {
		const inner = new MouseInner(["row"]);
		const block = new RailSectionBlock(inner, "hostedSearch");
		setRailUiActive(false);
		try {
			assert.deepEqual(block.handleMouse(clickEvent("click") as any), { handled: true });
			assert.equal(inner.clicks, 1);
		} finally {
			setRailUiActive(true);
		}
	});

	test("delegates non-toggleable clicks to the inner control while rail UI is active", () => {
		const inner = new MouseInner(["row"]);
		const block = new RailSectionBlock(inner, "userMessage");

		assert.deepEqual(block.handleMouse(clickEvent("click") as any), { handled: true });
		assert.equal(inner.clicks, 1);
	});

	test("a real fullscreen SGR click toggles the block through the native selection dispatch", () => {
		const inner = new ToggleableInner(["row one", "row two"]);
		const block = new RailSectionBlock(inner, "hostedSearch");
		const { tui, terminal } = altScreenFor(block);
		try {
			assert.equal(inner.expanded, false);
			terminal.send("\x1b[<0;2;1M");
			terminal.send("\x1b[<0;2;1m");
			tui.renderNow(true);
			assert.equal(inner.expanded, true);
		} finally {
			tui.stop();
		}
	});

	test("a fullscreen drag over a section selects without toggling", () => {
		const inner = new ToggleableInner(["row one", "row two"]);
		const block = new RailSectionBlock(inner, "hostedSearch");
		const { tui, terminal } = altScreenFor(block);
		try {
			terminal.send("\x1b[<0;2;1M");
			terminal.send("\x1b[<32;8;1M");
			terminal.send("\x1b[<0;8;1m");
			tui.renderNow(true);
			assert.equal(inner.expanded, false);
		} finally {
			tui.stop();
		}
	});
});
