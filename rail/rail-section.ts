import { keyHint } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
	railSectionConfig,
	type RailSectionKind,
	type RailSectionResolvedConfig,
	type ThemeLike,
} from "../config";

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

const RAIL_SECTION_METADATA_KEY = Symbol.for("pi-rail-ui.rail-section-metadata");
const RAIL_SECTION_MANUAL_TOGGLE_KEY = Symbol.for("pi-rail-ui.rail-section-manual-toggle");
const RAIL_UI_ACTIVE_KEY = Symbol.for("pi-rail-ui.active");

export function setRailUiActive(active: boolean): void {
	(globalThis as any)[RAIL_UI_ACTIVE_KEY] = active;
}

export function isRailUiActive(): boolean {
	return (globalThis as any)[RAIL_UI_ACTIVE_KEY] !== false;
}

export function railSectionConfigWithOverrides(kind: RailSectionKind, overrides?: RailSectionOverrides): RailSectionResolvedConfig {
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
			config: railSectionConfigWithOverrides(metadata.kind, metadata.overrides),
		};
	}

	const kind = builtInKindForComponent(component);
	if (!kind) return undefined;
	return { kind, component, config: railSectionConfig(kind) };
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

/**
 * Run `dispatch` with a rail scroll anchor installed for its synchronous
 * duration. Gutter document wrappers call this with the transcript ScrollView
 * pin closure so a section toggle that happens anywhere in the dispatch pins
 * the viewport (public `scrollTo(scrollTop, { disableFollow: true })`). Any
 * currently installed anchor is preserved across nesting.
 */
export function withRailSectionScrollAnchor(anchor: (() => void) | undefined, dispatch: () => TuiMouseEventResult | undefined): TuiMouseEventResult | undefined {
	const previous = currentRailSectionScrollAnchor;
	currentRailSectionScrollAnchor = anchor;
	try {
		return dispatch();
	} finally {
		currentRailSectionScrollAnchor = previous;
	}
}

let currentRailSectionScrollAnchor: (() => void) | undefined;

/** Toggle a clickable section, pin the viewport first, then mark it manual. */
export function toggleRailSectionFromClick(section: RailSectionDefinition): void {
	if (!canToggleRailSection(section)) return;
	const component = section.component;
	currentRailSectionScrollAnchor?.();
	setRailSectionExpanded(section, !Boolean(component.expanded));
}

/**
 * Component-level click handler for collapsible Rail sections.
 *
 * Pi 0.85.1 synthesizes a `click` after an un-dragged selection release and
 * dispatches it through the component tree, so a section only answers clicks;
 * presses and drags stay in the native selection/copy pipeline.
 *
 * With `suppressUntoggleable`, a click on a non-toggleable section is still
 * consumed so Pi's own regions (e.g. the native thinking visibility toggle)
 * cannot rebuild content under the Rail collapse presentation.
 */
export function handleRailSectionClickToggle(
	component: any,
	event: TuiMouseEvent,
	suppressUntoggleable = false,
): TuiMouseEventResult | undefined {
	if (event.type !== "click" || event.button !== "left") return undefined;
	const section = resolveRailSection(component);
	if (!section) return undefined;
	if (canToggleRailSection(section)) {
		toggleRailSectionFromClick(section);
		return { handled: true };
	}
	return suppressUntoggleable ? { handled: true } : undefined;
}

export { RailSectionBlock } from "./rail-section-block";
