import * as fs from "node:fs";
import { bg, fg, resolveBackground, resolveTextColor } from "./colors";
import type {
	BashExecutionLayout,
	ConversationScrollLayout,
	ConversationScrollMode,
	ConversationScrollbarStyle,
	EditorPasteMarkerStyle,
	EditorSurfaceStyle,
	FooterLayout,
	FooterStyle,
	RailSectionKind,
	RailSectionLayoutConfig,
	RailSectionRawConfig,
	RailSectionRawLayout,
	RailSectionRawSelection,
	RailSectionRawStyle,
	RailSectionResolvedConfig,
	RailSectionSelectionConfig,
	RailSectionSpacingConfig,
	RailSurfaceStyle,
	SlashCommandLayout,
	StyleFile,
	UserMessageLayout,
} from "./types";

export type { EditorHeightPolicy, EditorSurfaceStyle, RailSurfaceStyle } from "./types";
export type { TextColorTarget, ThemeLike, RailSectionKind, RailSectionSelectionMode } from "./types";
export type { UserMessageLayout, SlashCommandLayout, FooterStyle, BashExecutionLayout } from "./types";
export type { RailSectionSelectionConfig, RailSectionStyleConfig, RailSectionSpacingConfig } from "./types";
export type { RailSectionLayoutConfig, RailSectionResolvedConfig, EditorPasteMarkerStyle } from "./types";
export type { ConversationScrollMode, ConversationScrollLayout, ConversationScrollbarStyle } from "./types";
export type { FooterLayout } from "./types";
export { applyTextColor, railAnsiForTheme } from "./colors";

function readStyleFile(): StyleFile {
	const url = new URL("../ui-style.json", import.meta.url);
	return JSON.parse(fs.readFileSync(url, "utf8")) as StyleFile;
}

const style = readStyleFile();
const editorBackground = bg(style.editor.background, "editor.background");
const editorRail = fg(style.editor.rail, "editor.rail");
const selection = `${bg(style.editor.selection.background, "editor.selection.background")}${fg(
	style.editor.selection.foreground,
	"editor.selection.foreground",
)}`;

const RAIL_SECTION_KINDS: RailSectionKind[] = [
	"assistantMessage",
	"assistantThinking",
	"assistantReply",
	"userMessage",
	"toolExecution",
	"bashExecution",
	"commandOutput",
	"resourceStatus",
	"selectorOutput",
	"custom",
];

function railSectionRaw(kind: RailSectionKind): RailSectionRawConfig {
	return style.railSections?.sections?.[kind] ?? {};
}

function railSectionDefaultRaw(): RailSectionRawConfig {
	return style.railSections?.defaults ?? {};
}

function rawSectionStyle(kind: RailSectionKind): RailSectionRawStyle | undefined {
	return railSectionRaw(kind).style;
}

function rawSectionLayout(kind: RailSectionKind): RailSectionRawLayout | undefined {
	return railSectionRaw(kind).layout;
}

function mergeRaw<T extends object>(defaults: T | undefined, value: T | undefined): Partial<T> {
	return { ...(defaults ?? {}), ...(value ?? {}) };
}

function sectionContentStart(layout: RailSectionRawLayout, fallback: Partial<RailSectionLayoutConfig>, railEnabled: boolean): number {
	if (typeof layout.contentStartCol === "number") return Math.max(0, Math.round(layout.contentStartCol));
	if (typeof fallback.contentStartCol === "number") return Math.max(0, Math.round(fallback.contentStartCol));
	const gap = Math.max(0, Math.round(layout.leftWindowGapWidth ?? fallback.leftWindowGapWidth ?? style.surfaceLayout.leftWindowGapWidth));
	if (!railEnabled) return gap;
	const borderWidth = Math.max(0, Math.round(layout.leftBorderWidth ?? fallback.leftBorderWidth ?? style.surfaceLayout.leftBorderWidth));
	const borderGap = Math.max(0, Math.round(layout.borderContentGapWidth ?? fallback.borderContentGapWidth ?? style.surfaceLayout.borderContentGapWidth));
	return gap + borderWidth + borderGap;
}

