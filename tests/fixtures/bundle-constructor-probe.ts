import { writeFile } from "node:fs/promises";
import {
	BashExecutionComponent,
	InteractiveMode,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { installExecutionRails, uninstallExecutionRails } from "../../components/executions";
import { installFooterCopyFeedback, uninstallFooterCopyFeedback } from "../../components/footer";
import {
	getInteractiveModeConstructor,
	getTuiAltScreenConstructor,
} from "../../core/patching";
import { installRailScrollbar, uninstallRailScrollbar } from "../../rail/rail-scrollbar";

export default async function bundleConstructorProbe(): Promise<void> {
	const outputPath = process.env["PI_RAIL_BUNDLE_PROBE_OUTPUT"];
	if (!outputPath) throw new Error("PI_RAIL_BUNDLE_PROBE_OUTPUT is required");

	const tuiPrototype = TuiAltScreen.prototype as any;
	const originalApplySelection = tuiPrototype.applySelection;
	const originalFlash = tuiPrototype.flash;
	const originalSelectionMouse = tuiPrototype.handleSelectionMouseEvent;
	const originalToolRender = ToolExecutionComponent.prototype.render;
	const originalBashRender = BashExecutionComponent.prototype.render;
	try {
		await installRailScrollbar();
		const scrollbarPatched = tuiPrototype.applySelection !== originalApplySelection;
		uninstallRailScrollbar();

		await installFooterCopyFeedback();
		const copyFeedbackPatched = tuiPrototype.flash !== originalFlash;
		uninstallFooterCopyFeedback();

		await installExecutionRails({ fg: (_color: string, value: string) => value });
		const sectionClickPatched = tuiPrototype.handleSelectionMouseEvent !== originalSelectionMouse;
		const toolRenderPatched = ToolExecutionComponent.prototype.render !== originalToolRender;
		const bashRenderPatched = BashExecutionComponent.prototype.render !== originalBashRender;
		uninstallExecutionRails();

		await writeFile(outputPath, JSON.stringify({
			tuiMatches: await getTuiAltScreenConstructor() === TuiAltScreen,
			interactiveMatches: await getInteractiveModeConstructor() === InteractiveMode,
			scrollbarPatched,
			copyFeedbackPatched,
			sectionClickPatched,
			toolRenderPatched,
			bashRenderPatched,
		}), "utf8");
	} finally {
		uninstallExecutionRails();
		uninstallFooterCopyFeedback();
		uninstallRailScrollbar();
	}
}