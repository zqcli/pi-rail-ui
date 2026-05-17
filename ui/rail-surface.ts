import { CURSOR_MARKER, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	TALL_GRAY_EDITOR_HEIGHT,
	TALL_GRAY_EDITOR_SURFACE_STYLE,
	TALL_GRAY_EDITOR_STYLE,
	TALL_GRAY_THINKING_STYLE,
	TALL_GRAY_USER_MESSAGE_STYLE,
	TALL_GRAY_SLASH_COMMAND_STYLE,
	TALL_GRAY_BASH_EXECUTION_STYLE,
	BASH_EXECUTION_RAIL_COLOR,
	THINKING_RAIL_COLOR,
	SLASH_COMMAND_RAIL_COLOR,
	railAnsiForTheme,
	railSectionConfig,
	type EditorHeightPolicy,
	type EditorSurfaceStyle,
	type RailSectionKind,
	type RailSurfaceStyle,
	type ThemeLike,
} from "../config";
import {
	SGR_RESET,
	SGR_RESET_RE,
	applyColumnHighlight,
	buildVisualMap,
	padToWidth,
	splitDefaultEditor,
	visibleBodySlice,
	type ColumnRange,
	type MouseLayout,
	type VisualRow,
} from "../utils";

export type { EditorHeightPolicy, EditorSurfaceStyle, RailSurfaceStyle } from "../config";

export class EditorSurfaceRenderer {
	readonly style: RailSurfaceStyle;
	private readonly contentStart: number;
	private readonly leftMargin: string;
	private readonly transparentGap: string;
	private readonly completionPrefix: string;
	private readonly rowCache = new Map<string, string>();

	constructor(
		style: RailSurfaceStyle = TALL_GRAY_EDITOR_STYLE,
		private readonly heightPolicy?: EditorHeightPolicy,
	) {
		this.style = style;
		this.contentStart = style.leftWindowGapWidth + style.leftBorderWidth + style.borderContentGapWidth;
		this.leftMargin = " ".repeat(style.leftWindowGapWidth);
		this.transparentGap = " ".repeat(style.borderContentGapWidth);
		this.completionPrefix = " ".repeat(this.contentStart);
	}

	minRenderableWidth(): number {
		return this.contentStart + 4;
	}

	contentStartCol(): number {
		return this.contentStart;
	}

	contentWidth(width: number): number {
		return Math.max(1, width - this.contentStart);
	}

	targetInputHeight(bodyRows: number, terminalRows: number): number {
		const policy = this.heightPolicy;
		if (!policy) return Math.max(1, bodyRows);
		const responsiveMax = Math.max(policy.minHeight, Math.min(policy.maxHeight, Math.floor(terminalRows * policy.maxHeightRatio)));
		return Math.max(policy.minHeight, Math.min(responsiveMax, bodyRows));
	}

	renderSurfaceRow(width: number, content = ""): string {
		const key = `${width}\u001f${content}`;
		const cached = this.rowCache.get(key);
		if (cached !== undefined) return cached;
		const targetWidth = Math.max(0, width - this.contentStart);
		const contentWidth = visibleWidth(content);
		const rawFitted = contentWidth <= targetWidth ? content + " ".repeat(targetWidth - contentWidth) : padToWidth(content, targetWidth);
		const fitted = this.restoreSurfaceAfterResets(rawFitted);
		const row = `${this.leftMargin}${this.style.rail}${this.style.leftBorder}${this.style.reset}${this.transparentGap}${this.style.background}${fitted}${this.style.reset}`;
		if (this.rowCache.size > 2048) this.rowCache.clear();
		this.rowCache.set(key, row);
		return row;
	}

	renderCompletion(width: number, line: string): string {
		return this.completionPrefix + padToWidth(line, Math.max(0, width - this.contentStart));
	}

	highlightColumns(line: string, startCol: number, endCol: number): string {
		return applyColumnHighlight(line, startCol, endCol, this.style.selection, this.style.reset);
	}

	private restoreSurfaceAfterResets(text: string): string {
		if (!this.style.background || !text.includes(SGR_RESET)) return text;
		return text.replace(SGR_RESET_RE, `${this.style.reset}${this.style.background}`);
	}
}

