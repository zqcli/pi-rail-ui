import {
	InteractiveMode,
	ModelSelectorComponent,
	SettingsSelectorComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { SLASH_COMMAND_LAYOUT, TALL_GRAY_EDITOR_HEIGHT, applyTextColor, type ThemeLike } from "../config";
import { createStore, resolveNativePiExport, restorePrototypePatches, type PrototypePatchTarget } from "../patching";
import { RailOverlayPanel, renderRailOverlayRows, type RailOverlayBodyRenderer } from "../ui/rail-overlay";
import { selectorOutputSurfaceForTheme, tallGraySelectorOutputSurface, type EditorSurfaceRenderer } from "../ui/rail-surface";

type SelectorCtor = { prototype: any };
type InteractiveModeCtor = { prototype: any };
type SelectorFactory = (done: () => void) => { component: Component; focus: any };
type SettingsMenuPatchStore = {
	targets: PrototypePatchTarget[];
	handles: Set<OverlayHandle>;
	theme?: ThemeLike;
	surface: EditorSurfaceRenderer;
};

const SELECTOR_SURFACE_CACHE_KEY = Symbol.for("pi-rail-ui.selector-surface-cache");

const getSettingsMenuPatchStore = createStore<SettingsMenuPatchStore>("settings-menu-patch", () => ({
	targets: [],
	handles: new Set<OverlayHandle>(),
	surface: tallGraySelectorOutputSurface,
}));

function themeFg(theme: ThemeLike | undefined, name: string, text: string): string {
	return theme ? theme.fg(name, text) : text;
}

function themeBold(theme: ThemeLike | undefined, text: string): string {
	return (theme as any)?.bold ? (theme as any).bold(text) : text;
}

function selectedText(theme: ThemeLike | undefined, text: string): string {
	return applyTextColor(theme, SLASH_COMMAND_LAYOUT.selectedText, text);
}

function mutedText(theme: ThemeLike | undefined, text: string): string {
	return themeFg(theme, "muted", text);
}

function restyleSelectList(selectList: any, theme: ThemeLike | undefined): void {
	if (!selectList) return;
	selectList.layout = {
		...(selectList.layout ?? {}),
		minPrimaryColumnWidth: SLASH_COMMAND_LAYOUT.minPrimaryColumnWidth,
		maxPrimaryColumnWidth: SLASH_COMMAND_LAYOUT.maxPrimaryColumnWidth,
	};
	selectList.theme = {
		...(selectList.theme ?? {}),
		selectedText: (text: string) => selectedText(theme, text),
	};
}

function restyleSettingsList(settingsList: any, theme: ThemeLike | undefined): void {
	if (!settingsList) return;
	settingsList.theme = {
		...(settingsList.theme ?? {}),
		label: (text: string, selected: boolean) => (selected ? selectedText(theme, text) : text),
		value: (text: string, selected: boolean) => (selected ? selectedText(theme, text) : mutedText(theme, text)),
		cursor: selectedText(theme, "→ "),
	};
	if (settingsList.submenuComponent) restyleSettingsSubmenu(settingsList.submenuComponent, theme);
}

function restyleSettingsSubmenu(submenu: any, theme: ThemeLike | undefined): void {
	restyleSelectList(submenu?.selectList, theme);
	restyleSettingsList(submenu?.settingsList, theme);
	for (const child of submenu?.children ?? []) {
		restyleSelectList((child as any)?.selectList, theme);
		restyleSettingsList((child as any)?.settingsList, theme);
	}
}

function renderSearchInput(instance: any, width: number): string[] {
	const rows = instance.searchInput?.render?.(Math.max(1, width));
	return Array.isArray(rows) ? rows : [];
}

function sameModel(a: any, b: any): boolean {
	return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

function renderModelScopeText(instance: any, theme: ThemeLike | undefined): string {
	const allText = instance.scope === "all" ? selectedText(theme, "all") : mutedText(theme, "all");
	const scopedText = instance.scope === "scoped" ? selectedText(theme, "scoped") : mutedText(theme, "scoped");
	return `${mutedText(theme, "Scope: ")}${allText}${mutedText(theme, " | ")}${scopedText}`;
}

function visibleModelRows(instance: any, theme: ThemeLike | undefined): string[] {
	const rows: string[] = [];
	const models = Array.isArray(instance.filteredModels) ? instance.filteredModels : [];
	const selectedIndex = Math.max(0, Math.min(instance.selectedIndex ?? 0, Math.max(0, models.length - 1)));
	const maxVisible = 10;
	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), models.length - maxVisible));
	const endIndex = Math.min(startIndex + maxVisible, models.length);

	for (let i = startIndex; i < endIndex; i++) {
		const item = models[i];
		if (!item) continue;
		const isSelected = i === selectedIndex;
		const isCurrent = sameModel(instance.currentModel, item.model);
		const prefix = isSelected ? selectedText(theme, "→ ") : "  ";
		const modelText = isSelected ? selectedText(theme, String(item.id ?? item.model?.id ?? "")) : String(item.id ?? item.model?.id ?? "");
		const providerBadge = mutedText(theme, ` [${item.provider ?? item.model?.provider ?? ""}]`);
		const checkmark = isCurrent ? themeFg(theme, "success", " ✓") : "";
		rows.push(`${prefix}${modelText}${providerBadge}${checkmark}`);
	}

	if (startIndex > 0 || endIndex < models.length) rows.push(mutedText(theme, `  (${selectedIndex + 1}/${models.length})`));

	if (instance.errorMessage) {
		for (const line of String(instance.errorMessage).split("\n")) rows.push(themeFg(theme, "error", line));
	} else if (models.length === 0) {
		rows.push(mutedText(theme, "  No matching models"));
	} else {
		const selected = models[selectedIndex];
		rows.push("");
		rows.push(mutedText(theme, `  Model Name: ${selected?.model?.name ?? selected?.id ?? ""}`));
	}

	return rows;
}

