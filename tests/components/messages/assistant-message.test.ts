import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { installAssistantMessageRail, uninstallAssistantMessageRail } from "../../../components/messages/assistant-message";
import { renderAssistantMessageRail, updateNativeAssistantContent } from "../../../components/messages/assistant-message-rail";
import { stripAnsi } from "../../../core/utils";
import { resolveRailSection } from "../../../rail/rail-section";
import { railThinkingSurface } from "../../../rail/rail-surface";

class Spacer {
	render(): string[] { return [""]; }
	invalidate(): void {}
}

class NativeMarkdown {
	constructor(readonly text: string) {}
	render(): string[] { return [this.text]; }
	invalidate(): void {}
}

class NativeError {
	render(): string[] { return ["native error"]; }
	invalidate(): void {}
}

function theme() {
	return { fg: (_name: string, value: string) => value };
}

before(() => {
	initTheme("dark");
});

afterEach(() => {
	uninstallAssistantMessageRail();
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
