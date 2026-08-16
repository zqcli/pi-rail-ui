import * as fs from "node:fs";
import { resolveStyleConfig } from "./resolved-style";
import type { StyleFile } from "./types";

export type { EditorHeightPolicy, EditorSurfaceStyle, RailSurfaceStyle } from "./types";
export type { ToolExecutionState, ToolExecutionStateStyles, ToolExecutionTextStyle } from "./types";
export type { TextColorTarget, ThemeLike, RailSectionKind, RailSectionSelectionMode } from "./types";
export type { AppLayout, UserMessageLayout, SlashCommandLayout, FooterStyle, BashExecutionLayout } from "./types";
export type { RailSectionSelectionConfig, RailSectionStyleConfig, RailSectionSpacingConfig } from "./types";
export type { RailSectionLayoutConfig, RailSectionResolvedConfig, EditorPasteMarkerStyle } from "./types";
export type { ConversationScrollMode, ConversationScrollLayout, ConversationScrollbarStyle } from "./types";
export type { FooterLayout } from "./types";
export { applyTextColor, railAnsiForTheme } from "./colors";
export { resolveStyleConfig, type ResolvedStyleConfig } from "./resolved-style";

function readStyleFile(): StyleFile {
	const url = new URL("../ui-style.json", import.meta.url);
	return JSON.parse(fs.readFileSync(url, "utf8")) as StyleFile;
}

const resolved = resolveStyleConfig(readStyleFile());

export const APP_LAYOUT = resolved.APP_LAYOUT;

export function appLeftGutterWidth(width?: number): number {
	const gutter = APP_LAYOUT.leftGutterWidth;
	return width === undefined ? gutter : Math.min(gutter, Math.max(0, Math.round(width) - 1));
}

export const CONVERSATION_SELECTION_STYLE = resolved.CONVERSATION_SELECTION_STYLE;
export const RAIL_EDITOR_SURFACE_STYLE = resolved.RAIL_EDITOR_SURFACE_STYLE;
export const RAIL_EDITOR_HEIGHT = resolved.RAIL_EDITOR_HEIGHT;
export const EDITOR_MOUSE_TRACKING_ENABLED = resolved.EDITOR_MOUSE_TRACKING_ENABLED;
export const EDITOR_PASTE_MARKER_STYLE = resolved.EDITOR_PASTE_MARKER_STYLE;
export const CONVERSATION_SCROLL_LAYOUT = resolved.CONVERSATION_SCROLL_LAYOUT;
export const CONVERSATION_SCROLLBAR_STYLE = resolved.CONVERSATION_SCROLLBAR_STYLE;
export const RAIL_EDITOR_STYLE = resolved.RAIL_EDITOR_STYLE;
export const TOOL_EXECUTION_STATE_STYLES = resolved.TOOL_EXECUTION_STATE_STYLES;
export const TOOL_EXECUTION_TEXT_STYLE = resolved.TOOL_EXECUTION_TEXT_STYLE;
export const THINKING_RAIL_COLOR = resolved.THINKING_RAIL_COLOR;
export const RAIL_THINKING_STYLE = resolved.RAIL_THINKING_STYLE;
export const USER_MESSAGE_LAYOUT = resolved.USER_MESSAGE_LAYOUT;
export const RAIL_USER_MESSAGE_STYLE = resolved.RAIL_USER_MESSAGE_STYLE;
export const SLASH_COMMAND_LAYOUT = resolved.SLASH_COMMAND_LAYOUT;
export const BASH_EXECUTION_LAYOUT = resolved.BASH_EXECUTION_LAYOUT;
export const BASH_EXECUTION_RAIL_COLOR = resolved.BASH_EXECUTION_RAIL_COLOR;
export const RAIL_BASH_EXECUTION_STYLE = resolved.RAIL_BASH_EXECUTION_STYLE;
export const RAIL_SECTION_CONFIGS = resolved.RAIL_SECTION_CONFIGS;

export function railSectionConfig(kind: keyof typeof RAIL_SECTION_CONFIGS) {
	return RAIL_SECTION_CONFIGS[kind] ?? RAIL_SECTION_CONFIGS.custom;
}

export const RAIL_FOOTER_STYLE = resolved.RAIL_FOOTER_STYLE;
export const FOOTER_LAYOUT = resolved.FOOTER_LAYOUT;
