import { resolveBackground, resolveTextColor } from "./colors";
import type {
	RailSectionKind,
	RailSectionLayoutConfig,
	RailSectionRawConfig,
	RailSectionRawLayout,
	RailSectionRawSelection,
	RailSectionRawStyle,
	RailSectionResolvedConfig,
	RailSectionSelectionConfig,
	RailSectionSpacingConfig,
	RailSectionStyleConfig,
	StyleFile,
} from "./types";

const RAIL_SECTION_KINDS: RailSectionKind[] = [
	"assistantMessage",
	"assistantThinking",
	"assistantReply",
	"hostedSearch",
	"userMessage",
	"toolExecution",
	"bashExecution",
	"commandOutput",
	"resourceStatus",
	"selectorOutput",
	"custom",
];

type RailSectionConfigFallback = Partial<Omit<RailSectionResolvedConfig, "layout" | "style" | "selection">> & {
	layout?: Partial<RailSectionLayoutConfig>;
	style?: Partial<RailSectionStyleConfig>;
	selection?: Partial<RailSectionSelectionConfig>;
};

type RailSectionStyleResolutionInput = {
	style: StyleFile;
	editorBackground: string;
	editorRail: string;
	surfaceContentStart: number;
	outerContentStart: number;
	bashContentStart: number;
	bashExecutionVerticalSpacingRows: number;
};

const DEFAULT_RAIL_SECTION_SELECTION: RailSectionSelectionConfig = {
	mode: "contentOnly",
	stripAnsi: true,
	trimRight: true,
	includeRail: false,
	includeGap: false,
	includeLeadingBlankRows: false,
	includeTrailingBlankRows: false,
	includeTimestamp: false,
};

function railSectionRaw(style: StyleFile, kind: RailSectionKind): RailSectionRawConfig {
	return style.railSections?.sections?.[kind] ?? {};
}

function railSectionDefaultRaw(style: StyleFile): RailSectionRawConfig {
	return style.railSections?.defaults ?? {};
}

function mergeRaw<T extends object>(defaults: T | undefined, value: T | undefined): Partial<T> {
	return { ...(defaults ?? {}), ...(value ?? {}) };
}

function sectionContentStart(style: StyleFile, layout: RailSectionRawLayout, fallback: Partial<RailSectionLayoutConfig>, railEnabled: boolean): number {
	if (typeof layout.contentStartCol === "number") return Math.max(0, Math.round(layout.contentStartCol));
	if (typeof fallback.contentStartCol === "number") return Math.max(0, Math.round(fallback.contentStartCol));
	if (!railEnabled) return 0;
	const borderWidth = Math.max(0, Math.round(layout.leftBorderWidth ?? fallback.leftBorderWidth ?? style.surfaceLayout.leftBorderWidth));
	const borderGap = Math.max(0, Math.round(layout.borderContentGapWidth ?? fallback.borderContentGapWidth ?? style.surfaceLayout.borderContentGapWidth));
	return borderWidth + borderGap;
}

