import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "rail-oai-fast";
const SUPPORTED_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
]);

type NativeFastModel = {
	api: string;
	id: string;
	samplingParams?: Record<string, unknown>;
};

type AppliedFastMode = {
	model: NativeFastModel;
	originalSamplingParams: Record<string, unknown> | undefined;
};

let enabled = false;
let activeForCurrentModel = false;
let appliedFastMode: AppliedFastMode | undefined;

export function supportsNativeFastMode(model: NativeFastModel | undefined): model is NativeFastModel {
	return model !== undefined && SUPPORTED_APIS.has(model.api);
}

export function applyNativeFastMode(model: NativeFastModel | undefined): boolean {
	if (!supportsNativeFastMode(model)) return false;
	if (appliedFastMode?.model === model && model.samplingParams?.["service_tier"] === "priority") return true;

	restoreNativeFastMode();
	appliedFastMode = { model, originalSamplingParams: model.samplingParams };
	model.samplingParams = { ...model.samplingParams, service_tier: "priority" };
	return true;
}

export function restoreNativeFastMode(): void {
	const applied = appliedFastMode;
	if (!applied) return;
	if (applied.originalSamplingParams === undefined) delete applied.model.samplingParams;
	else applied.model.samplingParams = applied.originalSamplingParams;
	appliedFastMode = undefined;
}

export function railFastFooterLabel(): string | undefined {
	if (!enabled) return undefined;
	return activeForCurrentModel ? "FAST" : "FAST inactive";
}

function updateStatus(ctx: ExtensionContext): void {
	const model = ctx.model as NativeFastModel | undefined;
	if (!enabled || !supportsNativeFastMode(model)) {
		restoreNativeFastMode();
		activeForCurrentModel = false;
	} else {
		activeForCurrentModel = applyNativeFastMode(model);
	}
	if (!ctx.hasUI) return;
	const status = enabled
		? activeForCurrentModel ? "FAST" : "FAST (inactive)"
		: undefined;
	ctx.ui.setStatus(STATUS_KEY, status);
}

function notifyStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!enabled) {
		ctx.ui.notify("Rail fast mode disabled.", "info");
		return;
	}

	const suffix = activeForCurrentModel ? "" : " (inactive for current model)";
	ctx.ui.notify(`Rail fast mode enabled${suffix}.`, "info");
}

export function installRailFast(pi: ExtensionAPI): void {
	pi.registerCommand("rail-oai-fast", {
		description: "Toggle Pi native OpenAI fast mode for the current model",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") enabled = true;
			else if (action === "off") enabled = false;
			else if (action !== "status") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /rail-oai-fast on|off|status", "warning");
				return;
			}

			updateStatus(ctx);
			notifyStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = false;
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		restoreNativeFastMode();
		enabled = false;
		activeForCurrentModel = false;
	});
}
