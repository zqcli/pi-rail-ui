import {
	AssistantMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { PrototypePatchTarget, resolveNativePiExport, restorePrototypePatches, getInteractiveModeConstructors, createStore, patchPrototypeMethod } from "../../core/patching";
import { cachedRender } from "../../rail/render-cache";
import {
	EditorSurfaceRenderer,
	thinkingSurfaceForTheme,
	railThinkingSurface,
} from "../../rail/rail-surface";
import { setCollapsibleRailSectionsExpanded } from "../../rail/rail-section";
import { ASSISTANT_RENDER_CACHE_KEY, renderAssistantMessageRail, type AssistantMessageRailHost } from "./assistant-message-rail";

// -----------------------------------------------------------------------------
// Assistant thinking/reply surface patch
// -----------------------------------------------------------------------------

type AssistantMessageWithInternals = AssistantMessageRailHost;

type AssistantMessageConstructor = {
	prototype: AssistantMessageWithInternals & { updateContent(message: any): void; render(width: number): string[] };
};

type InteractiveModeConstructor = {
	prototype: { setToolsExpanded(expanded: boolean): void };
};

type AssistantMessageRailPatchStore = {
	active: boolean;
	targets: PrototypePatchTarget[];
	theme?: Theme | undefined;
	surface: EditorSurfaceRenderer;
};

const getAssistantMessageRailPatchStore = createStore<AssistantMessageRailPatchStore>("assistant-message-rail-patch", () => ({
	active: false,
	targets: [],
	surface: railThinkingSurface,
}));

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
	patchPrototypeMethod(store.targets, ctor, "render", (original) => function patchedAssistantRender(this: AssistantMessageWithInternals, width: number): string[] {
		const currentStore = getAssistantMessageRailPatchStore();
		if (!currentStore.active) return original.call(this, width);
		const signature = [width, this.lastMessage ? 1 : 0, this.hasToolCalls ? 1 : 0, this.hideThinkingBlock ? 1 : 0, this.hiddenThinkingLabel ?? ""].join("\u001f");
		const children = Array.isArray(this.contentContainer?.children) ? this.contentContainer.children : [];
		return cachedRender(this, ASSISTANT_RENDER_CACHE_KEY, signature, () => original.call(this, width), { message: this.lastMessage, children });
	});
}

function patchGlobalRailSectionExpansion(ctor: InteractiveModeConstructor, store: AssistantMessageRailPatchStore): void {
	patchPrototypeMethod(store.targets, ctor, "setToolsExpanded", (original) => function patchedSetToolsExpanded(this: any, expanded: boolean): void {
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
	});
}

export async function installAssistantMessageRail(theme: Theme): Promise<void> {
	const store = getAssistantMessageRailPatchStore();
	store.theme = theme;
	store.surface = thinkingSurfaceForTheme(theme);
	store.active = true;

	for (const ctor of await getAssistantMessageConstructors()) {
		patchPrototypeMethod(store.targets, ctor, "updateContent", (original) => function patchedUpdateContent(this: AssistantMessageWithInternals, message: any) {
			delete (this as any)[ASSISTANT_RENDER_CACHE_KEY];
			const currentStore = getAssistantMessageRailPatchStore();
			if (!currentStore.active || !currentStore.theme) return original.call(this, message);
			try {
				return renderAssistantMessageRail(this, message, currentStore.theme, currentStore.surface);
			} catch {
				return original.call(this, message);
			}
		});
		patchAssistantRenderCache(ctor, store);
	}

	for (const ctor of await getInteractiveModeConstructors()) patchGlobalRailSectionExpansion(ctor, store);

}

export function uninstallAssistantMessageRail(): void {
	const store = getAssistantMessageRailPatchStore();
	store.active = false;
	store.theme = undefined;
	restorePrototypePatches(store.targets);
}
