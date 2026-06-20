import type { Component } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import {
	railSectionConfig,
	RAIL_EDITOR_STYLE,
	type RailSectionKind,
	type RailSectionResolvedConfig,
	type ThemeLike,
} from "../config";
import { padToWidth, stripAnsi, type Position } from "../core/utils";

export type { RailSectionKind, RailSectionResolvedConfig } from "../config";

export type RailSectionOverrides = Partial<Omit<RailSectionResolvedConfig, "kind" | "layout" | "style" | "selection">> & {
	layout?: Partial<RailSectionResolvedConfig["layout"]>;
	style?: Partial<RailSectionResolvedConfig["style"]>;
	selection?: Partial<RailSectionResolvedConfig["selection"]>;
};

export type RailSectionMetadata = {
	kind: RailSectionKind;
	component?: any | undefined;
	overrides?: RailSectionOverrides | undefined;
};

export type RailSectionDefinition = {
	kind: RailSectionKind;
	component: any;
	config: RailSectionResolvedConfig;
};

export type RailSectionRange = {
	start: number;
	end: number;
	section: RailSectionDefinition;
};

export type RailSectionClickState = {
	section: RailSectionDefinition;
	x: number;
	y: number;
	moved: boolean;
};

const RAIL_SECTION_METADATA_KEY = Symbol.for("pi-rail-ui.rail-section-metadata");
const RAIL_SECTION_MANUAL_TOGGLE_KEY = Symbol.for("pi-rail-ui.rail-section-manual-toggle");
const RAIL_UI_ACTIVE_KEY = Symbol.for("pi-rail-ui.active");

export function setRailUiActive(active: boolean): void {
	(globalThis as any)[RAIL_UI_ACTIVE_KEY] = active;
}

export function isRailUiActive(): boolean {
	return (globalThis as any)[RAIL_UI_ACTIVE_KEY] !== false;
}

function mergeSectionConfig(kind: RailSectionKind, overrides?: RailSectionOverrides): RailSectionResolvedConfig {
	const base = railSectionConfig(kind);
	if (!overrides) return base;
	return {
		...base,
		...overrides,
		kind,
		layout: { ...base.layout, ...(overrides.layout ?? {}) },
		style: { ...base.style, ...(overrides.style ?? {}) },
		selection: { ...base.selection, ...(overrides.selection ?? {}) },
	};
}

export function defineRailSection<T extends object>(target: T, kind: RailSectionKind, overrides?: RailSectionOverrides, component?: any): T {
	(target as any)[RAIL_SECTION_METADATA_KEY] = { kind, overrides, component } satisfies RailSectionMetadata;
	return target;
}

function metadataFor(value: any): RailSectionMetadata | undefined {
	return value?.[RAIL_SECTION_METADATA_KEY] as RailSectionMetadata | undefined;
}

function builtInKindForComponent(component: any): RailSectionKind | undefined {
	const name = component?.constructor?.name;
	if (name === "BashExecutionComponent" || typeof component?.getCommand === "function") return "bashExecution";
	if (name === "ToolExecutionComponent" || typeof component?.toolCallId === "string" || typeof component?.toolName === "string") return "toolExecution";
	if (name === "UserMessageComponent") return "userMessage";
	if (name === "AssistantMessageComponent") return "assistantMessage";
	return undefined;
}

export function resolveRailSection(component: any): RailSectionDefinition | undefined {
	if (!component || typeof component !== "object") return undefined;

	const metadata = metadataFor(component);
	if (metadata) {
		return {
			kind: metadata.kind,
			component: metadata.component ?? component,
			config: mergeSectionConfig(metadata.kind, metadata.overrides),
		};
	}

	const kind = builtInKindForComponent(component);
	if (!kind) return undefined;
	return { kind, component, config: railSectionConfig(kind) };
}

export function isBlankRailSectionLine(line: string): boolean {
	return stripAnsi(line).trim().length === 0;
}

export function renderedRailSectionRange(
	start: number,
	lines: string[],
	section: RailSectionDefinition,
): RailSectionRange | undefined {
	let first = 0;
	let last = lines.length;
	if (!section.config.selection.includeLeadingBlankRows) {
		while (first < last && isBlankRailSectionLine(lines[first]!)) first++;
	}
	if (!section.config.selection.includeTrailingBlankRows) {
		while (last > first && isBlankRailSectionLine(lines[last - 1]!)) last--;
	}
	return last > first ? { start: start + first, end: start + last, section } : undefined;
}

export function sameRailSection(a: RailSectionDefinition | undefined, b: RailSectionDefinition | undefined): boolean {
	return Boolean(a && b && a.component === b.component && a.kind === b.kind);
}

export function railSectionMoved(click: RailSectionClickState, x: number, y: number): boolean {
	return click.x !== x || click.y !== y;
}

export function railSectionSelectionStartCol(section: RailSectionDefinition): number {
	const selection = section.config.selection;
	const layout = section.config.layout;
	if (selection.mode !== "contentOnly") return 0;
	if (selection.includeGap || selection.includeRail) return 0;
	return layout.contentStartCol;
}