function renderModelSelectorBody(instance: any, contentWidth: number, store: SettingsMenuPatchStore): string[] {
	const hasScopedModels = (instance.scopedModels?.length ?? 0) > 0 || (instance.scopedModelItems?.length ?? 0) > 0;
	const rows: string[] = [];
	if (hasScopedModels) {
		rows.push(renderModelScopeText(instance, store.theme));
		rows.push(instance.getScopeHintText?.() ?? "");
	} else {
		rows.push(themeFg(store.theme, "warning", "Only showing models from configured providers. Use /login to add providers."));
	}
	rows.push("");
	rows.push(...renderSearchInput(instance, contentWidth));
	rows.push("");
	rows.push(...visibleModelRows(instance, store.theme));
	return rows;
}

function cachedSelectorRows(instance: any, signature: string, renderRows: () => string[]): string[] {
	const cache = instance[SELECTOR_SURFACE_CACHE_KEY] as { signature: string; rows: string[] } | undefined;
	if (cache?.signature === signature) return cache.rows;
	const rows = renderRows();
	instance[SELECTOR_SURFACE_CACHE_KEY] = { signature, rows };
	return rows;
}

function renderModelSelectorSurface(
	instance: any,
	width: number,
	originalRender: (width: number) => string[],
	store: SettingsMenuPatchStore,
): string[] {
	try {
		if (width < store.surface.minRenderableWidth()) return originalRender.call(instance, width);
		const signature = ["model", width, instance.selectedIndex ?? 0, instance.scope ?? "", instance.searchInput?.getText?.() ?? "", instance.filteredModels?.length ?? 0, instance.errorMessage ?? ""].join("\u001f");
		return cachedSelectorRows(instance, signature, () => renderRailOverlayRows(width, (contentWidth) => renderModelSelectorBody(instance, contentWidth, store), {
			surface: store.surface,
			textGapWidth: SLASH_COMMAND_LAYOUT.textGapWidth,
		}));
	} catch {
		return originalRender.call(instance, width);
	}
}

function visibleScopedModelRows(instance: any, theme: ThemeLike | undefined): string[] {
	const rows: string[] = [];
	const items = Array.isArray(instance.filteredItems) ? instance.filteredItems : [];
	const selectedIndex = Math.max(0, Math.min(instance.selectedIndex ?? 0, Math.max(0, items.length - 1)));
	const maxVisible = Math.max(1, instance.maxVisible ?? 8);
	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
	const endIndex = Math.min(startIndex + maxVisible, items.length);
	const allEnabled = instance.enabledIds === null;

	if (items.length === 0) {
		rows.push(mutedText(theme, "  No matching models"));
		return rows;
	}

	for (let i = startIndex; i < endIndex; i++) {
		const item = items[i];
		if (!item) continue;
		const isSelected = i === selectedIndex;
		const prefix = isSelected ? selectedText(theme, "→ ") : "  ";
		const modelText = isSelected ? selectedText(theme, item.model?.id ?? "") : item.model?.id ?? "";
		const providerBadge = mutedText(theme, ` [${item.model?.provider ?? ""}]`);
		const status = allEnabled ? "" : item.enabled ? themeFg(theme, "success", " ✓") : themeFg(theme, "dim", " ✗");
		rows.push(`${prefix}${modelText}${providerBadge}${status}`);
	}

	if (startIndex > 0 || endIndex < items.length) rows.push(mutedText(theme, `  (${selectedIndex + 1}/${items.length})`));

	const selected = items[selectedIndex];
	rows.push("");
	rows.push(mutedText(theme, `  Model Name: ${selected?.model?.name ?? selected?.model?.id ?? ""}`));
	return rows;
}

