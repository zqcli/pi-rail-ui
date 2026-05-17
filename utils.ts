import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const OSC133_ZONE_START = "\x1b]133;A\x07";
export const OSC133_ZONE_END = "\x1b]133;B\x07";
export const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const ANSI_PATTERN = "\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1b\\\\)|_[^\\x07]*(?:\\x07|\\x1b\\\\))";
export const ANSI_RE = new RegExp(ANSI_PATTERN, "g");
export const ANSI_AT_RE = new RegExp(`^${ANSI_PATTERN}`);
const ANSI_FIND_RE = new RegExp(ANSI_PATTERN);
export const SGR_RESET = "\x1b[0m";
export const SGR_RESET_RE = /\x1b\[0m/g;
export const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
export const CURSOR_POSITION_RE = /^\x1b\[(\d+);(\d+)R$/;

export const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type Position = {
	line: number;
	col: number;
};

export type VisualRow = {
	logicalLine: number;
	startIndex: number;
	endIndex: number;
	text: string;
};

export type ColumnRange = {
	startCol: number;
	endCol: number;
};

export type MouseLayout = {
	contentStartCol: number;
	contentWidth: number;
	topPadding: number;
	visibleMap: VisualRow[];
	cursorLocalRow: number;
	cursorLocalCol: number;
};

export type SplitRender = {
	body: string[];
	completions: string[];
};

export type BodySlice = {
	lines: string[];
	start: number;
};

export type ParsedMouse = {
	x: number;
	y: number;
	action: "press" | "drag" | "release";
};

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

export function padToWidth(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "", true);
}

export function fitToWidth(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	return visibleWidth(text) > width ? truncateToWidth(text, width, ellipsis) : text;
}

export function comparePosition(a: Position, b: Position): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.col - b.col;
}

export function samePosition(a: Position, b: Position): boolean {
	return a.line === b.line && a.col === b.col;
}

export function clampPosition(pos: Position, lines: string[]): Position {
	const line = Math.max(0, Math.min(pos.line, Math.max(0, lines.length - 1)));
	const text = lines[line] ?? "";
	return { line, col: Math.max(0, Math.min(pos.col, text.length)) };
}

export function visibleColForIndex(text: string, index: number): number {
	if (index <= 0) return 0;
	return visibleWidth(text.slice(0, Math.max(0, Math.min(index, text.length))));
}

export function indexForVisualCol(text: string, targetCol: number): number {
	if (targetCol <= 0) return 0;
	let width = 0;
	for (const segment of segmenter.segment(text)) {
		const nextWidth = width + visibleWidth(segment.segment);
		if (targetCol < nextWidth) return segment.index;
		width = nextWidth;
	}
	return text.length;
}

export function applyColumnHighlight(
	line: string,
	startCol: number,
	endCol: number,
	highlightAnsi: string,
	resetAnsi: string,
): string {
	if (endCol <= startCol) return line;

	let out = "";
	let col = 0;
	let i = 0;
	let highlighted = false;
	const setHighlighted = (next: boolean): void => {
		if (highlighted === next) return;
		out += next ? highlightAnsi : resetAnsi;
		highlighted = next;
	};

	while (i < line.length) {
		const ansi = line.slice(i).match(ANSI_AT_RE)?.[0];
		if (ansi) {
			out += ansi;
			if (highlighted) out += highlightAnsi;
			i += ansi.length;
			continue;
		}

		const rest = line.slice(i);
		const nextAnsi = rest.match(ANSI_FIND_RE);
		const run = nextAnsi?.index === undefined ? rest : rest.slice(0, nextAnsi.index);
		if (!run) break;

		for (const segment of segmenter.segment(run)) {
			const grapheme = segment.segment;
			const width = visibleWidth(grapheme);
			setHighlighted(width > 0 ? col >= startCol && col < endCol : highlighted);
			out += grapheme;
			col += width;
		}
		i += run.length;
	}
	if (highlighted) out += resetAnsi;
	return out;
}

export function isEditorBorderLine(line: string): boolean {
	const plain = stripAnsi(line).trimEnd();
	return /^─+$/u.test(plain) || /^─── [↑↓] \d+ more ─*$/u.test(plain);
}

export function splitDefaultEditor(lines: string[]): SplitRender {
	if (lines.length === 0) return { body: [""], completions: [] };

	let bottomBorderIndex = -1;
	for (let i = lines.length - 1; i >= 1; i--) {
		if (isEditorBorderLine(lines[i] ?? "")) {
			bottomBorderIndex = i;
			break;
		}
	}

	if (bottomBorderIndex === -1) {
		return { body: lines.length > 0 ? lines : [""], completions: [] };
	}

	const body = lines.slice(1, bottomBorderIndex);
	return {
		body: body.length > 0 ? body : [""],
		completions: lines.slice(bottomBorderIndex + 1),
	};
}

export function visibleBodySlice(body: string[], height: number, cursorMarker: string): BodySlice {
	if (body.length <= height) return { lines: body, start: 0 };

	const cursorIndex = body.findIndex((line) => line.includes(cursorMarker));
	if (cursorIndex === -1) {
		const start = Math.max(0, body.length - height);
		return { lines: body.slice(start), start };
	}

	const half = Math.floor(height / 2);
	const start = Math.max(0, Math.min(cursorIndex - half, body.length - height));
	return { lines: body.slice(start, start + height), start };
}

export function wrapLine(line: string, maxWidth: number): Array<{ text: string; startIndex: number; endIndex: number }> {
	if (!line || maxWidth <= 0) return [{ text: "", startIndex: 0, endIndex: 0 }];
	if (visibleWidth(line) <= maxWidth) return [{ text: line, startIndex: 0, endIndex: line.length }];

	const chunks: Array<{ text: string; startIndex: number; endIndex: number }> = [];
	const segments = [...segmenter.segment(line)];
	let chunkStart = 0;
	let currentWidth = 0;
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (const [i, seg] of segments.entries()) {
		const grapheme = seg.segment;
		const width = visibleWidth(grapheme);
		const charIndex = seg.index;
		const next = segments[i + 1];

		if (currentWidth + width > maxWidth) {
			if (wrapOppIndex > chunkStart && currentWidth - wrapOppWidth + width <= maxWidth) {
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		currentWidth += width;
		if (/\s/u.test(grapheme) && next && !/\s/u.test(next.segment)) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		}
	}

	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
	return chunks;
}

export function buildVisualMap(lines: string[], layoutWidth: number): VisualRow[] {
	const out: VisualRow[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const chunks = wrapLine(lines[lineIndex] ?? "", layoutWidth);
		for (const chunk of chunks) {
			out.push({
				logicalLine: lineIndex,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				text: chunk.text,
			});
		}
	}
	return out.length > 0 ? out : [{ logicalLine: 0, startIndex: 0, endIndex: 0, text: "" }];
}

export function ansiPrefixForStyledSentinel(styled: string, sentinel = "\u0000"): string {
	const index = styled.indexOf(sentinel);
	return index >= 0 ? styled.slice(0, index) : "";
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export type ParsedWheel = { direction: 1 | -1; x: number; y: number };

export function parseWheel(data: string): ParsedWheel | undefined {
	const match = SGR_MOUSE_RE.exec(data);
	if (!match) return undefined;

	const code = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	const final = match[4];
	if (!Number.isFinite(code) || final !== "M" || (code & 64) === 0) return undefined;

	const wheelButton = code & 3;
	if (wheelButton === 0) return { direction: 1, x, y };
	if (wheelButton === 1) return { direction: -1, x, y };
	return undefined;
}
