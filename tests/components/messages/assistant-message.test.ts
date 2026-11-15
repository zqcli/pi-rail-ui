import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { installAssistantMessageRail, uninstallAssistantMessageRail } from "../../../components/messages/assistant-message";
import { renderAssistantMessageRail, updateNativeAssistantContent } from "../../../components/messages/assistant-message-rail";
import { stripAnsi } from "../../../core/utils";
import { collapseHint, resolveRailSection, setRailUiActive, wasRailSectionManuallyToggled } from "../../../rail/rail-section";
import { EditorSurfaceRenderer, ThinkingRailBlock, railThinkingSurface } from "../../../rail/rail-surface";
import { railSectionConfig } from "../../../config";
import {
	HostedSearchActivity,
	resetHostedSearchActivities,
	setActiveHostedSearchActivity,
} from "../../../openai/hosted-search-activity";

class Spacer {
	render(): string[] { return [""]; }
	invalidate(): void {}
}

class NativeMarkdown {
	constructor(readonly text: string) {}
	render(): string[] { return [this.text]; }
	invalidate(): void {}
}

class MultiLineMarkdown {
	constructor(readonly text: string) {}
	render(): string[] { return this.text.split("\n"); }
	invalidate(): void {}
}

class NativeError {
	render(): string[] { return ["native error"]; }
	invalidate(): void {}
}

function theme() {
	return {
		fg: (_name: string, value: string) => value,
		bold: (value: string) => value,
	};
}

before(() => {
	initTheme("dark");
});

afterEach(() => {
	uninstallAssistantMessageRail();
	resetHostedSearchActivities();
});

test("native assistant update forwards streaming and never rebuilds twice", () => {
	const calls: Array<{ message: unknown; streaming: boolean | undefined }> = [];
	let decorations = 0;
	const component = {} as any;
	const result = updateNativeAssistantContent(
		component,
		{ id: "message" },
		true,
		function (message, streaming) {
			calls.push({ message, streaming });
			return "native-result";
		},
		() => {
			decorations += 1;
			throw new Error("rail failure");
		},
	);

	assert.equal(result, "native-result");
	assert.deepEqual(calls, [{ message: { id: "message" }, streaming: true }]);
	assert.equal(decorations, 1);
});

test("does not retry a failed Rail decoration on every render", async () => {
	await installAssistantMessageRail(theme() as any);
	const component = new (AssistantMessageComponent as any)();
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "native reply" }],
		stopReason: "stop",
	};
	const originalAddChild = component.contentContainer.addChild.bind(component.contentContainer);
	let additions = 0;
	component.contentContainer.addChild = (child: unknown) => {
		additions++;
		if (additions === 3) throw new Error("decoration failure");
		return originalAddChild(child);
	};
	const patchedUpdateContent = component.updateContent.bind(component);
	let updates = 0;
	component.updateContent = (...args: unknown[]) => {
		updates++;
		return patchedUpdateContent(...args);
	};

	component.updateContent(message);
	component.render(80);
	component.render(80);

	assert.equal(updates, 1);
	assert.match(stripAnsi(component.render(80).join("\n")), /native reply/);
});

test("wraps native assistant children without rebuilding Markdown or error content", () => {
	const thinking = new NativeMarkdown("thinking");
	const reply = new NativeMarkdown("reply");
	const error = new NativeError();
	const children: any[] = [new Spacer(), thinking, new Spacer(), reply, new Spacer(), error];
	const component: any = {
		contentContainer: {
			children,
			clear() { this.children = []; },
			addChild(child: unknown) { this.children.push(child); },
		},
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		hasToolCalls: false,
	};
	const message = {
		content: [
			{ type: "thinking", thinking: "thinking" },
			{ type: "text", text: "reply" },
		],
		stopReason: "length",
	};

	renderAssistantMessageRail(component, message, theme() as any, railThinkingSurface);

	assert.equal(component.contentContainer.children[0], children[0]);
	assert.equal((component.contentContainer.children[1] as any).inner, thinking);
	assert.equal(component.contentContainer.children[2], children[2]);
	assert.equal((component.contentContainer.children[3] as any).inner, reply);
	assert.equal(component.contentContainer.children[4], children[4]);
	assert.equal(component.contentContainer.children[5], error);
	assert.equal(resolveRailSection(component.contentContainer.children[1])?.kind, "assistantThinking");
	assert.equal(resolveRailSection(component.contentContainer.children[3])?.kind, "assistantReply");
});