function resolveRailSectionConfig(kind: RailSectionKind, fallback: Partial<RailSectionResolvedConfig> = {}): RailSectionResolvedConfig {
	const defaults = railSectionDefaultRaw();
	const raw = railSectionRaw(kind);
	const layout = mergeRaw(defaults.layout, raw.layout) as RailSectionRawLayout;
	const sectionStyle = mergeRaw(defaults.style, raw.style) as RailSectionRawStyle;
	const sectionSelection = mergeRaw(defaults.selection, raw.selection) as RailSectionRawSelection;
	const railEnabled = sectionStyle.rail !== false;
	const fallbackLayout = fallback.layout ?? {} as Partial<RailSectionLayoutConfig>;

	const fallbackSpacing = fallbackLayout.spacing;
	const rawSpacing = layout.spacing;
	const legacyBeforeRows = layout.verticalSpacingRows ?? fallbackLayout.verticalSpacingRows;
	const beforeRows = rawSpacing?.beforeRows ?? fallbackSpacing?.beforeRows ?? legacyBeforeRows ?? 0;
	const resolvedSpacing: RailSectionSpacingConfig = {
		beforeRows: Math.max(0, Math.round(beforeRows)),
		afterRows: Math.max(0, Math.round(rawSpacing?.afterRows ?? fallbackSpacing?.afterRows ?? 0)),
		collapseAdjacent: rawSpacing?.collapseAdjacent ?? fallbackSpacing?.collapseAdjacent ?? true,
		scope: rawSpacing?.scope ?? fallbackSpacing?.scope ?? "section",
	};
	const resolvedLayout: RailSectionLayoutConfig = {
		leftWindowGapWidth: Math.max(0, Math.round(layout.leftWindowGapWidth ?? fallbackLayout.leftWindowGapWidth ?? style.surfaceLayout.leftWindowGapWidth)),
		leftBorder: layout.leftBorder ?? fallbackLayout.leftBorder ?? style.surfaceLayout.leftBorder,
		leftBorderWidth: Math.max(0, Math.round(layout.leftBorderWidth ?? fallbackLayout.leftBorderWidth ?? style.surfaceLayout.leftBorderWidth)),
		borderContentGapWidth: Math.max(0, Math.round(layout.borderContentGapWidth ?? fallbackLayout.borderContentGapWidth ?? style.surfaceLayout.borderContentGapWidth)),
		verticalSpacingRows: resolvedSpacing.beforeRows,
		spacing: resolvedSpacing,
		contentStartCol: sectionContentStart(layout, fallbackLayout, railEnabled),
		alignWith: layout.alignWith ?? fallbackLayout.alignWith,
	};

	const defaultSelection: RailSectionSelectionConfig = {
		mode: "contentOnly",
		stripAnsi: true,
		trimRight: true,
		includeRail: false,
		includeGap: false,
		includeLeadingBlankRows: false,
		includeTrailingBlankRows: false,
		includeTimestamp: false,
	};
	const fallbackSelection = fallback.selection ?? defaultSelection;
	const resolvedSelection: RailSectionSelectionConfig = {
		mode: sectionSelection.mode ?? fallbackSelection.mode ?? defaultSelection.mode,
		stripAnsi: sectionSelection.stripAnsi ?? fallbackSelection.stripAnsi ?? defaultSelection.stripAnsi,
		trimRight: sectionSelection.trimRight ?? fallbackSelection.trimRight ?? defaultSelection.trimRight,
		includeRail: sectionSelection.includeRail ?? fallbackSelection.includeRail ?? defaultSelection.includeRail,
		includeGap: sectionSelection.includeGap ?? fallbackSelection.includeGap ?? defaultSelection.includeGap,
		includeLeadingBlankRows: sectionSelection.includeLeadingBlankRows ?? fallbackSelection.includeLeadingBlankRows ?? defaultSelection.includeLeadingBlankRows,
		includeTrailingBlankRows: sectionSelection.includeTrailingBlankRows ?? fallbackSelection.includeTrailingBlankRows ?? defaultSelection.includeTrailingBlankRows,
		includeTimestamp: sectionSelection.includeTimestamp ?? fallbackSelection.includeTimestamp ?? defaultSelection.includeTimestamp,
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
		layout: resolvedLayout,
		style: {
			background: resolveBackground(sectionStyle.background ?? "transparent", editorBackground) || fallbackStyle?.background || "",
			rail: sectionStyle.rail === false ? {} : resolveTextColor(sectionStyle.rail ?? "transparent", { editorRail }),
			railEnabled,
		},
		selection: resolvedSelection,
	};
}