export const tallGrayEditorSurface = new EditorSurfaceRenderer(TALL_GRAY_EDITOR_STYLE, TALL_GRAY_EDITOR_HEIGHT);
export const tallGrayThinkingSurface = new EditorSurfaceRenderer(TALL_GRAY_THINKING_STYLE);
export const tallGrayUserMessageSurface = new EditorSurfaceRenderer(TALL_GRAY_USER_MESSAGE_STYLE);
export const tallGraySlashCommandSurface = new EditorSurfaceRenderer(TALL_GRAY_SLASH_COMMAND_STYLE);
export const tallGrayBashExecutionSurface = new EditorSurfaceRenderer(TALL_GRAY_BASH_EXECUTION_STYLE);

export function railSectionSurfaceStyle(kind: RailSectionKind, theme?: ThemeLike): RailSurfaceStyle {
	const config = railSectionConfig(kind);
	const rail = config.style.railEnabled
		? (theme ? railAnsiForTheme(theme, config.style.rail) : undefined) ?? config.style.rail.ansi ?? ""
		: "";
	return {
		...TALL_GRAY_EDITOR_SURFACE_STYLE,
		leftWindowGapWidth: config.layout.leftWindowGapWidth,
		leftBorder: config.style.railEnabled ? config.layout.leftBorder : "",
		leftBorderWidth: config.style.railEnabled ? config.layout.leftBorderWidth : 0,
		borderContentGapWidth: config.style.railEnabled ? config.layout.borderContentGapWidth : 0,
		background: config.style.background,
		rail,
	};
}

export function railSectionSurfaceForTheme(kind: RailSectionKind, theme?: ThemeLike): EditorSurfaceRenderer {
	return new EditorSurfaceRenderer(railSectionSurfaceStyle(kind, theme));
}

export const tallGraySelectorOutputSurface = railSectionSurfaceForTheme("selectorOutput");

export function selectorOutputSurfaceForTheme(theme: ThemeLike | undefined): EditorSurfaceRenderer {
	return railSectionSurfaceForTheme("selectorOutput", theme);
}

export function thinkingSurfaceForTheme(theme: ThemeLike): EditorSurfaceRenderer {
	return new EditorSurfaceRenderer({
		...TALL_GRAY_THINKING_STYLE,
		rail: railAnsiForTheme(theme, THINKING_RAIL_COLOR) ?? TALL_GRAY_THINKING_STYLE.rail,
	});
}

export function slashCommandSurfaceForTheme(theme: ThemeLike): EditorSurfaceRenderer {
	return new EditorSurfaceRenderer({
		...TALL_GRAY_SLASH_COMMAND_STYLE,
		rail: railAnsiForTheme(theme, SLASH_COMMAND_RAIL_COLOR) ?? TALL_GRAY_SLASH_COMMAND_STYLE.rail,
	});
}

export function bashExecutionSurfaceForTheme(theme: ThemeLike | undefined): EditorSurfaceRenderer {
	let rail = TALL_GRAY_BASH_EXECUTION_STYLE.rail;
	try {
		if (theme) rail = railAnsiForTheme(theme, BASH_EXECUTION_RAIL_COLOR) ?? rail;
	} catch {
		// Theme may not be initialized in isolated tests; keep the static fallback.
	}
	return new EditorSurfaceRenderer({
		...TALL_GRAY_BASH_EXECUTION_STYLE,
		rail,
	});
}

export class SurfaceRailBlock implements Component {
	private cached?: { width: number; innerLines: string[]; rows: string[] };

	constructor(
		private readonly inner: Component,
		private readonly surface: EditorSurfaceRenderer = tallGrayThinkingSurface,
	) {}

	invalidate(): void {
		this.cached = undefined;
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		if (width < this.surface.minRenderableWidth()) return this.inner.render(width);
		const innerLines = this.inner.render(this.surface.contentWidth(width));
		if (this.cached?.width === width && this.cached.innerLines === innerLines) return this.cached.rows;
		const rows = innerLines.map((line) => this.surface.renderSurfaceRow(width, line));
		this.cached = { width, innerLines, rows };
		return rows;
	}
}

