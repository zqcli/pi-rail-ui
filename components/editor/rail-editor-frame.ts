import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../../config";
import type { EditorSurfaceRenderer } from "../../rail/rail-surface";
import type { MouseLayout, Position } from "../../core/utils";
import { RailEditorFrameLayoutPlanner, type RailEditorFrameLayout } from "./rail-editor-frame-layout";

type SelectionRange = { start: Position; end: Position } | undefined;

export type RailEditorFrameInput = {
	width: number;
	terminalRows: number;
	lines: string[];
	cursor: Position;
	focused: boolean;
	paddingX: number;
	autocompleteActive: boolean;
	autocompletePrefix: string;
	slashAutocompleteLevel?: string | undefined;
	selection?: SelectionRange;
	completionRows: string[];
	surface: EditorSurfaceRenderer;
	appTheme: ThemeLike;
};

export type RailEditorFrame = {
	rows: string[];
	mouseLayout: MouseLayout;
};

export class RailEditorFrameRenderer {
	private readonly layoutPlanner = new RailEditorFrameLayoutPlanner();
	private renderCache?: { signature: string; linesRef: string[]; rows: string[]; mouseLayout: MouseLayout } | undefined;

	resetContent(): void {
		this.layoutPlanner.resetContent();
		this.renderCache = undefined;
	}

	resetRender(): void {
		this.renderCache = undefined;
	}

	markTextInput(): void {
		this.layoutPlanner.markTextInput();
		this.renderCache = undefined;
	}

	scrollBy(deltaRows: number): void {
		this.layoutPlanner.scrollBy(deltaRows);
		this.renderCache = undefined;
	}

	render(input: RailEditorFrameInput): RailEditorFrame {
		const signature = this.renderSignature(input);
		if (this.renderCache?.linesRef === input.lines && this.renderCache.signature === signature) {
			return { rows: this.renderCache.rows, mouseLayout: this.renderCache.mouseLayout };
		}

		const result = this.renderSurfaceRows(input, this.layoutPlanner.layout(input));
		this.renderCache = { signature, linesRef: input.lines, rows: result.rows, mouseLayout: result.mouseLayout };
		return result;
	}

	private renderSignature(input: RailEditorFrameInput): string {
		const selection = input.selection;
		return [
			input.width,
			input.terminalRows,
			input.focused ? 1 : 0,
			input.paddingX,
			input.cursor.line,
			input.cursor.col,
			input.slashAutocompleteLevel ?? "",
			input.autocompleteActive ? 1 : 0,
			input.autocompletePrefix,
			selection ? `${selection.start.line}:${selection.start.col}:${selection.end.line}:${selection.end.col}` : "",
			input.completionRows.length,
			input.completionRows.join("\u001e"),
			input.lines.length,
		].join("\u001f");
	}

	private renderSurfaceRows(input: RailEditorFrameInput, layout: RailEditorFrameLayout): RailEditorFrame {
		const rows: string[] = [];
		for (let i = 0; i < layout.topPadding; i++) rows.push(input.surface.renderSurfaceRow(input.width));
		for (const line of layout.rows) rows.push(input.surface.renderSurfaceRow(input.width, line));
		for (let i = 0; i < layout.bottomPadding; i++) rows.push(input.surface.renderSurfaceRow(input.width));
		for (const line of input.completionRows) rows.push(input.surface.renderCompletion(input.width, line));

		const cursorLocalRow = rows.findIndex((line) => line.includes(CURSOR_MARKER));
		const cursorLine = cursorLocalRow >= 0 ? rows[cursorLocalRow]! : rows[0] ?? "";
		const markerIndex = cursorLine.indexOf(CURSOR_MARKER);
		return {
			rows,
			mouseLayout: {
				contentStartCol: input.surface.contentStartCol(),
				contentWidth: layout.contentWidth,
				topPadding: layout.topPadding,
				visibleMap: layout.visibleMap,
				cursorLocalRow: Math.max(0, cursorLocalRow),
				cursorLocalCol: markerIndex >= 0 ? visibleWidth(cursorLine.slice(0, markerIndex)) : 0,
			},
		};
	}
}
