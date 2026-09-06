import { writeFile } from "node:fs/promises";
import {
	BashExecutionComponent,
	InteractiveMode,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { installExecutionRails, uninstallExecutionRails } from "../../components/executions";
import {
	getInteractiveModeConstructor,
	getTuiAltScreenConstructor,
} from "../../core/patching";

// TuiAltScreen methods that Rail retired on 0.85.1: the rail-click selection
// mouse hook, the deleted rail scrollbar (selection/scrollbar/renderer hooks)
// and the copy-feedback flash hook. The probe records each identity before and
// after installing the actual execution rails and asserts none are overwritten.
const RETIRED_TUI_METHODS = [
	"handleSelectionMouseEvent",
	"handleViewportInput",
	"applySelection",
	"handleScrollbarMouseEvent",
	"doRender",
	"requestRender",
	"flash",
] as const;

function prototypeMethods(prototype: any): Record<string, unknown> {
	return Object.fromEntries(RETIRED_TUI_METHODS.map((method) => [method, prototype[method]]));
}

export default async function bundleConstructorProbe(): Promise<void> {
	const outputPath = process.env["PI_RAIL_BUNDLE_PROBE_OUTPUT"];
	if (!outputPath) throw new Error("PI_RAIL_BUNDLE_PROBE_OUTPUT is required");

	const tuiPrototype = TuiAltScreen.prototype as any;
	const retiredBefore = prototypeMethods(tuiPrototype);
	const toolRenderBefore = ToolExecutionComponent.prototype.render;
	const toolHandleMouseBefore = ToolExecutionComponent.prototype.handleMouse;
	const bashRenderBefore = BashExecutionComponent.prototype.render;
	const bashHandleMouseBefore = BashExecutionComponent.prototype.handleMouse;
	const createResultRegionBefore = (ToolExecutionComponent.prototype as any).createResultRegion;

	const results: Record<string, unknown> = {
		tuiMatches: await getTuiAltScreenConstructor() === TuiAltScreen,
		interactiveMatches: await getInteractiveModeConstructor() === InteractiveMode,
	};

	await installExecutionRails({ fg: (_color: string, value: string) => value });
	try {
		results["retiredTuiMethodsUnchanged"] = Object.fromEntries(
			RETIRED_TUI_METHODS.map((method) => [method, tuiPrototype[method] === retiredBefore[method]]),
		);
		results["toolRenderPatched"] = ToolExecutionComponent.prototype.render !== toolRenderBefore;
		results["toolHandleMousePatched"] = ToolExecutionComponent.prototype.handleMouse !== toolHandleMouseBefore;
		results["bashRenderPatched"] = BashExecutionComponent.prototype.render !== bashRenderBefore;
		results["bashHandleMousePatched"] = BashExecutionComponent.prototype.handleMouse !== bashHandleMouseBefore;
		results["createResultRegionPatched"] = (ToolExecutionComponent.prototype as any).createResultRegion !== createResultRegionBefore;
	} finally {
		uninstallExecutionRails();
	}

	results["toolRenderRestored"] = ToolExecutionComponent.prototype.render === toolRenderBefore;
	results["toolHandleMouseRestored"] = ToolExecutionComponent.prototype.handleMouse === toolHandleMouseBefore;
	results["bashRenderRestored"] = BashExecutionComponent.prototype.render === bashRenderBefore;
	results["bashHandleMouseRestored"] = BashExecutionComponent.prototype.handleMouse === bashHandleMouseBefore;
	results["createResultRegionRestored"] = (ToolExecutionComponent.prototype as any).createResultRegion === createResultRegionBefore;

	await writeFile(outputPath, JSON.stringify(results), "utf8");
}