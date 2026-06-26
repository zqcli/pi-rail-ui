import {
	clampPosition,
	comparePosition,
	indexForVisualCol,
	samePosition,
	visibleColForIndex,
	type ColumnRange,
	type MouseLayout,
	type ParsedMouse,
	type Position,
	type VisualRow,
} from "../../core/utils";

type Selection = { anchor: Position; active: Position };

export type RailEditorSelectionHost = {
	lines(): string[];
	setText(text: string): void;
	moveCursorToPosition(pos: Position): void;
	copyText(text: string): void;
	requestRender(): void;
};

export class RailEditorSelectionEngine {
	private selection?: Selection | undefined;
	private pendingMouse?: ParsedMouse | undefined;
	private mouseLayout?: MouseLayout | undefined;
	private screenOrigin?: {
		topRow: number;
		leftCol: number;
		visibleRows: number;
		contentWidth: number;
		contentStartCol: number;
	} | undefined;

	setSelectionRange(anchor: Position, active: Position): void {
		this.selection = { anchor, active };
	}

	clearSelection(): boolean {
		if (!this.selection) return false;
		this.selection = undefined;
		return true;
	}

	setMouseLayout(layout: MouseLayout): void {
		const previous = this.mouseLayout;
		if (
			!previous ||
			previous.visibleMap.length !== layout.visibleMap.length ||
			previous.contentWidth !== layout.contentWidth ||
			previous.contentStartCol !== layout.contentStartCol ||
			previous.topPadding !== layout.topPadding
		) {
			this.screenOrigin = undefined;
		}
		this.mouseLayout = layout;
	}

	selectionRange(): { start: Position; end: Position } | undefined {
		if (!this.selection) return undefined;
		const { anchor, active } = this.selection;
		if (samePosition(anchor, active)) return undefined;
		return comparePosition(anchor, active) <= 0 ? { start: anchor, end: active } : { start: active, end: anchor };
	}

	selectionColumnsForRow(row: VisualRow): ColumnRange | undefined {
		const range = this.selectionRange();
		if (!range) return undefined;
		if (row.logicalLine < range.start.line || row.logicalLine > range.end.line) return undefined;

		let startIndex = row.startIndex;
		let endIndex = row.endIndex;
		if (row.logicalLine === range.start.line) startIndex = Math.max(startIndex, range.start.col);
		if (row.logicalLine === range.end.line) endIndex = Math.min(endIndex, range.end.col);
		if (endIndex <= startIndex) return undefined;

		return {
			startCol: visibleColForIndex(row.text, startIndex - row.startIndex),
			endCol: visibleColForIndex(row.text, endIndex - row.startIndex),
		};
	}

	private positionFromLocal(localRow: number, localCol: number): Position | undefined {
		const layout = this.mouseLayout;
		if (!layout || layout.visibleMap.length === 0) return undefined;

		const contentCol = Math.max(0, Math.min(layout.contentWidth, localCol - layout.contentStartCol));
		if (localRow < layout.topPadding) {
			const first = layout.visibleMap[0]!;
			return { line: first.logicalLine, col: first.startIndex };
		}

		const bodyRow = localRow - layout.topPadding;
		if (bodyRow >= layout.visibleMap.length) {
			const last = layout.visibleMap[layout.visibleMap.length - 1]!;
			return { line: last.logicalLine, col: last.endIndex };
		}

		const row = layout.visibleMap[bodyRow]!;
		return { line: row.logicalLine, col: row.startIndex + indexForVisualCol(row.text, contentCol) };
	}

	private resolveMouseFromOrigin(mouse: ParsedMouse, host: RailEditorSelectionHost, origin: { topRow: number; leftCol: number }): void {
		const localRow = mouse.y - origin.topRow;
		const localCol = mouse.x - origin.leftCol;
		const pos = this.positionFromLocal(localRow, localCol);
		if (!pos) return;

		if (mouse.action === "press") {
			this.selection = { anchor: pos, active: pos };
			host.moveCursorToPosition(pos);
			return;
		}

		if (mouse.action === "drag") {
			if (!this.selection) this.selection = { anchor: pos, active: pos };
			else this.selection.active = pos;
			host.moveCursorToPosition(pos);
			return;
		}

		if (this.selection) this.selection.active = pos;
		const range = this.selectionRange();
		if (range) this.copySelectionToClipboard(host, range);
		else this.selection = undefined;
		host.requestRender();
	}

	private resolveMouse(mouse: ParsedMouse, host: RailEditorSelectionHost, cursor: { row: number; col: number }): void {
		const layout = this.mouseLayout;
		if (!layout) return;

		const origin = {
			topRow: cursor.row - layout.cursorLocalRow,
			leftCol: cursor.col - layout.cursorLocalCol,
			visibleRows: layout.visibleMap.length,
			contentWidth: layout.contentWidth,
			contentStartCol: layout.contentStartCol,
		};
		this.screenOrigin = origin;
		this.resolveMouseFromOrigin(mouse, host, origin);
	}

	deleteSelection(host: RailEditorSelectionHost): boolean {
		const range = this.selectionRange();
		if (!range) return false;

		const lines = host.lines();
		const start = clampPosition(range.start, lines);
		const end = clampPosition(range.end, lines);
		if (comparePosition(start, end) >= 0) return false;

		if (start.line === end.line) {
			const line = lines[start.line] ?? "";
			lines[start.line] = line.slice(0, start.col) + line.slice(end.col);
		} else {
			const first = lines[start.line] ?? "";
			const last = lines[end.line] ?? "";
			lines.splice(start.line, end.line - start.line + 1, first.slice(0, start.col) + last.slice(end.col));
		}

		this.selection = undefined;
		host.setText(lines.join("\n"));
		host.moveCursorToPosition(start);
		return true;
	}

	private selectionText(host: RailEditorSelectionHost, range: { start: Position; end: Position }): string {
		const lines = host.lines();
		const start = clampPosition(range.start, lines);
		const end = clampPosition(range.end, lines);
		if (start.line === end.line) return (lines[start.line] ?? "").slice(start.col, end.col);
		const out = [(lines[start.line] ?? "").slice(start.col)];
		for (let line = start.line + 1; line < end.line; line++) out.push(lines[line] ?? "");
		out.push((lines[end.line] ?? "").slice(0, end.col));
		return out.join("\n");
	}

	private copySelectionToClipboard(host: RailEditorSelectionHost, range: { start: Position; end: Position }): void {
		const text = this.selectionText(host, range);
		if (!text) return;
		host.copyText(text);
	}

	handleMouse(mouse: ParsedMouse, host: RailEditorSelectionHost, requestCursorPosition: () => void): void {
		const origin = this.screenOrigin;
		const layout = this.mouseLayout;
		if (
			origin &&
			layout &&
			origin.visibleRows === layout.visibleMap.length &&
			origin.contentWidth === layout.contentWidth &&
			origin.contentStartCol === layout.contentStartCol
		) {
			this.resolveMouseFromOrigin(mouse, host, origin);
			return;
		}
		this.pendingMouse = mouse;
		requestCursorPosition();
	}

	handleCursorPosition(cursor: { row: number; col: number }, host: RailEditorSelectionHost): void {
		const pending = this.pendingMouse;
		this.pendingMouse = undefined;
		if (pending) this.resolveMouse(pending, host, cursor);
	}
}
