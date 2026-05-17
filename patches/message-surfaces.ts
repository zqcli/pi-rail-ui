import {
	AssistantMessageComponent,
	InteractiveMode,
	UserMessageComponent,
	keyHint,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { USER_MESSAGE_LAYOUT, applyTextColor, railSectionConfig } from "../config";
import { PrototypePatchTarget, resolveNativePiExport, restorePrototypePatches } from "../patching";
import {
	EditorSurfaceRenderer,
	SurfaceContentInsetBlock,
	ThinkingSurfaceBlock,
	thinkingSurfaceForTheme,
	tallGrayThinkingSurface,
	tallGrayUserMessageSurface,
} from "../ui/rail-surface";
import {
	defineRailSection,
	markRailSectionManuallyToggled,
	setCollapsibleRailSectionsExpanded,
	wasRailSectionManuallyToggled,
} from "../ui/rail-section";
import { OSC133_ZONE_END, OSC133_ZONE_FINAL, OSC133_ZONE_START, padToWidth } from "../utils";

// -----------------------------------------------------------------------------
// Assistant thinking/reply surface patch
// -----------------------------------------------------------------------------

type AssistantMessageWithInternals = AssistantMessageComponent & {
	contentContainer: { clear(): void; addChild(component: Component): void };
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

type ThinkingSurfacePatchStore = {
	active: boolean;
	installed: boolean;
	targets: PrototypePatchTarget[];
	theme?: Theme;
	surface: EditorSurfaceRenderer;
};

const THINKING_SURFACE_PATCH_KEY = Symbol.for("pi-rail-ui.thinking-surface-patch");
const ASSISTANT_THINKING_EXPANDED_KEY = Symbol.for("pi-rail-ui.assistant-thinking-expanded");
const ASSISTANT_THINKING_MANUAL_KEY = Symbol.for("pi-rail-ui.assistant-thinking-manual");
const ASSISTANT_RENDER_CACHE_KEY = Symbol.for("pi-rail-ui.assistant-render-cache");
const USER_MESSAGE_RENDER_CACHE_KEY = Symbol.for("pi-rail-ui.user-message-render-cache");

function getThinkingSurfacePatchStore(): ThinkingSurfacePatchStore {
	const globalStore = globalThis as typeof globalThis & { [THINKING_SURFACE_PATCH_KEY]?: ThinkingSurfacePatchStore };
	const store = (globalStore[THINKING_SURFACE_PATCH_KEY] ??= {
		active: false,
		installed: false,
		targets: [],
		surface: tallGrayThinkingSurface,
	});
	store.targets ??= [];
	store.surface ??= tallGrayThinkingSurface;
	return store;
}

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

function collapseHint(appTheme: Theme, hiddenLineCount: number): string {
	const prefix = appTheme.fg("muted", `... (${Math.max(0, hiddenLineCount)} earlier lines,`);
	try {
		return `${prefix} ${keyHint("app.tools.expand", "to expand")})`;
	} catch {
		return `${prefix} ${appTheme.fg("dim", "ctrl+o")}${appTheme.fg("muted", " to expand")})`;
	}
}

type AssistantThinkingRailOptions = {
	rawText: string;
	markdownTheme: ConstructorParameters<typeof Markdown>[3];
	hidden: boolean;
	hiddenLabel: string;
};

class AssistantThinkingRailBlock implements Component {
	expanded = true;
	private autoSetting = false;
	private fullCache?: { width: number; rows: string[] };
	private collapsedCache?: { width: number; limit: number; rows: string[] };
	private readonly rawText: string;
	private readonly rawLines: string[];
	private readonly hidden: boolean;
	private readonly markdownTheme: ConstructorParameters<typeof Markdown>[3];
	private readonly hiddenLabel: string;

	constructor(
		private readonly inner: Component,
		private readonly surface: EditorSurfaceRenderer,
		private readonly owner: any,
		private readonly appTheme: Theme,
		options: AssistantThinkingRailOptions,
	) {
		this.rawText = options.rawText.trim();
		this.rawLines = this.rawText ? this.rawText.split(/\r?\n/u) : [];
		this.hidden = options.hidden;
		this.markdownTheme = options.markdownTheme;
		this.hiddenLabel = options.hiddenLabel;
		defineRailSection(this, "assistantThinking");
		if (owner?.[ASSISTANT_THINKING_MANUAL_KEY] === true) this.expanded = owner[ASSISTANT_THINKING_EXPANDED_KEY] !== false;
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
		const rows = new ThinkingSurfaceBlock(this.inner, this.surface).render(width);
		this.fullCache = { width, rows };
		return rows;
	}

	private collapsedRows(width: number, limit: number): string[] {
		if (this.collapsedCache?.width === width && this.collapsedCache.limit === limit) return this.collapsedCache.rows;
		if (this.hidden || this.rawLines.length <= limit) return this.fullRows(width);

		const previewText = this.rawLines.slice(0, limit).join("\n");
		const previewInner = makeThinkingMarkdown(previewText, this.markdownTheme, this.appTheme);
		const previewRows = new ThinkingSurfaceBlock(previewInner, this.surface).render(width);
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

function updateAssistantMessageWithThinkingSurface(
	component: AssistantMessageWithInternals,
	message: any,
	appTheme: Theme,
	surface: EditorSurfaceRenderer,
): void {
	component.lastMessage = message;
	component.contentContainer.clear();

	const content = Array.isArray(message?.content) ? message.content : [];
	const hasVisibleAfter = visibleAssistantSuffixMap(content);
	if (hasVisibleAfter[0]) component.contentContainer.addChild(new Spacer(1));

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
			component.contentContainer.addChild(new AssistantThinkingRailBlock(inner, surface, component, appTheme, {
				rawText: part.thinking,
				markdownTheme: component.markdownTheme,
				hidden,
				hiddenLabel: component.hiddenThinkingLabel,
			}));
			if (hasVisibleContentAfter) component.contentContainer.addChild(new Spacer(1));
		}
	}

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

async function getInteractiveModeConstructors(): Promise<InteractiveModeConstructor[]> {
	const ctors: InteractiveModeConstructor[] = [InteractiveMode as unknown as InteractiveModeConstructor];
	const nativeCtor = await resolveNativePiExport<InteractiveModeConstructor>(
		"./modes/interactive/interactive-mode.js",
		"InteractiveMode",
	);
	if (nativeCtor && !ctors.includes(nativeCtor)) ctors.push(nativeCtor);
	return ctors;
}

function patchAssistantRenderCache(ctor: AssistantMessageConstructor, store: ThinkingSurfacePatchStore): void {
	if (!ctor?.prototype || store.targets.some((target) => target.ctor === ctor && target.methodName === "render")) return;
	const original = ctor.prototype.render;
	ctor.prototype.render = function patchedAssistantRender(this: AssistantMessageWithInternals, width: number): string[] {
		const currentStore = getThinkingSurfacePatchStore();
		if (!currentStore.active) return original.call(this, width);
		const signature = [width, this.lastMessage ? 1 : 0, this.hasToolCalls ? 1 : 0, this.hideThinkingBlock ? 1 : 0, this.hiddenThinkingLabel ?? ""].join("\u001f");
		const cache = (this as any)[ASSISTANT_RENDER_CACHE_KEY] as { signature: string; message: any; children: any[]; rows: string[] } | undefined;
		const children = Array.isArray(this.contentContainer?.children) ? this.contentContainer.children : [];
		if (cache?.signature === signature && cache.message === this.lastMessage && cache.children === children) return cache.rows;
		const rows = original.call(this, width);
		(this as any)[ASSISTANT_RENDER_CACHE_KEY] = { signature, message: this.lastMessage, children, rows };
		return rows;
	};
	store.targets.push({ ctor, methodName: "render", original });
}

function patchGlobalRailSectionExpansion(ctor: InteractiveModeConstructor, store: ThinkingSurfacePatchStore): void {
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

export async function installThinkingSurface(theme: Theme): Promise<void> {
	const store = getThinkingSurfacePatchStore();
	store.theme = theme;
	store.surface = thinkingSurfaceForTheme(theme);
	store.active = true;

	for (const ctor of await getAssistantMessageConstructors()) {
		if (!store.targets.some((target) => target.ctor === ctor && target.methodName === "updateContent")) {
			const original = ctor.prototype.updateContent;
			ctor.prototype.updateContent = function patchedUpdateContent(this: AssistantMessageWithInternals, message: any) {
				delete (this as any)[ASSISTANT_RENDER_CACHE_KEY];
				const currentStore = getThinkingSurfacePatchStore();
				if (!currentStore.active || !currentStore.theme) return original.call(this, message);
				try {
					return updateAssistantMessageWithThinkingSurface(this, message, currentStore.theme, currentStore.surface);
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

export function uninstallThinkingSurface(): void {
	const store = getThinkingSurfacePatchStore();
	store.active = false;
	store.theme = undefined;
	restorePrototypePatches(store.targets);
	store.installed = false;
}

// -----------------------------------------------------------------------------
// User message surface patch
// -----------------------------------------------------------------------------

type UserMessageWithInternals = UserMessageComponent & {
	contentBox?: { children?: Component[] };
};

type UserMessageConstructor = {
	prototype: UserMessageWithInternals & { render(width: number): string[] };
};

type UserMessageSurfacePatchStore = {
	active: boolean;
	installed: boolean;
	targets: PrototypePatchTarget[];
	surface: EditorSurfaceRenderer;
	theme?: Theme;
	timestampsByText: Map<string, number[]>;
	timestampCursorByText: Map<string, number>;
	assignedTimestamps: WeakMap<object, number>;
	fallbackTimestamps: WeakMap<object, number>;
};

const USER_MESSAGE_SURFACE_PATCH_KEY = Symbol.for("pi-rail-ui.user-message-surface-patch");

function getUserMessageSurfacePatchStore(): UserMessageSurfacePatchStore {
	const globalStore = globalThis as typeof globalThis & { [USER_MESSAGE_SURFACE_PATCH_KEY]?: UserMessageSurfacePatchStore };
	const store = (globalStore[USER_MESSAGE_SURFACE_PATCH_KEY] ??= {
		active: false,
		installed: false,
		targets: [],
		surface: tallGrayUserMessageSurface,
		timestampsByText: new Map<string, number[]>(),
		timestampCursorByText: new Map<string, number>(),
		assignedTimestamps: new WeakMap<object, number>(),
		fallbackTimestamps: new WeakMap<object, number>(),
	});
	store.targets ??= [];
	store.surface ??= tallGrayUserMessageSurface;
	store.timestampsByText ??= new Map<string, number[]>();
	store.timestampCursorByText ??= new Map<string, number>();
	store.assignedTimestamps ??= new WeakMap<object, number>();
	store.fallbackTimestamps ??= new WeakMap<object, number>();
	return store;
}

function textFromUserMessage(message: any): string | undefined {
	if (message?.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;

	let text = "";
	for (const part of content) {
		if (part?.type !== "text" || typeof part.text !== "string") continue;
		text += text ? `\n${part.text}` : part.text;
	}
	return text || undefined;
}

function timestampFromMessageOrEntry(message: any, entry?: any): number | undefined {
	const raw = message?.timestamp ?? entry?.timestamp;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = new Date(raw).getTime();
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function rememberTimestamp(text: string, timestamp: number): void {
	const store = getUserMessageSurfacePatchStore();
	const timestamps = store.timestampsByText.get(text) ?? [];
	if (timestamps[timestamps.length - 1] !== timestamp) timestamps.push(timestamp);
	store.timestampsByText.set(text, timestamps);
}

export function rememberUserMessageTimestamp(message: any, entry?: any): void {
	const text = textFromUserMessage(message);
	const timestamp = timestampFromMessageOrEntry(message, entry);
	if (!text || timestamp === undefined) return;
	rememberTimestamp(text, timestamp);
}

export function refreshUserMessageTimestamps(ctx: ExtensionContext): void {
	const store = getUserMessageSurfacePatchStore();
	store.timestampsByText.clear();
	store.timestampCursorByText.clear();
	store.assignedTimestamps = new WeakMap<object, number>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		rememberUserMessageTimestamp((entry as any).message, entry);
	}
}

function getMarkdownSourceText(component: Component | undefined): string | undefined {
	const text = (component as any)?.text;
	return typeof text === "string" ? text : undefined;
}

const userMessageTimeFormatter = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
	hour12: true,
});
const userMessageDateFormatter = new Intl.DateTimeFormat("en-US", {
	month: "numeric",
	day: "numeric",
	year: "numeric",
});

function formatUserMessageTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	return `${userMessageTimeFormatter.format(date)} · ${userMessageDateFormatter.format(date)}`;
}

function timestampForUserMessage(component: object, sourceText: string | undefined): number {
	const store = getUserMessageSurfacePatchStore();
	const assigned = store.assignedTimestamps.get(component);
	if (assigned !== undefined) return assigned;

	const timestamps = sourceText ? store.timestampsByText.get(sourceText) : undefined;
	if (sourceText && timestamps?.length) {
		const cursor = store.timestampCursorByText.get(sourceText) ?? 0;
		const timestamp = timestamps[Math.min(cursor, timestamps.length - 1)]!;
		store.timestampCursorByText.set(sourceText, cursor + 1);
		store.assignedTimestamps.set(component, timestamp);
		return timestamp;
	}

	let fallback = store.fallbackTimestamps.get(component);
	if (fallback === undefined) {
		fallback = Date.now();
		store.fallbackTimestamps.set(component, fallback);
	}
	return fallback;
}

async function getUserMessageConstructors(): Promise<UserMessageConstructor[]> {
	const ctors: UserMessageConstructor[] = [UserMessageComponent as unknown as UserMessageConstructor];
	const nativeCtor = await resolveNativePiExport<UserMessageConstructor>(
		"./modes/interactive/components/user-message.js",
		"UserMessageComponent",
	);
	if (nativeCtor && !ctors.includes(nativeCtor)) ctors.push(nativeCtor);
	return ctors;
}

function renderUserMessageWithSurface(
	component: UserMessageWithInternals,
	width: number,
	surface: EditorSurfaceRenderer,
	theme: Theme | undefined,
	fallback: (this: UserMessageWithInternals, width: number) => string[],
): string[] {
	if (width < surface.minRenderableWidth()) return fallback.call(component, width);

	const markdown = component.contentBox?.children?.[0];
	if (!markdown) return fallback.call(component, width);

	const contentWidth = surface.contentWidth(width);
	const textGapWidth = USER_MESSAGE_LAYOUT.textGapWidth;
	const markdownWidth = Math.max(1, contentWidth - textGapWidth);
	const textGap = " ".repeat(textGapWidth);
	const sourceText = getMarkdownSourceText(markdown);
	const timestamp = timestampForUserMessage(component, sourceText);
	const signature = [width, contentWidth, markdownWidth, textGapWidth, timestamp, sourceText ?? ""].join("\u001f");
	const cache = (component as any)[USER_MESSAGE_RENDER_CACHE_KEY] as { signature: string; markdown: Component; rows: string[] } | undefined;
	if (cache?.signature === signature && cache.markdown === markdown) return cache.rows;

	const timeText = formatUserMessageTimestamp(timestamp);
	const timeLine = applyTextColor(theme, USER_MESSAGE_LAYOUT.timestampColor, timeText);

	const rows: string[] = [];
	for (let i = 0; i < USER_MESSAGE_LAYOUT.verticalPaddingRows; i++) rows.push(surface.renderSurfaceRow(width));
	for (const line of markdown.render(markdownWidth)) {
		rows.push(surface.renderSurfaceRow(width, textGap + padToWidth(line, markdownWidth)));
	}
	rows.push(surface.renderSurfaceRow(width, textGap + padToWidth(timeLine, markdownWidth)));
	for (let i = 0; i < USER_MESSAGE_LAYOUT.verticalPaddingRows; i++) rows.push(surface.renderSurfaceRow(width));

	if (rows.length === 0) return rows;
	rows[0] = OSC133_ZONE_START + rows[0];
	rows[rows.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + rows[rows.length - 1];
	(component as any)[USER_MESSAGE_RENDER_CACHE_KEY] = { signature, markdown, rows };
	return rows;
}

export async function installUserMessageSurface(ctx: ExtensionContext): Promise<void> {
	const store = getUserMessageSurfacePatchStore();
	store.surface = tallGrayUserMessageSurface;
	store.theme = ctx.ui.theme;
	refreshUserMessageTimestamps(ctx);
	store.active = true;

	for (const ctor of await getUserMessageConstructors()) {
		if (store.targets.some((target) => target.ctor === ctor)) continue;

		const original = ctor.prototype.render;
		ctor.prototype.render = function patchedUserMessageRender(this: UserMessageWithInternals, width: number) {
			const currentStore = getUserMessageSurfacePatchStore();
			if (!currentStore.active) return original.call(this, width);
			try {
				return renderUserMessageWithSurface(this, width, currentStore.surface, currentStore.theme, original);
			} catch {
				return original.call(this, width);
			}
		};
		store.targets.push({ ctor, methodName: "render", original });
	}

	store.installed = store.targets.length > 0;
}

export function uninstallUserMessageSurface(): void {
	const store = getUserMessageSurfacePatchStore();
	store.active = false;
	store.theme = undefined;
	store.timestampsByText.clear();
	store.timestampCursorByText.clear();
	store.assignedTimestamps = new WeakMap<object, number>();
	store.fallbackTimestamps = new WeakMap<object, number>();
	restorePrototypePatches(store.targets, "render");
	store.installed = false;
}