test("places hosted search activity between assistant thinking and reply", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna" });
	activity.associateMessage({ provider: "custom", model: "gpt-5.6-luna", timestamp: 1234 });
	setActiveHostedSearchActivity(activity);
	const thinking = new NativeMarkdown("thinking");
	const reply = new NativeMarkdown("reply");
	const component: any = {
		contentContainer: {
			children: [new Spacer(), thinking, new Spacer(), reply] as any[],
			clear() { this.children = []; },
			addChild(child: unknown) { this.children.push(child); },
		},
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		hasToolCalls: false,
	};
	const message = {
		provider: "custom",
		model: "gpt-5.6-luna",
		timestamp: 1234,
		content: [
			{ type: "thinking", thinking: "thinking" },
			{ type: "text", text: "reply" },
		],
	};

	renderAssistantMessageRail(component, message, theme() as any, railThinkingSurface);
	const searchIndex = component.contentContainer.children.findIndex((child: any) => child.constructor.name === "HostedSearchRailBlock");
	const thinkingIndex = component.contentContainer.children.findIndex((child: any) => resolveRailSection(child)?.kind === "assistantThinking");
	const replyIndex = component.contentContainer.children.findIndex((child: any) => resolveRailSection(child)?.kind === "assistantReply");
	assert.equal(thinkingIndex < searchIndex && searchIndex < replyIndex, true);
	assert.deepEqual(component.contentContainer.children[searchIndex].render(80), []);
	const searchGap = component.contentContainer.children[searchIndex + 1];
	assert.equal(searchGap.constructor.name, "HostedSearchGap");
	assert.deepEqual(searchGap.render(80), []);

	activity.upsertCall("ws_1", "searching", { type: "search", query: "latest commit" });
	assert.match(stripAnsi(component.contentContainer.children[searchIndex].render(80).join("\n")), /latest commit/);
	assert.deepEqual(searchGap.render(80), [""]);
});

test("keeps a leading gap when search appears before Assistant content", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna" });
	const message = {
		provider: "custom",
		model: "gpt-5.6-luna",
		timestamp: 1357,
		content: [],
	};
	activity.associateMessage(message);
	activity.upsertCall("ws_early", "searching", { type: "search", query: "early" });
	setActiveHostedSearchActivity(activity);
	const component: any = {
		contentContainer: {
			children: [] as unknown[],
			clear() { this.children = []; },
			addChild(child: unknown) { this.children.push(child); },
		},
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		hasToolCalls: false,
	};

	renderAssistantMessageRail(component, message, theme() as any, railThinkingSurface);

	assert.deepEqual(component.contentContainer.children.map((child: any) =>
		resolveRailSection(child)?.kind ?? child.constructor.name,
	), ["HostedSearchGap", "hostedSearch"]);
	assert.deepEqual(component.contentContainer.children[0].render(80), [""]);
});

test("separates hosted search, assistant reply, and later thinking with blank rows", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna" });
	activity.associateMessage({ provider: "custom", model: "gpt-5.6-luna", timestamp: 2468 });
	activity.upsertCall("ws_1", "completed", { type: "search", query: "spacing" });
	activity.complete();
	setActiveHostedSearchActivity(activity);
	const reply = new NativeMarkdown("interim reply");
	const laterThinking = new NativeMarkdown("later thinking");
	const component: any = {
		contentContainer: {
			children: [new Spacer(), reply, laterThinking] as any[],
			clear() { this.children = []; },
			addChild(child: unknown) { this.children.push(child); },
		},
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		hasToolCalls: false,
	};
	const message = {
		provider: "custom",
		model: "gpt-5.6-luna",
		timestamp: 2468,
		content: [
			{ type: "text", text: "interim reply" },
			{ type: "thinking", thinking: "later thinking" },
		],
	};

	renderAssistantMessageRail(component, message, theme() as any, railThinkingSurface);
	const layout = component.contentContainer.children.map((child: any) =>
		resolveRailSection(child)?.kind ?? child.constructor.name,
	);
	assert.deepEqual(layout, [
		"Spacer",
		"hostedSearch",
		"HostedSearchGap",
		"assistantReply",
		"Spacer",
		"assistantThinking",
	]);
	assert.deepEqual(component.contentContainer.children[2].render(80), [""]);
	const rows = component.contentContainer.children
		.flatMap((child: any) => child.render(80))
		.map((row: string) => stripAnsi(row));
	const searchRow = rows.findIndex((row: string) => row.includes("WEB SEARCH"));
	const replyRow = rows.findIndex((row: string) => row.includes("interim reply"));
	const thinkingRow = rows.findIndex((row: string) => row.includes("later thinking"));
	assert.equal(rows.slice(searchRow + 1, replyRow).some((row: string) => row.trim() === ""), true);
	assert.equal(rows.slice(replyRow + 1, thinkingRow).some((row: string) => row.trim() === ""), true);
});

