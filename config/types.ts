export type RgbTuple = [number, number, number];
export type ColorSpec = { rgb: RgbTuple };
export type ColorReference = ColorSpec | "transparent" | "editor.background" | "editor.rail" | `theme:${string}`;
export type RailSectionKind =
	| "assistantMessage"
	| "assistantThinking"
	| "assistantReply"
	| "userMessage"
	| "toolExecution"
	| "bashExecution"
	| "commandOutput"
	| "resourceStatus"
	| "selectorOutput"
	| "custom";
export type RailSectionSelectionMode = "fullRow" | "contentOnly" | "visible";
export type RailSectionCollapsedRenderMode = "review" | "simple";

export type RailSectionRawStyle = {
	background?: ColorReference;
	rail?: ColorReference | false;
};

export type RailSectionSpacingScope = "section" | "group";

export type RailSectionRawSpacing = {
	beforeRows?: number;
	afterRows?: number;
	collapseAdjacent?: boolean;
	scope?: RailSectionSpacingScope;
};

export type RailSectionRawLayout = {
	leftBorder?: string;
	leftBorderWidth?: number;
	borderContentGapWidth?: number;
	verticalSpacingRows?: number;
	spacing?: RailSectionRawSpacing;
	contentStartCol?: number;
	alignWith?: RailSectionKind | string;
};

export type RailSectionRawSelection = {
	mode?: RailSectionSelectionMode;
	stripAnsi?: boolean;
	trimRight?: boolean;
	includeRail?: boolean;
	includeGap?: boolean;
	includeLeadingBlankRows?: boolean;
	includeTrailingBlankRows?: boolean;
	includeTimestamp?: boolean;
};

export type RailSectionRawConfig = {
	selectable?: boolean;
	collapsible?: boolean;
	clickToToggle?: boolean;
	autoCollapseAfterRows?: number | false;
	preserveScrollOnToggle?: boolean;
	preserveScrollOnUpdate?: boolean;
	collapseByDefault?: string[];
	collapsedRenderMode?: RailSectionCollapsedRenderMode;
	layout?: RailSectionRawLayout;
	style?: RailSectionRawStyle;
	selection?: RailSectionRawSelection;
};

export type StyleFile = {
	appLayout?: {
		leftGutterWidth?: number;
	};
	surfaceLayout: {
		leftBorder: string;
		leftBorderWidth: number;
		borderContentGapWidth: number;
		reset: string;
	};
	editor: {
		height: { min: number; max: number; maxRatio: number };
		background: ColorSpec;
		rail: ColorSpec;
		selection: { background: ColorSpec; foreground: ColorSpec };
		pasteMarker?: { background?: ColorReference; foreground?: ColorReference; bold?: boolean };
		mouseTracking?: { enabled?: boolean };
	};
	conversationScroll?: {
		mode?: "app" | "native";
		enabled?: boolean;
		alternateScreen?: boolean;
		wheelStepRows?: number;
		performance?: {
			historyTailRenderWindow?: number;
		};
		scrollbar?: {
			visible?: boolean;
			dragEnabled?: boolean;
			trackBackground?: ColorReference;
			thumbBackground?: ColorReference;
			widthMultiplier?: number;
			dragAnimationMs?: number;
		};
	};
	thinking: {
		background: ColorReference;
		rail: ColorReference;
	};
	assistantReply: {
		alignSurface: "thinking" | "editor" | "userMessage";
	};
	userMessage: {
		background: ColorReference;
		rail: ColorReference;
		textGapWidth: number;
		verticalPaddingRows: number;
		timestampColor: ColorReference;
	};
	slashCommand: {
		selectedText: ColorReference;
		textGapWidth: number;
		bottomReservedRows: number;
		firstLevelHeightMultiplier: number;
		nestedMaxOverlayRows: number;
		minPrimaryColumnWidth: number;
		maxPrimaryColumnWidth: number;
	};
	bashExecution?: {
		background?: ColorReference;
		rail?: ColorReference;
		leftBorder?: string;
		borderContentGapWidth?: number;
		verticalSpacingRows?: number;
	};
	railSections?: {
		defaults?: RailSectionRawConfig;
		sections?: Partial<Record<RailSectionKind, RailSectionRawConfig>>;
	};
	footer: {
		cwdMaxWidth: number;
		modelMaxWidth: number;
		branchMaxWidth: number;
		bottomGapRows?: number;
		colors: Record<"sky" | "mint" | "amber" | "lilac" | "text" | "muted", ColorSpec>;
	};
};

