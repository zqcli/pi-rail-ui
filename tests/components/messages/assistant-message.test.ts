import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { installAssistantMessageRail, uninstallAssistantMessageRail } from "../../../components/messages/assistant-message";
import { renderAssistantMessageRail, updateNativeAssistantContent } from "../../../components/messages/assistant-message-rail";
import { stripAnsi } from "../../../core/utils";
import { resolveRailSection } from "../../../rail/rail-section";
import { railThinkingSurface } from "../../../rail/rail-surface";
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

test("keeps a manually expanded thinking block expanded across streaming updates", () => {
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

	block.setExpanded(true);
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
	assert.equal(rows.some((row: string) => row.includes("line6")), true);
	assert.equal(rows.some((row: string) => /more lines/.test(row)), false);
});

test("marks thinking rows so a plain click can expand them", () => {
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
	const rows = block.render(80);

	assert.equal(rows[0]!.includes("\x1b_pi-rail-click:start:"), true);
	assert.equal(rows[rows.length - 1]!.includes("\x1b_pi-rail-click:end:"), true);
});

test("preserves native outputPad, transformers, streaming context, and length status", async () => {
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
	if ("markdownTransformers" in component) {
		assert.match(rendered, /transformed reply/);
		assert.deepEqual(transformContexts.at(-1), {
			messageType: "assistant",
			isStreaming: true,
			availableWidth: 79,
		});
	} else {
		assert.match(rendered, /native reply/);
	}
	assert.match(rendered, /truncated before completion|maximum output token limit/);
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
	component.render(80);
	assert.equal(component.contentContainer.children.some((child: any) => resolveRailSection(child)?.kind === "hostedSearch"), true);

	uninstallAssistantMessageRail();
	component.updateContent(message);
	assert.equal(component.contentContainer.children.some((child: any) => resolveRailSection(child)?.kind === "hostedSearch"), false);
	await installAssistantMessageRail(theme() as any);
	component.render(80);
	assert.equal(component.contentContainer.children.some((child: any) => resolveRailSection(child)?.kind === "hostedSearch"), true);
});