test("automatic thinking expansion follows updates without recording a manual choice", () => {
	const component: any = {
		contentContainer: {
			children: [] as any[],
			clear() { this.children = []; },
			addChild(child: unknown) { this.children.push(child); },
		},
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		hasToolCalls: false,
	};
	let previous: unknown;
	for (const [text, expanded] of [["short", true], ["one\ntwo\nthree\nfour", false], ["short again", true]] as const) {
		component.contentContainer.children = [new MultiLineMarkdown(text)];
		renderAssistantMessageRail(component, { content: [{ type: "thinking", thinking: text }] }, theme() as any, railThinkingSurface);
		const block = component.contentContainer.children[0];
		if (previous) assert.equal(block, previous);
		previous = block;
		block.render(80);
		assert.equal(block.expanded, expanded);
		assert.equal(wasRailSectionManuallyToggled(block), false);
	}
});

test("collapsed thinking decorates only the preview while preserving native rows and narrow-width fallback", () => {
	const limit = railSectionConfig("assistantThinking").autoCollapseAfterRows!;
	const nativeRows = ["", "\x1b[1mtransformed native row\x1b[0m", "中文", ...Array.from({ length: 5000 }, (_, index) => `row ${index}`)];
	for (const width of [4, 80]) {
		const widths: number[] = [];
		const inner = { render(innerWidth: number) { widths.push(innerWidth); return nativeRows; }, invalidate() {} };
		const surface = new EditorSurfaceRenderer(railThinkingSurface.style);
		const expandedRows = new ThinkingRailBlock(inner, surface).render(width);
		const expected = expandedRows.slice(0, limit);
		expected.push(surface.renderSurfaceRow(width, collapseHint(theme(), nativeRows.length - limit)));
		widths.length = 0;
		let decoratedRows = 0;
		const decorate = surface.renderSurfaceRow.bind(surface);
		surface.renderSurfaceRow = (rowWidth, line) => { decoratedRows++; return decorate(rowWidth, line); };
		const component: any = {
			contentContainer: {
				children: [inner] as any[],
				clear() { this.children = []; },
				addChild(child: unknown) { this.children.push(child); },
			},
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			hasToolCalls: false,
		};
		// Raw text decides the collapse count; the visible rows remain native.
		const rawText = "thinking\n".repeat(nativeRows.length).trim();
		renderAssistantMessageRail(component, { content: [{ type: "thinking", thinking: rawText }] }, theme() as any, surface);
		const block = component.contentContainer.children[0];
		assert.deepEqual(block.render(width), expected);
		assert.deepEqual(widths, [width < surface.minRenderableWidth() ? width : surface.contentWidth(width)]);
		assert.equal(decoratedRows, width < surface.minRenderableWidth() ? 1 : limit + 1);
		assert.deepEqual(block.render(width), expected);
		assert.equal(widths.length, 1, "repeated collapsed rendering stays cached");
		block.setExpanded(true);
		assert.deepEqual(block.render(width), expandedRows);
		assert.equal(widths.length, 2, "expanding renders the same native child once");
	}
});

