import type { ColorReference, ColorSpec, RgbTuple, TextColorTarget, ThemeLike } from "./types";

function rgbTuple(spec: ColorSpec, label: string): RgbTuple {
	const rgb = spec?.rgb;
	if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
		throw new Error(`Invalid RGB color for ${label} in pi-rail-ui/ui-style.json`);
	}
	return rgb as RgbTuple;
}

function rgbAnsi(kind: 38 | 48, spec: ColorSpec, label: string): string {
	const [r, g, b] = rgbTuple(spec, label);
	return `\x1b[${kind};2;${r};${g};${b}m`;
}

export function fg(spec: ColorSpec, label: string): string {
	return rgbAnsi(38, spec, label);
}

export function bg(spec: ColorSpec, label: string): string {
	return rgbAnsi(48, spec, label);
}

export function isThemeReference(spec: unknown): spec is `theme:${string}` {
	return typeof spec === "string" && spec.startsWith("theme:");
}

export function resolveBackground(spec: ColorReference, editorBackground: string): string {
	if (spec === "transparent") return "";
	if (spec === "editor.background") return editorBackground;
	if (spec === "editor.rail" || isThemeReference(spec)) return "";
	return bg(spec, "background");
}

export function resolveTextColor(spec: ColorReference, refs: { editorRail: string }): TextColorTarget {
	if (spec === "editor.rail") return { ansi: refs.editorRail };
	if (isThemeReference(spec)) return { themeKey: spec.slice("theme:".length) };
	if (spec === "transparent" || spec === "editor.background") return {};
	return { ansi: fg(spec, "text color") };
}

export function applyTextColor(theme: ThemeLike | undefined, color: TextColorTarget, value: string): string {
	if (color.themeKey && theme) return theme.fg(color.themeKey, value);
	if (color.ansi) return `${color.ansi}${value}`;
	return value;
}

export function railAnsiForTheme(theme: ThemeLike, color: TextColorTarget, sentinel = "\u0000"): string | undefined {
	if (!color.themeKey) return color.ansi;
	const styled = theme.fg(color.themeKey, sentinel);
	const index = styled.indexOf(sentinel);
	return index >= 0 ? styled.slice(0, index) : undefined;
}
