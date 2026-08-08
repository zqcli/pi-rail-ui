import { bg, fg, resolveBackground, resolveTextColor } from "./colors";
import { resolveRailSectionConfigs } from "./rail-section-style";
import type {
	AppLayout,
	BashExecutionLayout,
	ColorReference,
	ConversationScrollLayout,
	ConversationScrollbarStyle,
	EditorHeightPolicy,
	EditorPasteMarkerStyle,
	EditorSurfaceStyle,
	FooterLayout,
	FooterStyle,
	RailSectionKind,
	RailSectionRawConfig,
	RailSectionRawLayout,
	RailSectionRawStyle,
	RailSectionResolvedConfig,
	RailSurfaceStyle,
	SlashCommandLayout,
	StyleFile,
	UserMessageLayout,
} from "./types";

export type ResolvedStyleConfig = {
	APP_LAYOUT: AppLayout;
	CONVERSATION_SELECTION_STYLE: string;
	RAIL_EDITOR_SURFACE_STYLE: RailSurfaceStyle;
	RAIL_EDITOR_HEIGHT: EditorHeightPolicy;
	EDITOR_MOUSE_TRACKING_ENABLED: boolean;
	EDITOR_PASTE_MARKER_STYLE: EditorPasteMarkerStyle;
	CONVERSATION_SCROLL_LAYOUT: ConversationScrollLayout;
	CONVERSATION_SCROLLBAR_STYLE: ConversationScrollbarStyle;
	RAIL_EDITOR_STYLE: EditorSurfaceStyle;
	THINKING_RAIL_COLOR: ReturnType<typeof resolveTextColor>;
	RAIL_THINKING_STYLE: RailSurfaceStyle;
	USER_MESSAGE_LAYOUT: UserMessageLayout;
	RAIL_USER_MESSAGE_STYLE: RailSurfaceStyle;
	SLASH_COMMAND_LAYOUT: SlashCommandLayout;
	BASH_EXECUTION_LAYOUT: BashExecutionLayout;
	BASH_EXECUTION_RAIL_COLOR: ReturnType<typeof resolveTextColor>;
	RAIL_BASH_EXECUTION_STYLE: RailSurfaceStyle;
	RAIL_SECTION_CONFIGS: Record<RailSectionKind, RailSectionResolvedConfig>;
	RAIL_FOOTER_STYLE: FooterStyle;
	FOOTER_LAYOUT: FooterLayout;
};

