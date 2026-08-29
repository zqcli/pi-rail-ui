import { UserMessageComponent, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { USER_MESSAGE_LAYOUT, applyTextColor } from "../../config";
import { createPatchLifecycle } from "../../core/patching";
import { cachedRender } from "../../rail/render-cache";
import { EditorSurfaceRenderer, railUserMessageSurface } from "../../rail/rail-surface";
import { OSC133_ZONE_END, OSC133_ZONE_FINAL, OSC133_ZONE_START, padToWidth } from "../../core/utils";
import { UserMessageTimestampRegistry, formatUserMessageTimestamp } from "./user-message-timestamps";

type UserMessageWithInternals = {
	children?: Component[];
};

type UserMessageConstructor = {
	prototype: UserMessageWithInternals & { render(width: number): string[] };
};

type UserMessageRailPatchStore = {
	surface: EditorSurfaceRenderer;
	theme?: Theme | undefined;
	timestamps: UserMessageTimestampRegistry;
};

const USER_MESSAGE_RENDER_CACHE_KEY = Symbol.for("pi-rail-ui.user-message-render-cache");

const userMessageLifecycle = createPatchLifecycle<UserMessageRailPatchStore>("user-message-rail-patch", () => ({
	surface: railUserMessageSurface,
	timestamps: new UserMessageTimestampRegistry(),
}));
const getUserMessageRailPatchStore = () => userMessageLifecycle.state();

export function rememberUserMessageTimestamp(message: any, entry?: any): void {
	getUserMessageRailPatchStore().timestamps.remember(message, entry);
}

export function refreshUserMessageTimestamps(ctx: ExtensionContext): void {
	getUserMessageRailPatchStore().timestamps.refresh(ctx.sessionManager.getBranch());
}

function getMarkdownSourceText(component: Component | undefined): string | undefined {
	const text = (component as any)?.text;
	return typeof text === "string" ? text : undefined;
}

function getUserMessageMarkdown(component: UserMessageWithInternals): Component | undefined {
	const container = component.children?.[0] as ({ children?: Component[] } | undefined);
	const candidate = container?.children?.[0];
	return typeof candidate?.render === "function" && getMarkdownSourceText(candidate) !== undefined
		? candidate
		: undefined;
}

function timestampForUserMessage(component: object, sourceText: string | undefined): number {
	return getUserMessageRailPatchStore().timestamps.timestampFor(component, sourceText);
}

function renderNativeUserRow(line: string, width: number, surface: EditorSurfaceRenderer): string {
	let zones = "";
	let content = line;
	for (const marker of [OSC133_ZONE_START, OSC133_ZONE_END, OSC133_ZONE_FINAL]) {
		if (!content.startsWith(marker)) continue;
		zones += marker;
		content = content.slice(marker.length);
	}
	return zones + surface.renderSurfaceRow(width, content);
}

function renderUserMessageWithSurface(
	component: UserMessageWithInternals,
	width: number,
	surface: EditorSurfaceRenderer,
	theme: Theme | undefined,
	fallback: (this: UserMessageWithInternals, width: number) => string[],
): string[] {
	if (width < surface.minRenderableWidth()) return fallback.call(component, width);

	const markdown = getUserMessageMarkdown(component);
	if (!markdown) return fallback.call(component, width);

	const contentWidth = surface.contentWidth(width);
	const textGapWidth = USER_MESSAGE_LAYOUT.textGapWidth;
	const sourceText = getMarkdownSourceText(markdown);
	const timestamp = timestampForUserMessage(component, sourceText);
	const signature = [width, contentWidth, textGapWidth, timestamp, sourceText ?? ""].join("\u001f");
	return cachedRender(component, USER_MESSAGE_RENDER_CACHE_KEY, signature, () => {
		// Keep Pi's complete native user-message render. This preserves its
		// outputPad, Markdown transformer chain, OSC 133 markers, and future
		// component changes; Rail only wraps the resulting rows and adds time.
		const nativeRows = fallback.call(component, contentWidth);
		const rows = nativeRows.map((line) => renderNativeUserRow(line, width, surface));
		const timeText = formatUserMessageTimestamp(timestamp);
		const timeLine = applyTextColor(theme, USER_MESSAGE_LAYOUT.timestampColor, timeText);
		const timestampWidth = Math.max(0, contentWidth - textGapWidth);
		const timestampRow = surface.renderSurfaceRow(
			width,
			" ".repeat(textGapWidth) + padToWidth(timeLine, timestampWidth),
		);
		if (rows.length === 0) return [timestampRow];
		// Native Box padding leaves a final row for the bottom padding. Put the
		// timestamp immediately before it instead of rebuilding the whole box.
		rows.splice(Math.max(0, rows.length - 1), 0, timestampRow);
		return rows;
	}, { markdown, nativeChildren: component.children });
}

export async function installUserMessageRail(ctx: ExtensionContext): Promise<void> {
	userMessageLifecycle.activate((store) => {
		store.surface = railUserMessageSurface;
		store.theme = ctx.ui.theme;
	});
	refreshUserMessageTimestamps(ctx);

	const ctor = UserMessageComponent as unknown as UserMessageConstructor;
	userMessageLifecycle.patchMethod(ctor, "render", (original) => function patchedUserMessageRender(this: UserMessageWithInternals, width: number) {
		const currentStore = getUserMessageRailPatchStore();
		if (!currentStore.active) return original.call(this, width);
		try {
			return renderUserMessageWithSurface(this, width, currentStore.surface, currentStore.theme, original);
		} catch {
			return original.call(this, width);
		}
	});

}

export function uninstallUserMessageRail(): void {
	userMessageLifecycle.deactivate((store) => {
		store.theme = undefined;
		store.timestamps.clear();
	});
}