export function normalizeRailSectionPosition(pos: Position, range: RailSectionRange | undefined): Position {
	if (!range?.section.config.selectable) return pos;
	const startCol = railSectionSelectionStartCol(range.section);
	return { line: pos.line, col: Math.max(pos.col, startCol) };
}

export function canToggleRailSection(section: RailSectionDefinition): boolean {
	return Boolean(section.config.collapsible && section.config.clickToToggle && typeof section.component?.setExpanded === "function");
}

export function markRailSectionManuallyToggled(component: any): void {
	if (component && typeof component === "object") component[RAIL_SECTION_MANUAL_TOGGLE_KEY] = true;
}

export function wasRailSectionManuallyToggled(component: any): boolean {
	return Boolean(component && typeof component === "object" && component[RAIL_SECTION_MANUAL_TOGGLE_KEY] === true);
}

export function setRailSectionExpanded(section: RailSectionDefinition, expanded: boolean): void {
	if (!canToggleRailSection(section)) return;
	const component = section.component;
	markRailSectionManuallyToggled(component);
	if (Boolean(component.expanded) !== expanded) component.setExpanded?.(expanded);
	component.invalidate?.();
}

export function toggleRailSection(section: RailSectionDefinition): void {
	if (!canToggleRailSection(section)) return;
	setRailSectionExpanded(section, !Boolean(section.component.expanded));
}

function railSectionChildren(component: any): any[] {
	const unwrapped = typeof component?.unwrap === "function" ? component.unwrap() : undefined;
	const groups = [
		component?.children,
		component?.contentContainer?.children,
		component?.contentBox?.children,
		component?.selfRenderContainer?.children,
	];
	const children = groups.flatMap((group) => (Array.isArray(group) ? group : []));
	return unwrapped && unwrapped !== component ? [unwrapped, ...children] : children;
}

export function setCollapsibleRailSectionsExpanded(root: any, expanded: boolean, seen = new Set<any>()): number {
	if (!root || typeof root !== "object" || seen.has(root)) return 0;
	seen.add(root);

	let count = 0;
	const section = resolveRailSection(root);
	if (section && canToggleRailSection(section)) {
		setRailSectionExpanded(section, expanded);
		count++;
	}

	for (const child of railSectionChildren(root)) count += setCollapsibleRailSectionsExpanded(child, expanded, seen);
	return count;
}

export function collapseHint(theme: ThemeLike | undefined, hiddenLineCount: number): string {
	const prefix = theme ? theme.fg("muted", `... (${Math.max(0, hiddenLineCount)} earlier lines,`) : `... (${Math.max(0, hiddenLineCount)} earlier lines,`;
	try {
		return `${prefix} ${keyHint("app.tools.expand", "to expand")})`;
	} catch {
		const fallback = theme ? `${theme.fg("dim", "ctrl+o")}${theme.fg("muted", " to expand")}` : "ctrl+o to expand";
		return `${prefix} ${fallback})`;
	}
}

export class RailSectionBlock implements Component {
	private readonly config: RailSectionResolvedConfig;
	private cached?: { width: number; innerLines: string[]; rows: string[] } | undefined;

	constructor(private readonly inner: Component, kind: RailSectionKind, overrides?: RailSectionOverrides) {
		this.config = mergeSectionConfig(kind, overrides);
		defineRailSection(this, kind, overrides, inner);
	}

	setText(text: string): void {
		(this.inner as any).setText?.(text);
		this.cached = undefined;
	}

	unwrap(): Component {
		return this.inner;
	}

	invalidate(): void {
		this.cached = undefined;
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		if (!isRailUiActive()) return this.inner.render(width);
		const layout = this.config.layout;
		const railAnsi = this.config.style.rail.ansi ?? "";
		const hasRail = this.config.style.railEnabled && railAnsi.length > 0 && layout.leftBorderWidth > 0;
		const hasBackground = this.config.style.background.length > 0;
		if (!hasRail && !hasBackground) return this.inner.render(width);

		const contentStart = hasRail ? layout.leftBorderWidth + layout.borderContentGapWidth : 0;
		if (width <= contentStart + 1) return this.inner.render(width);

		const innerWidth = Math.max(1, width - contentStart);
		const innerLines = this.inner.render(innerWidth);
		if (this.cached?.width === width && this.cached.innerLines === innerLines) return this.cached.rows;

		const border = hasRail ? `${railAnsi}${layout.leftBorder}${RAIL_EDITOR_STYLE.reset}` : "";
		const borderGap = hasRail ? " ".repeat(layout.borderContentGapWidth) : "";
		const rows = innerLines.map((line) => {
			const content = `${this.config.style.background}${padToWidth(line, innerWidth)}${RAIL_EDITOR_STYLE.reset}`;
			return `${border}${borderGap}${content}`;
		});
		this.cached = { width, innerLines, rows };
		return rows;
	}
}
