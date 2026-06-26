import {
	InteractiveMode,
	ModelSelectorComponent,
	SettingsSelectorComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { createPatchLifecycle, resolveNativePiExport } from "../../core/patching";
import { selectorOutputSurfaceForTheme, railSelectorOutputSurface, type EditorSurfaceRenderer } from "../../rail/rail-surface";
import {
	renderSelectorSurface,
	showSelectorOverlay,
	type SelectorFactory,
	type SelectorOverlayRenderStore,
} from "./selector-overlay-renderer";

type SelectorCtor = { prototype: any };
type InteractiveModeCtor = { prototype: any };
type SelectorOverlayPatchStore = SelectorOverlayRenderStore & {
	handles: Set<OverlayHandle>;
	surface: EditorSurfaceRenderer;
};

const selectorOverlayLifecycle = createPatchLifecycle<SelectorOverlayPatchStore>("selector-overlay-patch", () => ({
	handles: new Set<OverlayHandle>(),
	surface: railSelectorOutputSurface,
}));
const getSelectorOverlayPatchStore = () => selectorOverlayLifecycle.state();

function patchRender(
	ctor: SelectorCtor | undefined,
	store: SelectorOverlayPatchStore,
	render: (instance: any, width: number, originalRender: (width: number) => string[], store: SelectorOverlayPatchStore) => string[],
): void {
	selectorOverlayLifecycle.patchMethod(ctor, "render", (original) => function patchedSelectorRender(this: any, width: number): string[] {
		return render(this, width, original, store);
	});
}

function patchInteractiveMode(ctor: InteractiveModeCtor | undefined, store: SelectorOverlayPatchStore): void {
	selectorOverlayLifecycle.patchMethod(ctor, "showSelector", (original) => function patchedShowSelector(this: any, create: SelectorFactory): void {
		try {
			showSelectorOverlay(this, create, store);
		} catch {
			return original.call(this, create);
		}
	});
}

export async function installSelectorOverlay(theme: Theme): Promise<void> {
	const store = selectorOverlayLifecycle.activate((currentStore) => {
		currentStore.theme = theme;
		currentStore.surface = selectorOutputSurfaceForTheme(theme);
	});

	patchRender(SettingsSelectorComponent as unknown as SelectorCtor, store, renderSelectorSurface);
	const nativeSettingsSelector = await resolveNativePiExport<SelectorCtor>(
		"./modes/interactive/components/settings-selector.js",
		"SettingsSelectorComponent",
	);
	patchRender(nativeSettingsSelector, store, renderSelectorSurface);

	patchRender(ModelSelectorComponent as unknown as SelectorCtor, store, renderSelectorSurface);
	const nativeModelSelector = await resolveNativePiExport<SelectorCtor>("./modes/interactive/components/model-selector.js", "ModelSelectorComponent");
	patchRender(nativeModelSelector, store, renderSelectorSurface);

	const nativeScopedModelsSelector = await resolveNativePiExport<SelectorCtor>(
		"./modes/interactive/components/scoped-models-selector.js",
		"ScopedModelsSelectorComponent",
	);
	patchRender(nativeScopedModelsSelector, store, renderSelectorSurface);

	patchInteractiveMode(InteractiveMode as unknown as InteractiveModeCtor, store);
	const nativeInteractiveMode = await resolveNativePiExport<InteractiveModeCtor>(
		"./modes/interactive/interactive-mode.js",
		"InteractiveMode",
	);
	patchInteractiveMode(nativeInteractiveMode, store);
}

export function uninstallSelectorOverlay(): void {
	const store = getSelectorOverlayPatchStore();
	store.active = false;
	for (const handle of store.handles) handle.hide();
	store.handles.clear();
	selectorOverlayLifecycle.restore();
	store.theme = undefined;
	store.surface = railSelectorOutputSurface;
}
