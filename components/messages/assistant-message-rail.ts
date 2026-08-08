import { type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { railSectionConfig } from "../../config";
import {
	EditorSurfaceRenderer,
	SurfaceContentInsetBlock,
	ThinkingRailBlock,
} from "../../rail/rail-surface";
import {
	collapseHint,
	defineRailSection,
	isRailUiActive,
	markRailSectionManuallyToggled,
	wasRailSectionManuallyToggled,
} from "../../rail/rail-section";

export type AssistantMessageRailHost = {
	contentContainer: { children?: Component[]; clear(): void; addChild(component: Component): void };
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	lastMessage?: any;
	hasToolCalls: boolean;
};

export function updateNativeAssistantContent<T>(
	component: AssistantMessageRailHost,
	message: any,
	isStreaming: boolean | undefined,
	original: (this: AssistantMessageRailHost, message: any, isStreaming?: boolean) => T,
	decorate: () => void,
): T {
	const result = original.call(component, message, isStreaming);
	try {
		decorate();
	} catch {
		// Native children are already valid; a Rail decoration failure must not
		// trigger a second native rebuild.
	}
	return result;
}

type AssistantThinkingRailOptions = {
	rawText: string;
	hidden: boolean;
};

const ASSISTANT_THINKING_EXPANDED_KEY = Symbol.for("pi-rail-ui.assistant-thinking-expanded");
const ASSISTANT_THINKING_MANUAL_KEY = Symbol.for("pi-rail-ui.assistant-thinking-manual");
const ASSISTANT_THINKING_BLOCKS_KEY = Symbol.for("pi-rail-ui.assistant-thinking-blocks");
export const ASSISTANT_RENDER_CACHE_KEY = Symbol.for("pi-rail-ui.assistant-render-cache");

class AssistantThinkingRailBlock implements Component {
	expanded = true;
	private autoSetting = false;
	private fullCache?: { width: number; rows: string[] } | undefined;
	private collapsedCache?: { width: number; limit: number; rows: string[] } | undefined;
	private inner: Component;
	private surface: EditorSurfaceRenderer;
	private appTheme: Theme;
	private rawText = "";
	private rawLines: string[] = [];
	private hidden = false;

	constructor(
		inner: Component,
		surface: EditorSurfaceRenderer,
		private readonly owner: any,
		appTheme: Theme,
		options: AssistantThinkingRailOptions,
	) {
		this.inner = inner;
		this.surface = surface;
		this.appTheme = appTheme;
		this.update(inner, surface, appTheme, options);
		defineRailSection(this, "assistantThinking");
		if (owner?.[ASSISTANT_THINKING_MANUAL_KEY] === true) this.expanded = owner[ASSISTANT_THINKING_EXPANDED_KEY] !== false;
	}

	update(inner: Component, surface: EditorSurfaceRenderer, appTheme: Theme, options: AssistantThinkingRailOptions): void {
		this.inner = inner;
		this.surface = surface;
		this.appTheme = appTheme;
		this.rawText = options.rawText.trim();
		this.rawLines = this.rawText ? this.rawText.split(/\r?\n/u) : [];
		this.hidden = options.hidden;
		if (this.owner?.[ASSISTANT_THINKING_MANUAL_KEY] === true) this.expanded = this.owner[ASSISTANT_THINKING_EXPANDED_KEY] !== false;
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (!this.autoSetting) {
			markRailSectionManuallyToggled(this);
			this.owner[ASSISTANT_THINKING_MANUAL_KEY] = true;
			this.owner[ASSISTANT_THINKING_EXPANDED_KEY] = expanded;
		}
		this.invalidate();
	}

	invalidate(): void {
		this.fullCache = undefined;
		this.collapsedCache = undefined;
		if (this.owner && typeof this.owner === "object") delete this.owner[ASSISTANT_RENDER_CACHE_KEY];
		this.inner.invalidate?.();
	}

	private fullRows(width: number): string[] {
		if (this.fullCache?.width === width) return this.fullCache.rows;
		const rows = new ThinkingRailBlock(this.inner, this.surface).render(width);
		this.fullCache = { width, rows };
		return rows;
	}

	private collapsedRows(width: number, limit: number): string[] {
		if (this.collapsedCache?.width === width && this.collapsedCache.limit === limit) return this.collapsedCache.rows;
		if (this.hidden || this.rawLines.length <= limit) return this.fullRows(width);

		// Keep Pi's already-rendered child so Mermaid, LaTeX, outputPad, and
		// extension Markdown transformers remain native. Only truncate rows for
		// the optional Rail collapse presentation; never rebuild Markdown here.
		const previewRows = this.fullRows(width).slice(0, Math.max(1, limit));
		const hidden = Math.max(0, this.rawLines.length - limit);
		const rows = [...previewRows, this.surface.renderSurfaceRow(width, collapseHint(this.appTheme, hidden))];
		this.collapsedCache = { width, limit, rows };
		return rows;
	}

	private setExpandedAutomatically(expanded: boolean): void {
		this.autoSetting = true;
		try {
			this.expanded = expanded;
		} finally {
			this.autoSetting = false;
		}
	}

	render(width: number): string[] {
		if (!isRailUiActive()) return this.inner.render(width);
		const config = railSectionConfig("assistantThinking");
		const limit = config.collapsible ? config.autoCollapseAfterRows : undefined;
		if (!limit || this.hidden || this.rawLines.length <= limit) {
			if (!wasRailSectionManuallyToggled(this) && this.owner?.[ASSISTANT_THINKING_MANUAL_KEY] !== true) this.setExpandedAutomatically(true);
			return this.fullRows(width);
		}

		if (!wasRailSectionManuallyToggled(this) && this.owner?.[ASSISTANT_THINKING_MANUAL_KEY] !== true) this.setExpandedAutomatically(false);
		return this.expanded ? this.fullRows(width) : this.collapsedRows(width, limit);
	}
}

function assistantThinkingBlocks(component: AssistantMessageRailHost): AssistantThinkingRailBlock[] {
	return ((component as any)[ASSISTANT_THINKING_BLOCKS_KEY] ??= []) as AssistantThinkingRailBlock[];
}

function assistantThinkingBlockFor(
	component: AssistantMessageRailHost,
	index: number,
	inner: Component,
	surface: EditorSurfaceRenderer,
	appTheme: Theme,
	options: AssistantThinkingRailOptions,
): AssistantThinkingRailBlock {
	const blocks = assistantThinkingBlocks(component);
	let block = blocks[index];
	if (block) block.update(inner, surface, appTheme, options);
	else block = blocks[index] = new AssistantThinkingRailBlock(inner, surface, component, appTheme, options);
	return block;
}

function trimAssistantThinkingBlocks(component: AssistantMessageRailHost, count: number): void {
	const blocks = (component as any)[ASSISTANT_THINKING_BLOCKS_KEY] as AssistantThinkingRailBlock[] | undefined;
	if (blocks) blocks.length = count;
}

type AssistantRailBlock = {
	kind: "reply" | "thinking";
	rawText: string;
};

function nativeAssistantRailBlocks(message: any): AssistantRailBlock[] {
	const blocks: AssistantRailBlock[] = [];
	let thinkingParts: string[] = [];

	const flushThinking = () => {
		if (thinkingParts.length > 0) {
			blocks.push({ kind: "thinking", rawText: thinkingParts.join("\n\n") });
			thinkingParts = [];
		}
	};

	for (const part of Array.isArray(message?.content) ? message.content : []) {
		if (part?.type === "thinking") {
			if (part.thinking?.trim()) thinkingParts.push(part.thinking.trim());
			continue;
		}
		flushThinking();
		if (part?.type === "text" && part.text?.trim()) blocks.push({ kind: "reply", rawText: part.text.trim() });
	}
	flushThinking();
	return blocks;
}

function isNativeSpacer(child: any): boolean {
	return child?.constructor?.name === "Spacer";
}

export function renderAssistantMessageRail(
	component: AssistantMessageRailHost,
	message: any,
	appTheme: Theme,
	surface: EditorSurfaceRenderer,
): void {
	component.lastMessage = message;
	const nativeChildren = [...(component.contentContainer.children ?? [])];
	const blocks = nativeAssistantRailBlocks(message);
	const nextChildren: Component[] = [];
	let blockIndex = 0;
	let thinkingIndex = 0;

	for (const child of nativeChildren) {
		if (isNativeSpacer(child)) {
			nextChildren.push(child);
			continue;
		}

		const block = blocks[blockIndex++];
		if (!block) {
			// Native status/error children are intentionally left untouched.
			nextChildren.push(child);
			continue;
		}

		if (block.kind === "reply") {
			const reply = new SurfaceContentInsetBlock(child, surface);
			defineRailSection(reply, "assistantReply");
			nextChildren.push(reply);
			continue;
		}

		nextChildren.push(assistantThinkingBlockFor(component, thinkingIndex++, child, surface, appTheme, {
			rawText: block.rawText,
			hidden: component.hideThinkingBlock,
		}));
	}

	component.contentContainer.clear();
	try {
		for (const child of nextChildren) component.contentContainer.addChild(child);
	} catch (error) {
		component.contentContainer.clear();
		for (const child of nativeChildren) component.contentContainer.addChild(child);
		throw error;
	}
	trimAssistantThinkingBlocks(component, thinkingIndex);

	component.hasToolCalls = (Array.isArray(message?.content) ? message.content : []).some((part: any) => part?.type === "toolCall");
}
