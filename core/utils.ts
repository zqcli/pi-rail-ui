import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const OSC133_ZONE_START = "\x1b]133;A\x07";
export const OSC133_ZONE_END = "\x1b]133;B\x07";
export const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const ANSI_PATTERN = "\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1b\\\\)|_[^\\x07]*(?:\\x07|\\x1b\\\\))";
export const ANSI_RE = new RegExp(ANSI_PATTERN, "g");
export const SGR_RESET = "\x1b[0m";
export const SGR_RESET_RE = /\x1b\[0m/g;

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
