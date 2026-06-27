import { SLASH_COMMAND_LAYOUT, applyTextColor, type ThemeLike } from "../../config";

type SelectorSearchSnapshot = {
	text: string;
	render(width: number): string[];
};

type SelectorModelRow = {
	id: string;
	provider: string;
	name: string;
	current: boolean;
};

export type ModelSelectorSnapshot = {
	kind: "model";
	scope: string;
	hasScopedModels: boolean;
	scopeHint: string;
	search: SelectorSearchSnapshot;
	items: SelectorModelRow[];
	selectedIndex: number;
	errorMessage: string;
};

type ScopedModelRow = {
	id: string;
	provider: string;
	name: string;
	enabled: boolean;
};

export type ScopedModelsSelectorSnapshot = {
	kind: "scoped";
	search: SelectorSearchSnapshot;
	items: ScopedModelRow[];
	selectedIndex: number;
	maxVisible: number;
	allEnabled: boolean;
	footerText: string;
};

type SettingsListAdapter = {
	selectedIndex: number;
	itemCount: number;
	hasSubmenu: boolean;
	searchText: string;
	valuesSignature: string;
	render(width: number, theme: ThemeLike | undefined): string[];
};

export type SettingsSelectorSnapshot = {
	kind: "settings";
	list: SettingsListAdapter;
};

export type SelectorOverlaySnapshot =
	| ModelSelectorSnapshot
	| ScopedModelsSelectorSnapshot
	| SettingsSelectorSnapshot;

export type SelectorOverlayPresentation = {
	signature(width: number): string;
	renderBody(contentWidth: number): string[];
};

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

function safeRows(value: unknown): string[] {
	return Array.isArray(value) ? value.map((row) => String(row)) : [];
}

function searchSnapshotFor(searchInput: any): SelectorSearchSnapshot {
	return {
		text: String(searchInput?.getText?.() ?? searchInput?.getValue?.() ?? ""),
		render: (width: number) => safeRows(searchInput?.render?.(Math.max(1, width))),
	};
}

