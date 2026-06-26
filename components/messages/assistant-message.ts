import {
	AssistantMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { createPatchLifecycle, resolveNativePiExport, getInteractiveModeConstructors } from "../../core/patching";
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
	theme?: Theme | undefined;
	surface: EditorSurfaceRenderer;
};

const assistantMessageLifecycle = createPatchLifecycle<Omit<AssistantMessageRailPatchStore, "active">>("assistant-message-rail-patch", () => ({
	surface: railThinkingSurface,
}));
const getAssistantMessageRailPatchStore = () => assistantMessageLifecycle.state();

async function getAssistantMessageConstructors(): Promise<AssistantMessageConstructor[]> {
	const ctors: AssistantMessageConstructor[] = [AssistantMessageComponent as unknown as AssistantMessageConstructor];
	const nativeCtor = await resolveNativePiExport<AssistantMessageConstructor>(
		"./modes/interactive/components/assistant-message.js",
		"AssistantMessageComponent",
	);
	if (nativeCtor && !ctors.includes(nativeCtor)) ctors.push(nativeCtor);
	return ctors;
}

function patchAssistantRenderCache(ctor: AssistantMessageConstructor): void {
	assistantMessageLifecycle.patchMethod(ctor, "render", (original) => function patchedAssistantRender(this: AssistantMessageWithInternals, width: number): string[] {
		const currentStore = getAssistantMessageRailPatchStore();
		if (!currentStore.active) return original.call(this, width);
		const signature = [width, this.lastMessage ? 1 : 0, this.hasToolCalls ? 1 : 0, this.hideThinkingBlock ? 1 : 0, this.hiddenThinkingLabel ?? ""].join("\u001f");
		const children = Array.isArray(this.contentContainer?.children) ? this.contentContainer.children : [];
		return cachedRender(this, ASSISTANT_RENDER_CACHE_KEY, signature, () => original.call(this, width), { message: this.lastMessage, children });
	});
}

function patchGlobalRailSectionExpansion(ctor: InteractiveModeConstructor): void {
	assistantMessageLifecycle.patchMethod(ctor, "setToolsExpanded", (original) => function patchedSetToolsExpanded(this: any, expanded: boolean): void {
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
	assistantMessageLifecycle.activate((currentStore) => {
		currentStore.theme = theme;
		currentStore.surface = thinkingSurfaceForTheme(theme);
	});

	for (const ctor of await getAssistantMessageConstructors()) {
		assistantMessageLifecycle.patchMethod(ctor, "updateContent", (original) => function patchedUpdateContent(this: AssistantMessageWithInternals, message: any) {
			delete (this as any)[ASSISTANT_RENDER_CACHE_KEY];
			const currentStore = getAssistantMessageRailPatchStore();
			if (!currentStore.active || !currentStore.theme) return original.call(this, message);
			try {
				return renderAssistantMessageRail(this, message, currentStore.theme, currentStore.surface);
			} catch {
				return original.call(this, message);
			}
		});
		patchAssistantRenderCache(ctor);
	}

	for (const ctor of await getInteractiveModeConstructors()) patchGlobalRailSectionExpansion(ctor);

}

export function uninstallAssistantMessageRail(): void {
	assistantMessageLifecycle.deactivate((store) => {
		store.theme = undefined;
	});
}