// Compatibility name used by older iterations of this extension.
export class ThinkingSurfaceBlock extends SurfaceRailBlock {}

export class SurfaceContentInsetBlock implements Component {
	private cached?: { width: number; innerLines: string[]; rows: string[] };

	constructor(
		private readonly inner: Component,
		private readonly surface: EditorSurfaceRenderer = tallGrayThinkingSurface,
	) {}

	invalidate(): void {
		this.cached = undefined;
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		const inset = this.surface.contentStartCol();
		if (inset <= 0 || width <= inset + 1) return this.inner.render(width);

		const innerWidth = Math.max(1, width - inset);
		const innerLines = this.inner.render(innerWidth);
		if (this.cached?.width === width && this.cached.innerLines === innerLines) return this.cached.rows;
		const prefix = " ".repeat(inset);
		const rows = innerLines.map((line) => prefix + padToWidth(line, innerWidth));
		this.cached = { width, innerLines, rows };
		return rows;
	}
}

export type EditorSurfaceRenderOptions = {
	defaultEditorRows: string[];
	logicalLines: string[];
	terminalRows: number;
	paddingX: number;
	selectionForRow?: (row: VisualRow) => ColumnRange | undefined;
	renderCompletions?: boolean;
	visualMapStart?: number;
	precomputedVisibleMap?: VisualRow[];
};

export type EditorSurfaceRenderResult = {
	rows: string[];
	mouseLayout: MouseLayout;
};

export function renderEditorSurface(
	width: number,
	options: EditorSurfaceRenderOptions,
	surface: EditorSurfaceRenderer = tallGrayEditorSurface,
): EditorSurfaceRenderResult {
	const contentWidth = surface.contentWidth(width);
	const split = splitDefaultEditor(options.defaultEditorRows);
	const targetInputHeight = surface.targetInputHeight(split.body.length, options.terminalRows);
	const bodySlice = visibleBodySlice(split.body, targetInputHeight, CURSOR_MARKER);
	const body = bodySlice.lines;

	const innerWidth = Math.max(1, contentWidth - options.paddingX * 2);
	const layoutWidth = Math.max(1, innerWidth - (options.paddingX ? 0 : 1));
	const visibleMap = options.precomputedVisibleMap ?? (() => {
		const fullMap = buildVisualMap(options.logicalLines, layoutWidth);
		const visualMapStart = options.visualMapStart === undefined ? bodySlice.start : options.visualMapStart + bodySlice.start;
		return fullMap.slice(visualMapStart, visualMapStart + body.length);
	})();

	const blankRows = Math.max(0, targetInputHeight - body.length);
	const topPadding = Math.floor(blankRows / 2);
	const bottomPadding = blankRows - topPadding;

	const rows: string[] = [];
	for (let i = 0; i < topPadding; i++) rows.push(surface.renderSurfaceRow(width));
	for (let index = 0; index < body.length; index++) {
		const line = body[index] ?? "";
		const row = visibleMap[index];
		const selection = row ? options.selectionForRow?.(row) : undefined;
		const displayLine = selection
			? surface.highlightColumns(line, selection.startCol + options.paddingX, selection.endCol + options.paddingX)
			: line;
		rows.push(surface.renderSurfaceRow(width, displayLine));
	}
	for (let i = 0; i < bottomPadding; i++) rows.push(surface.renderSurfaceRow(width));
	if (options.renderCompletions !== false) {
		for (const line of split.completions) rows.push(surface.renderCompletion(width, line));
	}

	const cursorLocalRow = rows.findIndex((line) => line.includes(CURSOR_MARKER));
	const cursorLine = cursorLocalRow >= 0 ? rows[cursorLocalRow]! : rows[0] ?? "";
	const markerIndex = cursorLine.indexOf(CURSOR_MARKER);

	return {
		rows,
		mouseLayout: {
			contentStartCol: surface.contentStartCol(),
			contentWidth,
			topPadding,
			visibleMap,
			cursorLocalRow: Math.max(0, cursorLocalRow),
			cursorLocalCol: markerIndex >= 0 ? visibleWidth(cursorLine.slice(0, markerIndex)) : 0,
		},
	};
}
