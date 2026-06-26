import { UserMessageComponent, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { USER_MESSAGE_LAYOUT, applyTextColor } from "../../config";
import { createPatchLifecycle, resolveNativePiExport } from "../../core/patching";
import { cachedRender } from "../../rail/render-cache";
import { EditorSurfaceRenderer, railUserMessageSurface } from "../../rail/rail-surface";
import { OSC133_ZONE_END, OSC133_ZONE_FINAL, OSC133_ZONE_START, padToWidth } from "../../core/utils";
import { UserMessageTimestampRegistry, formatUserMessageTimestamp } from "./user-message-timestamps";

type UserMessageWithInternals = {
	contentBox?: { children?: Component[] };
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

function timestampForUserMessage(component: object, sourceText: string | undefined): number {
	return getUserMessageRailPatchStore().timestamps.timestampFor(component, sourceText);
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
	userMessageLifecycle.activate((store) => {
		store.surface = railUserMessageSurface;
		store.theme = ctx.ui.theme;
	});
	refreshUserMessageTimestamps(ctx);

	for (const ctor of await getUserMessageConstructors()) {
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

}

export function uninstallUserMessageRail(): void {
	userMessageLifecycle.deactivate((store) => {
		store.theme = undefined;
		store.timestamps.clear();
	});
}