export function resolveStyleConfig(style: StyleFile): ResolvedStyleConfig {
	const editorBackground = bg(style.editor.background, "editor.background");
	const editorRail = fg(style.editor.rail, "editor.rail");
	const selectionBackground = bg(style.editor.selection.background, "editor.selection.background");
	const selection = `${selectionBackground}${fg(
		style.editor.selection.foreground,
		"editor.selection.foreground",
	)}`;

	function railSectionRaw(kind: RailSectionKind): RailSectionRawConfig {
		return style.railSections?.sections?.[kind] ?? {};
	}

	function rawSectionStyle(kind: RailSectionKind): RailSectionRawStyle | undefined {
		return railSectionRaw(kind).style;
	}

	function rawSectionLayout(kind: RailSectionKind): RailSectionRawLayout | undefined {
		return railSectionRaw(kind).layout;
	}

	function sectionRailColor(rail: RailSectionRawStyle["rail"] | undefined, fallback: ColorReference) {
		return resolveTextColor(rail === undefined || rail === false ? fallback : rail, { editorRail });
	}

	const APP_LAYOUT: AppLayout = {
		leftGutterWidth: Math.max(0, Math.round(style.appLayout?.leftGutterWidth ?? 0)),
	};
	const RAIL_EDITOR_SURFACE_STYLE: RailSurfaceStyle = {
		...style.surfaceLayout,
		background: editorBackground,
		rail: editorRail,
		selection,
	};
	const RAIL_EDITOR_HEIGHT = {
		minHeight: style.editor.height.min,
		maxHeight: style.editor.height.max,
		maxHeightRatio: style.editor.height.maxRatio,
	} as const;
	const EDITOR_PASTE_MARKER_STYLE: EditorPasteMarkerStyle = {
		background: resolveBackground(style.editor.pasteMarker?.background ?? "transparent", editorBackground),
		foreground: resolveTextColor(style.editor.pasteMarker?.foreground ?? "editor.rail", { editorRail }),
		bold: style.editor.pasteMarker?.bold === true ? "\x1b[1m" : "",
		reset: style.surfaceLayout.reset,
	};
	const CONVERSATION_SCROLL_LAYOUT: ConversationScrollLayout = {
		// Pi 0.84 owns the active transcript viewport and alternate screen.
		// Legacy style values remain readable for compatibility, but cannot
		// reactivate Rail's retired renderer/input patches.
		mode: "native",
		enabled: false,
		alternateScreen: false,
		wheelStepRows: Math.max(1, Math.round(style.conversationScroll?.wheelStepRows ?? 3)),
		historyTailRenderWindow: Math.max(1, Math.round(style.conversationScroll?.performance?.historyTailRenderWindow ?? 8)),
	};
	const CONVERSATION_SCROLLBAR_STYLE: ConversationScrollbarStyle = {
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
	const RAIL_EDITOR_STYLE: EditorSurfaceStyle = {
		...RAIL_EDITOR_SURFACE_STYLE,
		...RAIL_EDITOR_HEIGHT,
	};
	const thinkingSectionStyle = rawSectionStyle("assistantThinking");
	const THINKING_RAIL_COLOR = sectionRailColor(thinkingSectionStyle?.rail, style.thinking.rail);
	const RAIL_THINKING_STYLE: RailSurfaceStyle = {
		...RAIL_EDITOR_SURFACE_STYLE,
		background: resolveBackground(thinkingSectionStyle?.background ?? style.thinking.background, editorBackground),
		rail: THINKING_RAIL_COLOR.ansi ?? editorRail,
	};
	const USER_MESSAGE_LAYOUT: UserMessageLayout = {
		textGapWidth: Math.max(0, style.userMessage.textGapWidth),
		verticalPaddingRows: Math.max(0, style.userMessage.verticalPaddingRows),
		timestampColor: resolveTextColor(style.userMessage.timestampColor, { editorRail }),
	};
	const userMessageSectionStyle = rawSectionStyle("userMessage");
	const userRailColor = sectionRailColor(userMessageSectionStyle?.rail, style.userMessage.rail);
	const RAIL_USER_MESSAGE_STYLE: RailSurfaceStyle = {
		...RAIL_EDITOR_SURFACE_STYLE,
		background: resolveBackground(userMessageSectionStyle?.background ?? style.userMessage.background, editorBackground),
		rail: userRailColor.ansi ?? editorRail,
	};
	const SLASH_COMMAND_LAYOUT: SlashCommandLayout = {
		textGapWidth: Math.max(0, style.slashCommand.textGapWidth),
		bottomReservedRows: Math.max(0, style.slashCommand.bottomReservedRows),
		firstLevelMaxRows: Math.max(1, Math.round(RAIL_EDITOR_HEIGHT.minHeight * style.slashCommand.firstLevelHeightMultiplier)),
		nestedMaxRows: Math.max(1, style.slashCommand.nestedMaxOverlayRows),
		minPrimaryColumnWidth: Math.max(1, style.slashCommand.minPrimaryColumnWidth),
		maxPrimaryColumnWidth: Math.max(1, style.slashCommand.maxPrimaryColumnWidth),
		selectedText: resolveTextColor(style.slashCommand.selectedText, { editorRail }),
	};
	const bashExecutionSectionStyle = rawSectionStyle("bashExecution");
	const bashExecutionSectionLayout = rawSectionLayout("bashExecution");
	const BASH_EXECUTION_LAYOUT: BashExecutionLayout = {
		verticalSpacingRows: Math.max(0, Math.round(
			bashExecutionSectionLayout?.spacing?.beforeRows
				?? bashExecutionSectionLayout?.verticalSpacingRows
				?? style.bashExecution?.verticalSpacingRows
				?? 1,
		)),
	};
	const BASH_EXECUTION_RAIL_COLOR = resolveTextColor(
		bashExecutionSectionStyle?.rail === undefined || bashExecutionSectionStyle.rail === false
			? style.bashExecution?.rail ?? "theme:bashMode"
			: bashExecutionSectionStyle.rail,
		{ editorRail },
	);
	const RAIL_BASH_EXECUTION_STYLE: RailSurfaceStyle = {
		...RAIL_EDITOR_SURFACE_STYLE,
		leftBorder: bashExecutionSectionLayout?.leftBorder ?? style.bashExecution?.leftBorder ?? style.surfaceLayout.leftBorder,
		borderContentGapWidth: Math.max(0, Math.round(bashExecutionSectionLayout?.borderContentGapWidth ?? style.bashExecution?.borderContentGapWidth ?? style.surfaceLayout.borderContentGapWidth)),
		background: resolveBackground(bashExecutionSectionStyle?.background ?? style.bashExecution?.background ?? "editor.background", editorBackground),
		rail: BASH_EXECUTION_RAIL_COLOR.ansi ?? editorRail,
	};
	const surfaceContentStart = style.surfaceLayout.leftBorderWidth + style.surfaceLayout.borderContentGapWidth;
	const outerContentStart = 0;
	const bashContentStart = style.surfaceLayout.leftBorderWidth
		+ Math.max(0, Math.round(bashExecutionSectionLayout?.borderContentGapWidth ?? style.bashExecution?.borderContentGapWidth ?? style.surfaceLayout.borderContentGapWidth));
	const RAIL_SECTION_CONFIGS: Record<RailSectionKind, RailSectionResolvedConfig> = resolveRailSectionConfigs({
		style,
		editorBackground,
		editorRail,
		surfaceContentStart,
		outerContentStart,
		bashContentStart,
		bashExecutionVerticalSpacingRows: BASH_EXECUTION_LAYOUT.verticalSpacingRows,
	});

	return {
		APP_LAYOUT,
		CONVERSATION_SELECTION_STYLE: selectionBackground,
		RAIL_EDITOR_SURFACE_STYLE,
		RAIL_EDITOR_HEIGHT,
		EDITOR_MOUSE_TRACKING_ENABLED: style.editor.mouseTracking?.enabled === true,
		EDITOR_PASTE_MARKER_STYLE,
		CONVERSATION_SCROLL_LAYOUT,
		CONVERSATION_SCROLLBAR_STYLE,
		RAIL_EDITOR_STYLE,
		THINKING_RAIL_COLOR,
		RAIL_THINKING_STYLE,
		USER_MESSAGE_LAYOUT,
		RAIL_USER_MESSAGE_STYLE,
		SLASH_COMMAND_LAYOUT,
		BASH_EXECUTION_LAYOUT,
		BASH_EXECUTION_RAIL_COLOR,
		RAIL_BASH_EXECUTION_STYLE,
		RAIL_SECTION_CONFIGS,
		RAIL_FOOTER_STYLE: {
			sky: fg(style.footer.colors.sky, "footer.colors.sky"),
			mint: fg(style.footer.colors.mint, "footer.colors.mint"),
			amber: fg(style.footer.colors.amber, "footer.colors.amber"),
			lilac: fg(style.footer.colors.lilac, "footer.colors.lilac"),
			text: fg(style.footer.colors.text, "footer.colors.text"),
			muted: fg(style.footer.colors.muted, "footer.colors.muted"),
		},
		FOOTER_LAYOUT: {
			cwdMaxWidth: style.footer.cwdMaxWidth,
			modelMaxWidth: style.footer.modelMaxWidth,
			branchMaxWidth: style.footer.branchMaxWidth,
			bottomGapRows: Math.max(0, Math.round(style.footer.bottomGapRows ?? 0)),
		},
	};
}