for (const expanded of [true, false]) test(`keeps manually ${expanded ? "expanded" : "collapsed"} thinking across streaming updates`, () => {
	const thinking = new MultiLineMarkdown("line1\nline2\nline3\nline4\nline5");
	const children: any[] = [new Spacer(), thinking];
	const component: any = {
		contentContainer: {
			children,
			clear() { this.children = []; },
			addChild(child: unknown) { this.children.push(child); },
		},
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		hasToolCalls: false,
	};

	renderAssistantMessageRail(
		component,
		{ content: [{ type: "thinking", thinking: "line1\nline2\nline3\nline4\nline5" }] },
		theme() as any,
		railThinkingSurface,
	);
	const block = component.contentContainer.children[1] as any;
	block.render(80); // auto-collapse state is applied lazily during render
	assert.equal(block.expanded, false);

	block.setExpanded(expanded);
	// Simulate Pi's native updateContent replacing children with fresh native components.
	component.contentContainer.children = [new Spacer(), new MultiLineMarkdown("line1\nline2\nline3\nline4\nline5\nline6")];
	renderAssistantMessageRail(
		component,
		{ content: [{ type: "thinking", thinking: "line1\nline2\nline3\nline4\nline5\nline6" }] },
		theme() as any,
		railThinkingSurface,
	);

	assert.equal(component.contentContainer.children[1], block);
	const rows = block.render(80).map((row: string) => stripAnsi(row));
	assert.equal(block.expanded, expanded);
	assert.equal(wasRailSectionManuallyToggled(block), true);
	assert.equal(rows.some((row: string) => row.includes("line6")), expanded);
	assert.equal(rows.some((row: string) => /more lines/.test(row)), false);
});

test("toggles the thinking collapse on a component click, ignoring press and release", () => {
	const thinking = new MultiLineMarkdown("line1\nline2\nline3\nline4");
	const children: any[] = [new Spacer(), thinking];
	const component: any = {
		contentContainer: {
			children,
			clear() { this.children = []; },
			addChild(child: unknown) { this.children.push(child); },
		},
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		hasToolCalls: false,
	};

	renderAssistantMessageRail(
		component,
		{ content: [{ type: "thinking", thinking: "line1\nline2\nline3\nline4" }] },
		theme() as any,
		railThinkingSurface,
	);
	const block = component.contentContainer.children[1] as any;
	const event = (type: string) => ({
		type,
		button: "left",
		x: 2,
		y: 0,
		screenX: 2,
		screenY: 0,
		width: 80,
		height: 4,
		shift: false,
		alt: false,
		ctrl: false,
	});

	block.render(80); // auto-collapse is applied lazily during render
	assert.equal(block.expanded, false);
	const collapsed = stripAnsi(block.render(80).join("\n"));
	assert.match(collapsed, /earlier lines/);
	assert.doesNotMatch(collapsed, /line4/);

	assert.equal(block.handleMouse(event("press") as any), undefined);
	assert.equal(block.handleMouse(event("release") as any), undefined);
	assert.equal(block.expanded, false);

	assert.deepEqual(block.handleMouse(event("click") as any), { handled: true });
	assert.equal(block.expanded, true);
	assert.equal(stripAnsi(block.render(80).join("\n")).includes("line4"), true);
});

test("hands thinking clicks back to the native inner region when rail UI is off", () => {
	let nativeClicks = 0;
	const thinking: any = new MultiLineMarkdown("line1\nline2\nline3\nline4");
	thinking.handleMouse = () => {
		nativeClicks++;
		return { handled: true };
	};
	const component: any = {
		contentContainer: {
			children: [new Spacer(), thinking],
			clear() { this.children = []; },
			addChild(child: unknown) { this.children.push(child); },
		},
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		hasToolCalls: false,
	};
	renderAssistantMessageRail(
		component,
		{ content: [{ type: "thinking", thinking: "line1\nline2\nline3\nline4" }] },
		theme() as any,
		railThinkingSurface,
	);
	const block = component.contentContainer.children[1] as any;
	const click = {
		type: "click",
		button: "left",
		x: 2,
		y: 0,
		screenX: 2,
		screenY: 0,
		width: 80,
		height: 4,
		shift: false,
		alt: false,
		ctrl: false,
	};

	setRailUiActive(false);
	try {
		assert.deepEqual(block.handleMouse(click), { handled: true });
		assert.equal(nativeClicks, 1);
	} finally {
		setRailUiActive(true);
	}
});