function renderScopedModelsSelectorBody(instance: any, contentWidth: number, store: SettingsMenuPatchStore): string[] {
	const footerText = instance.getFooterText?.() ?? "";
	return [
		selectedText(store.theme, themeBold(store.theme, "Model Configuration")),
		mutedText(store.theme, "Session-only. Save to settings when you want to persist changes."),
		"",
		...renderSearchInput(instance, contentWidth),
		"",
		...visibleScopedModelRows(instance, store.theme),
		"",
		footerText,
	];
}

function renderScopedModelsSelectorSurface(
	instance: any,
	width: number,
	originalRender: (width: number) => string[],
	store: SettingsMenuPatchStore,
): string[] {
	try {
		if (width < store.surface.minRenderableWidth()) return originalRender.call(instance, width);
		const signature = ["scoped", width, instance.selectedIndex ?? 0, instance.searchInput?.getText?.() ?? "", instance.filteredItems?.length ?? 0, instance.enabledIds instanceof Set ? instance.enabledIds.size : instance.enabledIds === null ? "all" : ""].join("\u001f");
		return cachedSelectorRows(instance, signature, () => renderRailOverlayRows(width, (contentWidth) => renderScopedModelsSelectorBody(instance, contentWidth, store), {
			surface: store.surface,
			textGapWidth: SLASH_COMMAND_LAYOUT.textGapWidth,
		}));
	} catch {
		return originalRender.call(instance, width);
	}
}

function settingsListFor(instance: any): any {
	return instance.getSettingsList?.() ?? instance.settingsList;
}

function renderSettingsMenuBody(instance: any, _contentWidth: number, store: SettingsMenuPatchStore): string[] {
	const settingsList = settingsListFor(instance);
	if (!settingsList) return [];
	restyleSettingsList(settingsList, store.theme);
	return settingsList.render(_contentWidth);
}

function renderSettingsMenuSurface(instance: any, width: number, originalRender: (width: number) => string[], store: SettingsMenuPatchStore): string[] {
	try {
		const settingsList = settingsListFor(instance);
		if (!settingsList || width < store.surface.minRenderableWidth()) return originalRender.call(instance, width);
		const values = Array.isArray(settingsList.items)
			? settingsList.items.map((item: any) => `${item?.id ?? item?.label ?? ""}:${item?.currentValue ?? ""}`).join("\u001e")
			: "";
		const signature = ["settings", width, settingsList.selectedIndex ?? 0, settingsList.items?.length ?? 0, settingsList.submenuComponent ? 1 : 0, settingsList.searchInput?.getValue?.() ?? "", values].join("\u001f");
		return cachedSelectorRows(instance, signature, () => renderRailOverlayRows(width, (contentWidth) => renderSettingsMenuBody(instance, contentWidth, store), {
			surface: store.surface,
			textGapWidth: SLASH_COMMAND_LAYOUT.textGapWidth,
		}));
	} catch {
		return originalRender.call(instance, width);
	}
}

function isSettingsSelectorComponent(component: any): boolean {
	try {
		const settingsList = component?.getSettingsList?.();
		return Boolean(settingsList && typeof settingsList.render === "function" && Array.isArray(settingsList.items));
	} catch {
		return false;
	}
}

function isModelSelectorComponent(component: any): boolean {
	return Boolean(component?.searchInput && Array.isArray(component?.filteredModels) && typeof component?.filterModels === "function");
}

function isScopedModelsSelectorComponent(component: any): boolean {
	return Boolean(component?.searchInput && Array.isArray(component?.filteredItems) && component?.modelsById instanceof Map);
}

function selectorBodyRenderer(component: any, store: SettingsMenuPatchStore): RailOverlayBodyRenderer | undefined {
	if (isSettingsSelectorComponent(component)) return (contentWidth) => renderSettingsMenuBody(component, contentWidth, store);
	if (isModelSelectorComponent(component)) return (contentWidth) => renderModelSelectorBody(component, contentWidth, store);
	if (isScopedModelsSelectorComponent(component)) return (contentWidth) => renderScopedModelsSelectorBody(component, contentWidth, store);
	return undefined;
}

function renderedEditorRows(instance: any, width: number): number {
	try {
		const rows = instance.editor?.render?.(width);
		if (Array.isArray(rows) && rows.length > 0) return rows.length;
	} catch {
		// Fall back to the configured default height when the editor cannot be rendered here.
	}
	return TALL_GRAY_EDITOR_HEIGHT.minHeight;
}

function ensureEditorInContainer(instance: any): void {
	const container = instance.editorContainer;
	if (!container || !instance.editor) return;
	if (Array.isArray(container.children) && container.children.includes(instance.editor)) return;
	container.clear?.();
	container.addChild?.(instance.editor);
}

