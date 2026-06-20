import { UserMessageComponent, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { USER_MESSAGE_LAYOUT, applyTextColor } from "../../config";
import { createStore, resolveNativePiExport, restorePrototypePatches, type PrototypePatchTarget } from "../../core/patching";
import { cachedRender } from "../../rail/render-cache";
import { EditorSurfaceRenderer, railUserMessageSurface } from "../../rail/rail-surface";
import { OSC133_ZONE_END, OSC133_ZONE_FINAL, OSC133_ZONE_START, padToWidth } from "../../core/utils";

type UserMessageWithInternals = {
	contentBox?: { children?: Component[] };
};

type UserMessageConstructor = {
	prototype: UserMessageWithInternals & { render(width: number): string[] };
};

type UserMessageRailPatchStore = {
	active: boolean;
	installed: boolean;
	targets: PrototypePatchTarget[];
	surface: EditorSurfaceRenderer;
	theme?: Theme | undefined;
	timestampsByText: Map<string, number[]>;
	timestampCursorByText: Map<string, number>;
	assignedTimestamps: WeakMap<object, number>;
	fallbackTimestamps: WeakMap<object, number>;
};

const USER_MESSAGE_RENDER_CACHE_KEY = Symbol.for("pi-rail-ui.user-message-render-cache");

const getUserMessageRailPatchStore = createStore<UserMessageRailPatchStore>("user-message-rail-patch", () => ({
	active: false,
	installed: false,
	targets: [],
	surface: railUserMessageSurface,
	timestampsByText: new Map<string, number[]>(),
	timestampCursorByText: new Map<string, number>(),
	assignedTimestamps: new WeakMap<object, number>(),
	fallbackTimestamps: new WeakMap<object, number>(),
}));

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
	const store = getUserMessageRailPatchStore();
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
	const store = getUserMessageRailPatchStore();
	store.timestampsByText.clear();
	store.timestampCursorByText.clear();
	store.assignedTimestamps = new WeakMap<object, number>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		rememberUserMessageTimestamp((entry as any).message, entry);
	}
	if (store.timestampsByText.size > 200) {
		const entries = [...store.timestampsByText.entries()];
		store.timestampsByText = new Map(entries.slice(entries.length - 200));
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
	const store = getUserMessageRailPatchStore();
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
	return cachedRender(component, USER_MESSAGE_RENDER_CACHE_KEY, signature, () => {
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
		return rows;
	}, { markdown });
}

export async function installUserMessageRail(ctx: ExtensionContext): Promise<void> {
	const store = getUserMessageRailPatchStore();
	store.surface = railUserMessageSurface;
	store.theme = ctx.ui.theme;
	refreshUserMessageTimestamps(ctx);
	store.active = true;

	for (const ctor of await getUserMessageConstructors()) {
		if (store.targets.some((target) => target.ctor === ctor)) continue;

		const original = ctor.prototype.render;
		ctor.prototype.render = function patchedUserMessageRender(this: UserMessageWithInternals, width: number) {
			const currentStore = getUserMessageRailPatchStore();
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

export function uninstallUserMessageRail(): void {
	const store = getUserMessageRailPatchStore();
	store.active = false;
	store.theme = undefined;
	store.timestampsByText.clear();
	store.timestampCursorByText.clear();
	store.assignedTimestamps = new WeakMap<object, number>();
	store.fallbackTimestamps = new WeakMap<object, number>();
	restorePrototypePatches(store.targets, "render");
	store.installed = false;
}