test("preserves native outputPad, transformers, streaming context, and length status", async () => {
	const messageId = "assistant-entry";
	const timestamp = "2026-01-03T09:30:00.000Z";
	const transformContexts: any[] = [];
	const transformer = (markdown: string, context: any) => {
		transformContexts.push(context);
		return markdown.replace("native reply", "transformed reply");
	};
	const component = new (AssistantMessageComponent as any)(
		undefined,
		false,
		undefined,
		"Thinking...",
		0,
		[transformer],
		messageId,
		timestamp,
	);
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "native reply" }],
		stopReason: "length",
	};

	await installAssistantMessageRail(theme() as any);
	component.updateContent(message, true);

	const reply = component.contentContainer.children.find((child: any) => resolveRailSection(child)?.kind === "assistantReply");
	const nativeMarkdown = reply?.inner;
	assert.ok(nativeMarkdown);
	assert.equal(nativeMarkdown.paddingX, 0);

	const rendered = stripAnsi(component.render(80).join("\n"));
	assert.match(rendered, /transformed reply/);
	assert.deepEqual(transformContexts.at(-1), {
		messageType: "assistant",
		isStreaming: true,
		availableWidth: 79,
		messageId,
		timestamp,
	});
	assert.match(rendered, /truncated before completion|maximum output token limit/);
});

test("retains Pi Markdown instances and transformer context when a stream finishes", async () => {
	const contexts: any[] = [];
	const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 0, [
		(markdown, context) => {
			contexts.push(context);
			return `${markdown} (${context.isStreaming ? "streaming" : "complete"})`;
		},
	], "stream-entry", "2026-01-03T09:30:00.000Z");
	const message: any = {
		role: "assistant",
		content: [{ type: "text", text: "first reply" }],
		stopReason: "stop",
	};

	await installAssistantMessageRail(theme() as any);
	component.updateContent(message, true);
	const reply = () => (component as any).contentContainer.children.find((child: any) =>
		resolveRailSection(child)?.kind === "assistantReply");
	const markdown = reply().inner;
	assert.match(stripAnsi(component.render(80).join("\n")), /first reply \(streaming\)/);

	message.content[0].text = "final reply";
	component.updateContent(message, false);
	assert.equal(reply().inner, markdown, "Rail preserves Pi's reused Markdown component");
	const completed = stripAnsi(component.render(80).join("\n"));
	assert.match(completed, /final reply \(complete\)/);
	assert.doesNotMatch(completed, /first reply|streaming/);
	assert.deepEqual(contexts.at(-1), {
		messageType: "assistant",
		isStreaming: false,
		availableWidth: 79,
		messageId: "stream-entry",
		timestamp: "2026-01-03T09:30:00.000Z",
	});
});

test("decorates existing native assistant components after Rail is enabled again", async () => {
	const message = {
		role: "assistant",
		provider: "custom",
		model: "gpt-5.6-luna",
		timestamp: 4321,
		content: [{ type: "text", text: "native reply" }],
		stopReason: "stop",
	};
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna" });
	activity.associateMessage(message);
	activity.upsertCall("ws_existing", "completed", { type: "search", query: "existing" });
	activity.complete();
	setActiveHostedSearchActivity(activity);
	const component = new (AssistantMessageComponent as any)(message);
	assert.equal(component.contentContainer.children.some((child: any) => resolveRailSection(child)?.kind === "hostedSearch"), false);

	await installAssistantMessageRail(theme() as any);
	const firstRender = stripAnsi(component.render(80).join("\n"));
	assert.match(firstRender, /1 call/);
	assert.equal(component.contentContainer.children.some((child: any) => resolveRailSection(child)?.kind === "hostedSearch"), true);
	activity.upsertCall("ws_second", "completed", { type: "search", query: "second" });
	const updatedRender = stripAnsi(component.render(80).join("\n"));
	assert.match(updatedRender, /2 calls/);

	uninstallAssistantMessageRail();
	component.updateContent(message);
	assert.equal(component.contentContainer.children.some((child: any) => resolveRailSection(child)?.kind === "hostedSearch"), false);
	await installAssistantMessageRail(theme() as any);
	component.render(80);
	assert.equal(component.contentContainer.children.some((child: any) => resolveRailSection(child)?.kind === "hostedSearch"), true);
});