function showSettingsOverlay(instance: any, create: SelectorFactory, store: SettingsMenuPatchStore): void {
	let handle: OverlayHandle | undefined;
	const done = () => {
		handle?.hide();
		if (handle) store.handles.delete(handle);
		handle = undefined;
		ensureEditorInContainer(instance);
		instance.ui?.setFocus?.(instance.editor);
		instance.ui?.requestRender?.();
	};

	const { component, focus } = create(done);
	const renderBody = selectorBodyRenderer(component, store);
	if (!renderBody) {
		instance.editorContainer?.clear?.();
		instance.editorContainer?.addChild?.(component);
		instance.ui?.setFocus?.(focus);
		instance.ui?.requestRender?.();
		return;
	}

	ensureEditorInContainer(instance);
	instance.editor?.hideSlashOverlay?.();
	const terminal = instance.ui?.terminal;
	const width = Math.max(1, terminal?.columns ?? 80);
	const bottomMargin = renderedEditorRows(instance, width) + SLASH_COMMAND_LAYOUT.bottomReservedRows;
	const panel = new RailOverlayPanel({
		renderBody,
		focusTarget: focus,
		invalidateTarget: component,
		maxRows: () => Math.max(1, (terminal?.rows ?? 24) - bottomMargin),
		surface: store.surface,
		textGapWidth: SLASH_COMMAND_LAYOUT.textGapWidth,
	});
	handle = instance.ui.showOverlay(panel, {
		width: "100%",
		anchor: "bottom-left",
		margin: { bottom: bottomMargin },
	});
	store.handles.add(handle);
}

function patchRender(
	ctor: SelectorCtor | undefined,
	store: SettingsMenuPatchStore,
	render: (instance: any, width: number, originalRender: (width: number) => string[], store: SettingsMenuPatchStore) => string[],
): void {
	if (!ctor?.prototype || store.targets.some((target) => target.ctor === ctor && target.methodName === "render")) return;

	const original = ctor.prototype.render;
	ctor.prototype.render = function patchedSelectorRender(this: any, width: number): string[] {
		return render(this, width, original, store);
	};
	store.targets.push({ ctor, methodName: "render", original });
}

function patchInteractiveMode(ctor: InteractiveModeCtor | undefined, store: SettingsMenuPatchStore): void {
	if (!ctor?.prototype || store.targets.some((target) => target.ctor === ctor && target.methodName === "showSelector")) return;

	const original = ctor.prototype.showSelector;
	ctor.prototype.showSelector = function patchedShowSelector(create: SelectorFactory): void {
		try {
			showSettingsOverlay(this, create, store);
		} catch {
			return original.call(this, create);
		}
	};
	store.targets.push({ ctor, methodName: "showSelector", original });
}

export async function installSettingsMenuSurface(theme: Theme): Promise<void> {
	const store = getSettingsMenuPatchStore();
	store.theme = theme;
	store.surface = selectorOutputSurfaceForTheme(theme);

	patchRender(SettingsSelectorComponent as unknown as SelectorCtor, store, renderSettingsMenuSurface);
	const nativeSettingsSelector = await resolveNativePiExport<SelectorCtor>(
		"./modes/interactive/components/settings-selector.js",
		"SettingsSelectorComponent",
	);
	patchRender(nativeSettingsSelector, store, renderSettingsMenuSurface);

	patchRender(ModelSelectorComponent as unknown as SelectorCtor, store, renderModelSelectorSurface);
	const nativeModelSelector = await resolveNativePiExport<SelectorCtor>("./modes/interactive/components/model-selector.js", "ModelSelectorComponent");
	patchRender(nativeModelSelector, store, renderModelSelectorSurface);

	const nativeScopedModelsSelector = await resolveNativePiExport<SelectorCtor>(
		"./modes/interactive/components/scoped-models-selector.js",
		"ScopedModelsSelectorComponent",
	);
	patchRender(nativeScopedModelsSelector, store, renderScopedModelsSelectorSurface);

	patchInteractiveMode(InteractiveMode as unknown as InteractiveModeCtor, store);
	const nativeInteractiveMode = await resolveNativePiExport<InteractiveModeCtor>(
		"./modes/interactive/interactive-mode.js",
		"InteractiveMode",
	);
	patchInteractiveMode(nativeInteractiveMode, store);
}

export function uninstallSettingsMenuSurface(): void {
	const store = getSettingsMenuPatchStore();
	for (const handle of store.handles) handle.hide();
	store.handles.clear();
	restorePrototypePatches(store.targets);
	store.theme = undefined;
	store.surface = tallGraySelectorOutputSurface;
}