export type AppLayout = {
	leftGutterWidth: number;
};

export type RailSurfaceStyle = {
	leftBorder: string;
	leftBorderWidth: number;
	borderContentGapWidth: number;
	background: string;
	rail: string;
	selection: string;
	reset: string;
};

export type EditorHeightPolicy = {
	minHeight: number;
	maxHeight: number;
	maxHeightRatio: number;
};

export type EditorSurfaceStyle = RailSurfaceStyle & EditorHeightPolicy;

export type TextColorTarget = {
	themeKey?: string | undefined;
	ansi?: string | undefined;
};

export type UserMessageLayout = {
	textGapWidth: number;
	verticalPaddingRows: number;
	timestampColor: TextColorTarget;
};

export type SlashCommandLayout = {
	textGapWidth: number;
	bottomReservedRows: number;
	firstLevelMaxRows: number;
	nestedMaxRows: number;
	minPrimaryColumnWidth: number;
	maxPrimaryColumnWidth: number;
	selectedText: TextColorTarget;
};

export type FooterStyle = Record<"sky" | "mint" | "amber" | "lilac" | "text" | "muted", string>;

export type BashExecutionLayout = {
	verticalSpacingRows: number;
};

export type RailSectionSelectionConfig = Required<Omit<RailSectionRawSelection, "includeTimestamp">> & {
	includeTimestamp: boolean;
};

export type RailSectionStyleConfig = {
	background: string;
	rail: TextColorTarget;
	railEnabled: boolean;
};

export type RailSectionSpacingConfig = {
	beforeRows: number;
	afterRows: number;
	collapseAdjacent: boolean;
	scope: RailSectionSpacingScope;
};

export type RailSectionLayoutConfig = {
	leftBorder: string;
	leftBorderWidth: number;
	borderContentGapWidth: number;
	verticalSpacingRows: number;
	spacing: RailSectionSpacingConfig;
	contentStartCol: number;
	alignWith?: string | undefined;
};

export type RailSectionResolvedConfig = {
	kind: RailSectionKind;
	selectable: boolean;
	collapsible: boolean;
	clickToToggle: boolean;
	autoCollapseAfterRows?: number | undefined;
	preserveScrollOnToggle: boolean;
	preserveScrollOnUpdate: boolean;
	collapseByDefault?: string[] | undefined;
	collapsedRenderMode: RailSectionCollapsedRenderMode;
	layout: RailSectionLayoutConfig;
	style: RailSectionStyleConfig;
	selection: RailSectionSelectionConfig;
};

export type EditorPasteMarkerStyle = {
	background: string;
	foreground: TextColorTarget;
	bold: string;
	reset: string;
};

export type ConversationScrollMode = "app" | "native";

export type ConversationScrollLayout = {
	mode: ConversationScrollMode;
	enabled: boolean;
	alternateScreen: boolean;
	wheelStepRows: number;
	historyTailRenderWindow: number;
};

export type ConversationScrollbarStyle = {
	visible: boolean;
	dragEnabled: boolean;
	trackBackground: string;
	thumbBackground: string;
	width: number;
	dragAnimationMs: number;
	reset: string;
};

export type FooterLayout = {
	cwdMaxWidth: number;
	modelMaxWidth: number;
	branchMaxWidth: number;
	bottomGapRows: number;
};

export type ThemeLike = {
	fg(name: string, value: string): string;
};
