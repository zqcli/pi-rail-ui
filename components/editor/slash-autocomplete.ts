import { type Component } from "@earendil-works/pi-tui";
import { SLASH_COMMAND_LAYOUT } from "../../config";
import { RailOverlayPanel } from "../../rail/rail-overlay";
import { EditorSurfaceRenderer, railSelectorOutputSurface } from "../../rail/rail-surface";

/**
 * Non-capturing overlay body for slash-command autocomplete. It intentionally
 * reads the current SelectList from the editor on each render so selection
 * movement updates without recreating the overlay handle.
 */
export class SlashCommandOverlay extends RailOverlayPanel {
	constructor(
		getList: () => Component | undefined,
		getMaxRows: () => number,
		surface: EditorSurfaceRenderer = railSelectorOutputSurface,
	) {
		super({
			surface,
			maxRows: getMaxRows,
			textGapWidth: SLASH_COMMAND_LAYOUT.textGapWidth,
			renderBody: (contentWidth) => getList()?.render(contentWidth) ?? [],
		});
	}
}