function sameModel(a: any, b: any): boolean {
	return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

function boundedIndex(index: unknown, count: number): number {
	if (count <= 0) return 0;
	const value = typeof index === "number" && Number.isFinite(index) ? index : 0;
	return Math.max(0, Math.min(Math.round(value), count - 1));
}

function modelRowsFor(instance: any): SelectorModelRow[] {
	const models = Array.isArray(instance.filteredModels) ? instance.filteredModels : [];
	return models.map((item: any) => {
		const model = item?.model;
		return {
			id: String(item?.id ?? model?.id ?? ""),
			provider: String(item?.provider ?? model?.provider ?? ""),
			name: String(model?.name ?? item?.id ?? model?.id ?? ""),
			current: sameModel(instance.currentModel, model),
		};
	});
}

function modelSnapshotFor(instance: any): ModelSelectorSnapshot | undefined {
	if (!isModelSelectorComponent(instance)) return undefined;
	const items = modelRowsFor(instance);
	return {
		kind: "model",
		scope: String(instance.scope ?? ""),
		hasScopedModels: (instance.scopedModels?.length ?? 0) > 0 || (instance.scopedModelItems?.length ?? 0) > 0,
		scopeHint: String(instance.getScopeHintText?.() ?? ""),
		search: searchSnapshotFor(instance.searchInput),
		items,
		selectedIndex: boundedIndex(instance.selectedIndex, items.length),
		errorMessage: String(instance.errorMessage ?? ""),
	};
}

function scopedModelRowsFor(instance: any): ScopedModelRow[] {
	const items = Array.isArray(instance.filteredItems) ? instance.filteredItems : [];
	return items.map((item: any) => ({
		id: String(item?.model?.id ?? ""),
		provider: String(item?.model?.provider ?? ""),
		name: String(item?.model?.name ?? item?.model?.id ?? ""),
		enabled: Boolean(item?.enabled),
	}));
}

function scopedModelsSnapshotFor(instance: any): ScopedModelsSelectorSnapshot | undefined {
	if (!isScopedModelsSelectorComponent(instance)) return undefined;
	const items = scopedModelRowsFor(instance);
	return {
		kind: "scoped",
		search: searchSnapshotFor(instance.searchInput),
		items,
		selectedIndex: boundedIndex(instance.selectedIndex, items.length),
		maxVisible: Math.max(1, Math.round(instance.maxVisible ?? 8)),
		allEnabled: instance.enabledIds === null,
		footerText: String(instance.getFooterText?.() ?? ""),
	};
}

function settingsListFor(instance: any): any {
	return instance.getSettingsList?.() ?? instance.settingsList;
}

function settingsSnapshotFor(instance: any): SettingsSelectorSnapshot | undefined {
	const settingsList = settingsListFor(instance);
	if (!isSettingsList(settingsList)) return undefined;
	const items = settingsList.items;
	return {
		kind: "settings",
		list: {
			selectedIndex: typeof settingsList.selectedIndex === "number" ? settingsList.selectedIndex : 0,
			itemCount: items.length,
			hasSubmenu: Boolean(settingsList.submenuComponent),
			searchText: String(settingsList.searchInput?.getValue?.() ?? settingsList.searchInput?.getText?.() ?? ""),
			valuesSignature: settingsListValuesSignature(items),
			render: (width: number, theme: ThemeLike | undefined) => {
				restyleSettingsList(settingsList, theme);
				return safeRows(settingsList.render(Math.max(1, width)));
			},
		},
	};
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

function renderModelScopeText(snapshot: ModelSelectorSnapshot, theme: ThemeLike | undefined): string {
	const allText = snapshot.scope === "all" ? selectedText(theme, "all") : mutedText(theme, "all");
	const scopedText = snapshot.scope === "scoped" ? selectedText(theme, "scoped") : mutedText(theme, "scoped");
	return `${mutedText(theme, "Scope: ")}${allText}${mutedText(theme, " | ")}${scopedText}`;
}

function visibleModelRows(snapshot: ModelSelectorSnapshot, theme: ThemeLike | undefined): string[] {
	const rows: string[] = [];
	const maxVisible = 10;
	const startIndex = Math.max(0, Math.min(snapshot.selectedIndex - Math.floor(maxVisible / 2), snapshot.items.length - maxVisible));
	const endIndex = Math.min(startIndex + maxVisible, snapshot.items.length);

	for (let i = startIndex; i < endIndex; i++) {
		const item = snapshot.items[i];
		if (!item) continue;
		const isSelected = i === snapshot.selectedIndex;
		const prefix = isSelected ? selectedText(theme, "→ ") : "  ";
		const modelText = isSelected ? selectedText(theme, item.id) : item.id;
		const providerBadge = mutedText(theme, ` [${item.provider}]`);
		const checkmark = item.current ? themeFg(theme, "success", " ✓") : "";
		rows.push(`${prefix}${modelText}${providerBadge}${checkmark}`);
	}

	if (startIndex > 0 || endIndex < snapshot.items.length) rows.push(mutedText(theme, `  (${snapshot.selectedIndex + 1}/${snapshot.items.length})`));

	if (snapshot.errorMessage) {
		for (const line of snapshot.errorMessage.split("\n")) rows.push(themeFg(theme, "error", line));
	} else if (snapshot.items.length === 0) {
		rows.push(mutedText(theme, "  No matching models"));
	} else {
		const selected = snapshot.items[snapshot.selectedIndex];
		rows.push("");
		rows.push(mutedText(theme, `  Model Name: ${selected?.name ?? ""}`));
	}

	return rows;
}

function renderModelSelectorBody(snapshot: ModelSelectorSnapshot, contentWidth: number, theme: ThemeLike | undefined): string[] {
	const rows: string[] = [];
	if (snapshot.hasScopedModels) {
		rows.push(renderModelScopeText(snapshot, theme));
		rows.push(snapshot.scopeHint);
	} else {
		rows.push(themeFg(theme, "warning", "Only showing models from configured providers. Use /login to add providers."));
	}
	rows.push("");
	rows.push(...snapshot.search.render(contentWidth));
	rows.push("");
	rows.push(...visibleModelRows(snapshot, theme));
	return rows;
}

function visibleScopedModelRows(snapshot: ScopedModelsSelectorSnapshot, theme: ThemeLike | undefined): string[] {
	const rows: string[] = [];
	const startIndex = Math.max(0, Math.min(snapshot.selectedIndex - Math.floor(snapshot.maxVisible / 2), snapshot.items.length - snapshot.maxVisible));
	const endIndex = Math.min(startIndex + snapshot.maxVisible, snapshot.items.length);

	if (snapshot.items.length === 0) {
		rows.push(mutedText(theme, "  No matching models"));
		return rows;
	}

	for (let i = startIndex; i < endIndex; i++) {
		const item = snapshot.items[i];
		if (!item) continue;
		const isSelected = i === snapshot.selectedIndex;
		const prefix = isSelected ? selectedText(theme, "→ ") : "  ";
		const modelText = isSelected ? selectedText(theme, item.id) : item.id;
		const providerBadge = mutedText(theme, ` [${item.provider}]`);
		const status = snapshot.allEnabled ? "" : item.enabled ? themeFg(theme, "success", " ✓") : themeFg(theme, "dim", " ✗");
		rows.push(`${prefix}${modelText}${providerBadge}${status}`);
	}

	if (startIndex > 0 || endIndex < snapshot.items.length) rows.push(mutedText(theme, `  (${snapshot.selectedIndex + 1}/${snapshot.items.length})`));

	const selected = snapshot.items[snapshot.selectedIndex];
	rows.push("");
	rows.push(mutedText(theme, `  Model Name: ${selected?.name ?? ""}`));
	return rows;
}

function renderScopedModelsSelectorBody(snapshot: ScopedModelsSelectorSnapshot, contentWidth: number, theme: ThemeLike | undefined): string[] {
	return [
		selectedText(theme, themeBold(theme, "Model Configuration")),
		mutedText(theme, "Session-only. Save to settings when you want to persist changes."),
		"",
		...snapshot.search.render(contentWidth),
		"",
		...visibleScopedModelRows(snapshot, theme),
		"",
		snapshot.footerText,
	];
}

function renderSettingsMenuBody(snapshot: SettingsSelectorSnapshot, contentWidth: number, theme: ThemeLike | undefined): string[] {
	return snapshot.list.render(contentWidth, theme);
}

export function renderSelectorOverlaySnapshot(snapshot: SelectorOverlaySnapshot, contentWidth: number, theme: ThemeLike | undefined): string[] {
	switch (snapshot.kind) {
		case "model":
			return renderModelSelectorBody(snapshot, contentWidth, theme);
		case "scoped":
			return renderScopedModelsSelectorBody(snapshot, contentWidth, theme);
		case "settings":
			return renderSettingsMenuBody(snapshot, contentWidth, theme);
	}
}

function serializeItems(items: Array<Record<string, unknown>>): string {
	return items.map((item) => Object.values(item).join(":")).join("\u001e");
}

function settingsListValuesSignature(items: any[]): string {
	return items
		.map((item: any) => `${item?.id ?? item?.label ?? ""}:${item?.currentValue ?? ""}`)
		.join("\u001e");
}

export function selectorOverlaySnapshotSignature(snapshot: SelectorOverlaySnapshot, width: number): string {
	switch (snapshot.kind) {
		case "model":
			return [
				snapshot.kind,
				width,
				snapshot.scope,
				snapshot.scopeHint,
				snapshot.search.text,
				snapshot.selectedIndex,
				snapshot.errorMessage,
				serializeItems(snapshot.items),
			].join("\u001f");
		case "scoped":
			return [
				snapshot.kind,
				width,
				snapshot.search.text,
				snapshot.selectedIndex,
				snapshot.maxVisible,
				snapshot.allEnabled ? "all" : "some",
				snapshot.footerText,
				serializeItems(snapshot.items),
			].join("\u001f");
		case "settings": {
			return [
				snapshot.kind,
				width,
				snapshot.list.selectedIndex,
				snapshot.list.itemCount,
				snapshot.list.hasSubmenu ? 1 : 0,
				snapshot.list.searchText,
				snapshot.list.valuesSignature,
			].join("\u001f");
		}
	}
}

function isSettingsList(value: any): boolean {
	return Boolean(value && typeof value.render === "function" && Array.isArray(value.items));
}

function isSettingsSelectorComponent(component: any): boolean {
	try {
		return isSettingsList(settingsListFor(component));
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

type SelectorOverlayAdapter = {
	matches(component: any): boolean;
	snapshot(component: any): SelectorOverlaySnapshot | undefined;
};

const SELECTOR_OVERLAY_ADAPTERS: SelectorOverlayAdapter[] = [
	{ matches: isSettingsSelectorComponent, snapshot: settingsSnapshotFor },
	{ matches: isModelSelectorComponent, snapshot: modelSnapshotFor },
	{ matches: isScopedModelsSelectorComponent, snapshot: scopedModelsSnapshotFor },
];

export function selectorOverlaySnapshotFor(component: any): SelectorOverlaySnapshot | undefined {
	for (const adapter of SELECTOR_OVERLAY_ADAPTERS) {
		if (adapter.matches(component)) return adapter.snapshot(component);
	}
	return undefined;
}

export function selectorOverlayPresentationFor(component: any, theme: ThemeLike | undefined): SelectorOverlayPresentation | undefined {
	const snapshot = selectorOverlaySnapshotFor(component);
	if (!snapshot) return undefined;
	return {
		signature: (width) => selectorOverlaySnapshotSignature(snapshot, width),
		renderBody: (contentWidth) => renderSelectorOverlaySnapshot(snapshot, contentWidth, theme),
	};
}