function resolveRailSectionConfig(
	input: RailSectionStyleResolutionInput,
	kind: RailSectionKind,
	fallback: RailSectionConfigFallback = {},
): RailSectionResolvedConfig {
	const { style, editorBackground, editorRail } = input;
	const defaults = railSectionDefaultRaw(style);
	const raw = railSectionRaw(style, kind);
	const layout = mergeRaw(defaults.layout, raw.layout) as RailSectionRawLayout;
	const sectionStyle = mergeRaw(defaults.style, raw.style) as RailSectionRawStyle;
	const sectionSelection = mergeRaw(defaults.selection, raw.selection) as RailSectionRawSelection;
	const railEnabled = sectionStyle.rail !== false;
	const fallbackLayout = fallback.layout ?? {} as Partial<RailSectionLayoutConfig>;

	const fallbackSpacing = fallbackLayout.spacing;
	const rawSpacing = layout.spacing;
	const fallbackBeforeRows = layout.verticalSpacingRows ?? fallbackLayout.verticalSpacingRows;
	const beforeRows = rawSpacing?.beforeRows ?? fallbackSpacing?.beforeRows ?? fallbackBeforeRows ?? 0;
	const resolvedSpacing: RailSectionSpacingConfig = {
		beforeRows: Math.max(0, Math.round(beforeRows)),
		afterRows: Math.max(0, Math.round(rawSpacing?.afterRows ?? fallbackSpacing?.afterRows ?? 0)),
		collapseAdjacent: rawSpacing?.collapseAdjacent ?? fallbackSpacing?.collapseAdjacent ?? true,
		scope: rawSpacing?.scope ?? fallbackSpacing?.scope ?? "section",
	};
	const resolvedLayout: RailSectionLayoutConfig = {
		leftBorder: layout.leftBorder ?? fallbackLayout.leftBorder ?? style.surfaceLayout.leftBorder,
		leftBorderWidth: Math.max(0, Math.round(layout.leftBorderWidth ?? fallbackLayout.leftBorderWidth ?? style.surfaceLayout.leftBorderWidth)),
		borderContentGapWidth: Math.max(0, Math.round(layout.borderContentGapWidth ?? fallbackLayout.borderContentGapWidth ?? style.surfaceLayout.borderContentGapWidth)),
		verticalSpacingRows: resolvedSpacing.beforeRows,
		spacing: resolvedSpacing,
		contentStartCol: sectionContentStart(style, layout, fallbackLayout, railEnabled),
		alignWith: layout.alignWith ?? fallbackLayout.alignWith,
	};

	const fallbackSelection = fallback.selection ?? DEFAULT_RAIL_SECTION_SELECTION;
	const resolvedSelection: RailSectionSelectionConfig = {
		mode: sectionSelection.mode ?? fallbackSelection.mode ?? DEFAULT_RAIL_SECTION_SELECTION.mode,
		stripAnsi: sectionSelection.stripAnsi ?? fallbackSelection.stripAnsi ?? DEFAULT_RAIL_SECTION_SELECTION.stripAnsi,
		trimRight: sectionSelection.trimRight ?? fallbackSelection.trimRight ?? DEFAULT_RAIL_SECTION_SELECTION.trimRight,
		includeRail: sectionSelection.includeRail ?? fallbackSelection.includeRail ?? DEFAULT_RAIL_SECTION_SELECTION.includeRail,
		includeGap: sectionSelection.includeGap ?? fallbackSelection.includeGap ?? DEFAULT_RAIL_SECTION_SELECTION.includeGap,
		includeLeadingBlankRows: sectionSelection.includeLeadingBlankRows ?? fallbackSelection.includeLeadingBlankRows ?? DEFAULT_RAIL_SECTION_SELECTION.includeLeadingBlankRows,
		includeTrailingBlankRows: sectionSelection.includeTrailingBlankRows ?? fallbackSelection.includeTrailingBlankRows ?? DEFAULT_RAIL_SECTION_SELECTION.includeTrailingBlankRows,
		includeTimestamp: sectionSelection.includeTimestamp ?? fallbackSelection.includeTimestamp ?? DEFAULT_RAIL_SECTION_SELECTION.includeTimestamp,
	};

	const fallbackStyle = fallback.style;
	const rawAutoCollapse = raw.autoCollapseAfterRows ?? defaults.autoCollapseAfterRows ?? fallback.autoCollapseAfterRows;
	const autoCollapseAfterRows = rawAutoCollapse === false || rawAutoCollapse === undefined
		? undefined
		: Math.max(1, Math.round(rawAutoCollapse));

	return {
		kind,
		selectable: raw.selectable ?? defaults.selectable ?? fallback.selectable ?? true,
		collapsible: raw.collapsible ?? defaults.collapsible ?? fallback.collapsible ?? false,
		clickToToggle: raw.clickToToggle ?? defaults.clickToToggle ?? fallback.clickToToggle ?? false,
		autoCollapseAfterRows,
		preserveScrollOnToggle: raw.preserveScrollOnToggle ?? defaults.preserveScrollOnToggle ?? fallback.preserveScrollOnToggle ?? true,
		preserveScrollOnUpdate: raw.preserveScrollOnUpdate ?? defaults.preserveScrollOnUpdate ?? fallback.preserveScrollOnUpdate ?? true,
		collapseByDefault: raw.collapseByDefault ?? defaults.collapseByDefault ?? fallback.collapseByDefault,
		collapsedRenderMode: (raw.collapsedRenderMode ?? defaults.collapsedRenderMode ?? fallback.collapsedRenderMode) === "simple" ? "simple" : "review",
		layout: resolvedLayout,
		style: {
			background: resolveBackground(sectionStyle.background ?? "transparent", editorBackground) || fallbackStyle?.background || "",
			rail: sectionStyle.rail === false ? {} : resolveTextColor(sectionStyle.rail ?? "transparent", { editorRail }),
			railEnabled,
		},
		selection: resolvedSelection,
	};
}

export function resolveRailSectionConfigs(input: RailSectionStyleResolutionInput): Record<RailSectionKind, RailSectionResolvedConfig> {
	const { style, surfaceContentStart, outerContentStart, bashContentStart, bashExecutionVerticalSpacingRows } = input;
	const RAIL_SECTION_FALLBACKS: Record<RailSectionKind, RailSectionConfigFallback> = {
		assistantMessage: { selectable: true, layout: { contentStartCol: surfaceContentStart }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		assistantThinking: { selectable: true, layout: { contentStartCol: surfaceContentStart }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		assistantReply: { selectable: true, layout: { contentStartCol: surfaceContentStart, alignWith: "assistantThinking" }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		hostedSearch: { selectable: true, collapsible: true, clickToToggle: true, layout: { contentStartCol: surfaceContentStart, alignWith: "assistantThinking" }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		userMessage: { selectable: true, layout: { contentStartCol: surfaceContentStart + Math.max(0, style.userMessage.textGapWidth), spacing: { beforeRows: 0, afterRows: 0, collapseAdjacent: true, scope: "section" } }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		toolExecution: { selectable: true, collapsible: true, clickToToggle: true, layout: { contentStartCol: outerContentStart, spacing: { beforeRows: 0, afterRows: 0, collapseAdjacent: true, scope: "section" } }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		bashExecution: { selectable: true, collapsible: true, clickToToggle: true, layout: { contentStartCol: bashContentStart, spacing: { beforeRows: bashExecutionVerticalSpacingRows, afterRows: 0, collapseAdjacent: true, scope: "section" } }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		commandOutput: { selectable: true, layout: { contentStartCol: outerContentStart, spacing: { beforeRows: 1, afterRows: 0, collapseAdjacent: true, scope: "group" } }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		resourceStatus: { selectable: true, layout: { contentStartCol: outerContentStart, spacing: { beforeRows: 1, afterRows: 0, collapseAdjacent: true, scope: "group" } }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		selectorOutput: { selectable: false, layout: { contentStartCol: surfaceContentStart }, selection: DEFAULT_RAIL_SECTION_SELECTION },
		custom: { selectable: true, layout: { contentStartCol: outerContentStart }, selection: DEFAULT_RAIL_SECTION_SELECTION },
	};
	return Object.fromEntries(
		RAIL_SECTION_KINDS.map((kind) => [kind, resolveRailSectionConfig(input, kind, RAIL_SECTION_FALLBACKS[kind])]),
	) as Record<RailSectionKind, RailSectionResolvedConfig>;
}