export const TALL_GRAY_EDITOR_SURFACE_STYLE: RailSurfaceStyle = {
	...style.surfaceLayout,
	background: editorBackground,
	rail: editorRail,
	selection,
};

export const TALL_GRAY_EDITOR_HEIGHT = {
	minHeight: style.editor.height.min,
	maxHeight: style.editor.height.max,
	maxHeightRatio: style.editor.height.maxRatio,
} as const;

export const EDITOR_MOUSE_TRACKING_ENABLED = style.editor.mouseTracking?.enabled === true;

export const EDITOR_PASTE_MARKER_STYLE: EditorPasteMarkerStyle = {
	background: resolveBackground(style.editor.pasteMarker?.background ?? "transparent", editorBackground),
	foreground: resolveTextColor(style.editor.pasteMarker?.foreground ?? "editor.rail", { editorRail }),
	bold: style.editor.pasteMarker?.bold === true ? "\x1b[1m" : "",
	reset: style.surfaceLayout.reset,
};

const conversationScrollMode: ConversationScrollMode = style.conversationScroll?.mode
	?? (style.conversationScroll?.enabled === false ? "native" : "app");
const conversationScrollEnabled = style.conversationScroll?.mode === "app"
	? style.conversationScroll.enabled !== false
	: style.conversationScroll?.enabled === true;

export const CONVERSATION_SCROLL_LAYOUT: ConversationScrollLayout = {
	mode: conversationScrollMode,
	enabled: conversationScrollMode === "app" && conversationScrollEnabled,
	alternateScreen: style.conversationScroll?.alternateScreen !== false,
	wheelStepRows: Math.max(1, Math.round(style.conversationScroll?.wheelStepRows ?? 3)),
	historyTailRenderWindow: Math.max(1, Math.round(style.conversationScroll?.performance?.historyTailRenderWindow ?? 8)),
};

export const CONVERSATION_SCROLLBAR_STYLE: ConversationScrollbarStyle = {
	visible: style.conversationScroll?.scrollbar?.visible !== false,
	dragEnabled: style.conversationScroll?.scrollbar?.dragEnabled !== false,
	trackBackground: resolveBackground(style.conversationScroll?.scrollbar?.trackBackground ?? "editor.background", editorBackground),
	thumbBackground: style.conversationScroll?.scrollbar?.thumbBackground
		? resolveBackground(style.conversationScroll.scrollbar.thumbBackground, editorBackground)
		: bg(style.editor.rail, "conversationScroll.scrollbar.thumbBackground"),
	width: Math.max(1, Math.round(style.surfaceLayout.leftBorderWidth * (style.conversationScroll?.scrollbar?.widthMultiplier ?? 1))),
	dragAnimationMs: Math.max(0, Math.round(style.conversationScroll?.scrollbar?.dragAnimationMs ?? 90)),
	reset: style.surfaceLayout.reset,
};

export const TALL_GRAY_EDITOR_STYLE: EditorSurfaceStyle = {
	...TALL_GRAY_EDITOR_SURFACE_STYLE,
	...TALL_GRAY_EDITOR_HEIGHT,
};

const thinkingSectionStyle = rawSectionStyle("assistantThinking");
export const THINKING_RAIL_COLOR = resolveTextColor(
	thinkingSectionStyle?.rail && thinkingSectionStyle.rail !== false ? thinkingSectionStyle.rail : style.thinking.rail,
	{ editorRail },
);
export const TALL_GRAY_THINKING_STYLE: RailSurfaceStyle = {
	...TALL_GRAY_EDITOR_SURFACE_STYLE,
	background: resolveBackground(thinkingSectionStyle?.background ?? style.thinking.background, editorBackground),
	rail: THINKING_RAIL_COLOR.ansi ?? editorRail,
};

