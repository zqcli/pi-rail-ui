import {
	AssistantMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { railSectionConfig } from "../../config";
import { PrototypePatchTarget, resolveNativePiExport, restorePrototypePatches, getInteractiveModeConstructors, createStore } from "../../core/patching";
import { cachedRender } from "../../rail/render-cache";
import {
	EditorSurfaceRenderer,
	SurfaceContentInsetBlock,
	ThinkingRailBlock,
	thinkingSurfaceForTheme,
	railThinkingSurface,
} from "../../rail/rail-surface";
import {
	collapseHint,
	defineRailSection,
	isRailUiActive,
	markRailSectionManuallyToggled,
	setCollapsibleRailSectionsExpanded,
	wasRailSectionManuallyToggled,
} from "../../rail/rail-section";

// -----------------------------------------------------------------------------
// Assistant thinking/reply surface patch
// -----------------------------------------------------------------------------

type AssistantMessageWithInternals = {
	contentContainer: { children?: Component[]; clear(): void; addChild(component: Component): void };
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	markdownTheme: ConstructorParameters<typeof Markdown>[3];
	lastMessage?: any;
	hasToolCalls: boolean;
};

type AssistantMessageConstructor = {
	prototype: AssistantMessageWithInternals & { updateContent(message: any): void; render(width: number): string[] };
};

type InteractiveModeConstructor = {
	prototype: { setToolsExpanded(expanded: boolean): void };
};

type AssistantMessageRailPatchStore = {
	active: boolean;
	installed: boolean;
	targets: PrototypePatchTarget[];
	theme?: Theme | undefined;
	surface: EditorSurfaceRenderer;
};

const ASSISTANT_THINKING_EXPANDED_KEY = Symbol.for("pi-rail-ui.assistant-thinking-expanded");
const ASSISTANT_THINKING_MANUAL_KEY = Symbol.for("pi-rail-ui.assistant-thinking-manual");
const ASSISTANT_THINKING_BLOCKS_KEY = Symbol.for("pi-rail-ui.assistant-thinking-blocks");
const ASSISTANT_RENDER_CACHE_KEY = Symbol.for("pi-rail-ui.assistant-render-cache");

const getAssistantMessageRailPatchStore = createStore<AssistantMessageRailPatchStore>("assistant-message-rail-patch", () => ({
	active: false,
	installed: false,
	targets: [],
	surface: railThinkingSurface,
}));

function isAssistantVisiblePart(part: any): boolean {
	return (part?.type === "text" && !!part.text?.trim()) || (part?.type === "thinking" && !!part.thinking?.trim());
}

function visibleAssistantSuffixMap(content: any[]): boolean[] {
	const suffix = new Array<boolean>(content.length + 1).fill(false);
	for (let i = content.length - 1; i >= 0; i--) {
		suffix[i] = suffix[i + 1]! || isAssistantVisiblePart(content[i]);
	}
	return suffix;
}

function makeThinkingMarkdown(text: string, markdownTheme: ConstructorParameters<typeof Markdown>[3], appTheme: Theme): Markdown {
	return new Markdown(text.trim(), 1, 0, markdownTheme, {
		color: (value) => appTheme.fg("thinkingText", value),
		italic: true,
	});
}

function makeHiddenThinkingLabel(label: string, appTheme: Theme): Text {
	return new Text(appTheme.italic(appTheme.fg("thinkingText", label)), 1, 0);
}

type AssistantThinkingRailOptions = {
	rawText: string;
	markdownTheme: ConstructorParameters<typeof Markdown>[3];
	hidden: boolean;
};

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
	private markdownTheme: ConstructorParameters<typeof Markdown>[3];

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
		this.markdownTheme = options.markdownTheme;
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
		this.markdownTheme = options.markdownTheme;
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

		const previewText = this.rawLines.slice(0, limit).join("\n");
		const previewInner = makeThinkingMarkdown(previewText, this.markdownTheme, this.appTheme);
		const previewRows = new ThinkingRailBlock(previewInner, this.surface).render(width);
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

function assistantThinkingBlocks(component: AssistantMessageWithInternals): AssistantThinkingRailBlock[] {
	return ((component as any)[ASSISTANT_THINKING_BLOCKS_KEY] ??= []) as AssistantThinkingRailBlock[];
}

function assistantThinkingBlockFor(
	component: AssistantMessageWithInternals,
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

function trimAssistantThinkingBlocks(component: AssistantMessageWithInternals, count: number): void {
	const blocks = (component as any)[ASSISTANT_THINKING_BLOCKS_KEY] as AssistantThinkingRailBlock[] | undefined;
	if (blocks) blocks.length = count;
}

function updateAssistantMessageWithRail(
	component: AssistantMessageWithInternals,
	message: any,
	appTheme: Theme,
	surface: EditorSurfaceRenderer,
): void {
	component.lastMessage = message;
	component.contentContainer.clear();

	const content: any[] = Array.isArray(message?.content) ? message.content : [];
	const hasVisibleAfter = visibleAssistantSuffixMap(content);
	if (hasVisibleAfter[0]) component.contentContainer.addChild(new Spacer(1));

	let thinkingIndex = 0;
	for (let i = 0; i < content.length; i++) {
		const part = content[i];
		if (part?.type === "text" && part.text?.trim()) {
			const reply = new SurfaceContentInsetBlock(new Markdown(part.text.trim(), 1, 0, component.markdownTheme), surface);
			defineRailSection(reply, "assistantReply");
			component.contentContainer.addChild(reply);
		} else if (part?.type === "thinking" && part.thinking?.trim()) {
			const hasVisibleContentAfter = hasVisibleAfter[i + 1];
			const hidden = component.hideThinkingBlock;
			const inner = hidden
				? makeHiddenThinkingLabel(component.hiddenThinkingLabel, appTheme)
				: makeThinkingMarkdown(part.thinking, component.markdownTheme, appTheme);
			component.contentContainer.addChild(assistantThinkingBlockFor(component, thinkingIndex++, inner, surface, appTheme, {
				rawText: part.thinking,
				markdownTheme: component.markdownTheme,
				hidden,
			}));
			if (hasVisibleContentAfter) component.contentContainer.addChild(new Spacer(1));
		}
	}
	trimAssistantThinkingBlocks(component, thinkingIndex);

	const hasToolCalls = content.some((part) => part?.type === "toolCall");
	component.hasToolCalls = hasToolCalls;
	if (hasToolCalls) return;

	if (message?.stopReason === "aborted") {
		const abortMessage =
			message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted";
		component.contentContainer.addChild(new Spacer(1));
		component.contentContainer.addChild(new Text(appTheme.fg("error", abortMessage), 1, 0));
	} else if (message?.stopReason === "error") {
		const errorMsg = message.errorMessage || "Unknown error";
		component.contentContainer.addChild(new Spacer(1));
		component.contentContainer.addChild(new Text(appTheme.fg("error", `Error: ${errorMsg}`), 1, 0));
	}
}

async function getAssistantMessageConstructors(): Promise<AssistantMessageConstructor[]> {
	const ctors: AssistantMessageConstructor[] = [AssistantMessageComponent as unknown as AssistantMessageConstructor];
	const nativeCtor = await resolveNativePiExport<AssistantMessageConstructor>(
		"./modes/interactive/components/assistant-message.js",
		"AssistantMessageComponent",
	);
	if (nativeCtor && !ctors.includes(nativeCtor)) ctors.push(nativeCtor);
	return ctors;
}

function patchAssistantRenderCache(ctor: AssistantMessageConstructor, store: AssistantMessageRailPatchStore): void {
	if (!ctor?.prototype || store.targets.some((target) => target.ctor === ctor && target.methodName === "render")) return;
	const original = ctor.prototype.render;
	ctor.prototype.render = function patchedAssistantRender(this: AssistantMessageWithInternals, width: number): string[] {
		const currentStore = getAssistantMessageRailPatchStore();
		if (!currentStore.active) return original.call(this, width);
		const signature = [width, this.lastMessage ? 1 : 0, this.hasToolCalls ? 1 : 0, this.hideThinkingBlock ? 1 : 0, this.hiddenThinkingLabel ?? ""].join("\u001f");
		const children = Array.isArray(this.contentContainer?.children) ? this.contentContainer.children : [];
		return cachedRender(this, ASSISTANT_RENDER_CACHE_KEY, signature, () => original.call(this, width), { message: this.lastMessage, children });
	};
	store.targets.push({ ctor, methodName: "render", original });
}

function patchGlobalRailSectionExpansion(ctor: InteractiveModeConstructor, store: AssistantMessageRailPatchStore): void {
	if (!ctor?.prototype || store.targets.some((target) => target.ctor === ctor && target.methodName === "setToolsExpanded")) return;
	const original = ctor.prototype.setToolsExpanded;
	if (typeof original !== "function") return;
	ctor.prototype.setToolsExpanded = function patchedSetToolsExpanded(this: any, expanded: boolean): void {
		const result = original.call(this, expanded);
		try {
			const activeHeader = this.customHeader ?? this.builtInHeader;
			let count = setCollapsibleRailSectionsExpanded(activeHeader, expanded);
			for (const child of this.chatContainer?.children ?? []) count += setCollapsibleRailSectionsExpanded(child, expanded);
			if (count > 0) this.ui?.requestRender?.();
		} catch {
			// Preserve native Ctrl+O behavior if private internals differ.
		}
		return result;
	};
	store.targets.push({ ctor, methodName: "setToolsExpanded", original });
}

export async function installAssistantMessageRail(theme: Theme): Promise<void> {
	const store = getAssistantMessageRailPatchStore();
	store.theme = theme;
	store.surface = thinkingSurfaceForTheme(theme);
	store.active = true;

	for (const ctor of await getAssistantMessageConstructors()) {
		if (!store.targets.some((target) => target.ctor === ctor && target.methodName === "updateContent")) {
			const original = ctor.prototype.updateContent;
			ctor.prototype.updateContent = function patchedUpdateContent(this: AssistantMessageWithInternals, message: any) {
				delete (this as any)[ASSISTANT_RENDER_CACHE_KEY];
				const currentStore = getAssistantMessageRailPatchStore();
				if (!currentStore.active || !currentStore.theme) return original.call(this, message);
				try {
					return updateAssistantMessageWithRail(this, message, currentStore.theme, currentStore.surface);
				} catch {
					return original.call(this, message);
				}
			};
			store.targets.push({ ctor, methodName: "updateContent", original });
		}
		patchAssistantRenderCache(ctor, store);
	}

	for (const ctor of await getInteractiveModeConstructors()) patchGlobalRailSectionExpansion(ctor, store);

	store.installed = store.targets.length > 0;
}

export function uninstallAssistantMessageRail(): void {
	const store = getAssistantMessageRailPatchStore();
	store.active = false;
	store.theme = undefined;
	restorePrototypePatches(store.targets);
	store.installed = false;
}