export const USER_MESSAGE_LAYOUT: UserMessageLayout = {
	textGapWidth: Math.max(0, style.userMessage.textGapWidth),
	verticalPaddingRows: Math.max(0, style.userMessage.verticalPaddingRows),
	timestampColor: resolveTextColor(style.userMessage.timestampColor, { editorRail }),
};

const userMessageSectionStyle = rawSectionStyle("userMessage");
const userRailColor = resolveTextColor(
	userMessageSectionStyle?.rail && userMessageSectionStyle.rail !== false ? userMessageSectionStyle.rail : style.userMessage.rail,
	{ editorRail },
);
export const TALL_GRAY_USER_MESSAGE_STYLE: RailSurfaceStyle = {
	...TALL_GRAY_EDITOR_SURFACE_STYLE,
	background: resolveBackground(userMessageSectionStyle?.background ?? style.userMessage.background, editorBackground),
	rail: userRailColor.ansi ?? editorRail,
};

export const SLASH_COMMAND_RAIL_COLOR = resolveTextColor(style.slashCommand.rail, { editorRail });
export const SLASH_COMMAND_LAYOUT: SlashCommandLayout = {
	textGapWidth: Math.max(0, style.slashCommand.textGapWidth),
	bottomReservedRows: Math.max(0, style.slashCommand.bottomReservedRows),
	firstLevelMaxRows: Math.max(1, Math.round(TALL_GRAY_EDITOR_HEIGHT.minHeight * style.slashCommand.firstLevelHeightMultiplier)),
	nestedMaxRows: Math.max(1, style.slashCommand.nestedMaxOverlayRows),
	minPrimaryColumnWidth: Math.max(1, style.slashCommand.minPrimaryColumnWidth),
	maxPrimaryColumnWidth: Math.max(1, style.slashCommand.maxPrimaryColumnWidth),
	selectedText: resolveTextColor(style.slashCommand.selectedText, { editorRail }),
};

export const TALL_GRAY_SLASH_COMMAND_STYLE: RailSurfaceStyle = {
	...TALL_GRAY_EDITOR_SURFACE_STYLE,
	background: resolveBackground(style.slashCommand.background, editorBackground),
	rail: SLASH_COMMAND_RAIL_COLOR.ansi ?? editorRail,
};

const bashExecutionSectionStyle = rawSectionStyle("bashExecution");
const bashExecutionSectionLayout = rawSectionLayout("bashExecution");
export const BASH_EXECUTION_LAYOUT: BashExecutionLayout = {
	verticalSpacingRows: Math.max(0, Math.round(
		bashExecutionSectionLayout?.spacing?.beforeRows
			?? bashExecutionSectionLayout?.verticalSpacingRows
			?? style.bashExecution?.verticalSpacingRows
			?? 1,
	)),
};

export const BASH_EXECUTION_RAIL_COLOR = resolveTextColor(
	bashExecutionSectionStyle?.rail && bashExecutionSectionStyle.rail !== false ? bashExecutionSectionStyle.rail : style.bashExecution?.rail ?? "theme:bashMode",
	{ editorRail },
);
export const TALL_GRAY_BASH_EXECUTION_STYLE: RailSurfaceStyle = {
	...TALL_GRAY_EDITOR_SURFACE_STYLE,
	leftBorder: bashExecutionSectionLayout?.leftBorder ?? style.bashExecution?.leftBorder ?? style.surfaceLayout.leftBorder,
	borderContentGapWidth: Math.max(0, Math.round(bashExecutionSectionLayout?.borderContentGapWidth ?? style.bashExecution?.borderContentGapWidth ?? style.surfaceLayout.borderContentGapWidth)),
	background: resolveBackground(bashExecutionSectionStyle?.background ?? style.bashExecution?.background ?? "editor.background", editorBackground),
	rail: BASH_EXECUTION_RAIL_COLOR.ansi ?? editorRail,
};

const surfaceContentStart = style.surfaceLayout.leftWindowGapWidth + style.surfaceLayout.leftBorderWidth + style.surfaceLayout.borderContentGapWidth;
const leftGapContentStart = style.surfaceLayout.leftWindowGapWidth;
const bashContentStart = style.surfaceLayout.leftWindowGapWidth
	+ style.surfaceLayout.leftBorderWidth
	+ Math.max(0, Math.round(bashExecutionSectionLayout?.borderContentGapWidth ?? style.bashExecution?.borderContentGapWidth ?? style.surfaceLayout.borderContentGapWidth));
const contentOnlySelection: RailSectionSelectionConfig = {
	mode: "contentOnly",
	stripAnsi: true,
	trimRight: true,
	includeRail: false,
	includeGap: false,
	includeLeadingBlankRows: false,
	includeTrailingBlankRows: false,
	includeTimestamp: false,
};

export const RAIL_SECTION_CONFIGS: Record<RailSectionKind, RailSectionResolvedConfig> = Object.fromEntries(
	RAIL_SECTION_KINDS.map((kind) => {
		const fallbackByKind: Partial<Record<RailSectionKind, Partial<RailSectionResolvedConfig>>> = {
			assistantMessage: { selectable: true, layout: { contentStartCol: surfaceContentStart }, selection: contentOnlySelection },
			assistantThinking: { selectable: true, layout: { contentStartCol: surfaceContentStart }, selection: contentOnlySelection },
			assistantReply: { selectable: true, layout: { contentStartCol: surfaceContentStart, alignWith: "assistantThinking" }, selection: contentOnlySelection },
			userMessage: { selectable: true, layout: { contentStartCol: surfaceContentStart + Math.max(0, style.userMessage.textGapWidth), spacing: { beforeRows: 0, afterRows: 0, collapseAdjacent: true, scope: "section" } }, selection: contentOnlySelection },
			toolExecution: { selectable: true, collapsible: true, clickToToggle: true, layout: { contentStartCol: leftGapContentStart, spacing: { beforeRows: 0, afterRows: 0, collapseAdjacent: true, scope: "section" } }, selection: contentOnlySelection },
			bashExecution: { selectable: true, collapsible: true, clickToToggle: true, layout: { contentStartCol: bashContentStart, spacing: { beforeRows: BASH_EXECUTION_LAYOUT.verticalSpacingRows, afterRows: 0, collapseAdjacent: true, scope: "section" } }, selection: contentOnlySelection },
			commandOutput: { selectable: true, layout: { contentStartCol: leftGapContentStart, spacing: { beforeRows: 1, afterRows: 0, collapseAdjacent: true, scope: "group" } }, selection: contentOnlySelection },
			resourceStatus: { selectable: true, layout: { contentStartCol: leftGapContentStart, spacing: { beforeRows: 1, afterRows: 0, collapseAdjacent: true, scope: "group" } }, selection: contentOnlySelection },
			selectorOutput: { selectable: false, layout: { contentStartCol: surfaceContentStart }, selection: contentOnlySelection },
			custom: { selectable: true, layout: { contentStartCol: leftGapContentStart }, selection: contentOnlySelection },
		};
		return [kind, resolveRailSectionConfig(kind, fallbackByKind[kind])];
	}),
) as Record<RailSectionKind, RailSectionResolvedConfig>;

export function railSectionConfig(kind: RailSectionKind): RailSectionResolvedConfig {
	return RAIL_SECTION_CONFIGS[kind] ?? RAIL_SECTION_CONFIGS.custom;
}

export const TALL_GRAY_FOOTER_STYLE: FooterStyle = {
	sky: fg(style.footer.colors.sky, "footer.colors.sky"),
	mint: fg(style.footer.colors.mint, "footer.colors.mint"),
	amber: fg(style.footer.colors.amber, "footer.colors.amber"),
	lilac: fg(style.footer.colors.lilac, "footer.colors.lilac"),
	text: fg(style.footer.colors.text, "footer.colors.text"),
	muted: fg(style.footer.colors.muted, "footer.colors.muted"),
};

export const FOOTER_LAYOUT: FooterLayout = {
	cwdMaxWidth: style.footer.cwdMaxWidth,
	modelMaxWidth: style.footer.modelMaxWidth,
	branchMaxWidth: style.footer.branchMaxWidth,
};
