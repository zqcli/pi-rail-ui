import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "railfast";
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const SUPPORTED_MODELS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

let enabled = false;
let activeForCurrentModel = false;

type ModelRef = {
	api: string;
	id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsRailFastModel(model: ModelRef | undefined): boolean {
	return model !== undefined && SUPPORTED_APIS.has(model.api) && SUPPORTED_MODELS.has(model.id);
}

export function withPriorityServiceTier(payload: unknown): Record<string, unknown> | undefined {
	if (!isRecord(payload)) return undefined;
	return { ...payload, service_tier: "priority" };
}

export function railFastFooterLabel(): string | undefined {
	if (!enabled) return undefined;
	return activeForCurrentModel ? "FAST" : "FAST inactive";
}

function updateStatus(ctx: ExtensionContext): void {
	activeForCurrentModel = supportsRailFastModel(ctx.model);
	if (!ctx.hasUI) return;
	const status = enabled
		? activeForCurrentModel ? "FAST" : "FAST (inactive)"
		: undefined;
	ctx.ui.setStatus(STATUS_KEY, status);
}

function notifyStatus(ctx: ExtensionContext): void {
	if (!enabled) {
		ctx.ui.notify("Rail fast mode disabled.", "info");
		return;
	}

	const suffix = activeForCurrentModel ? "" : " (inactive for current model)";
	ctx.ui.notify(`Rail fast mode enabled${suffix}.`, "info");
}

export function installRailFast(pi: ExtensionAPI): void {
	pi.registerCommand("railfast", {
		description: "Enable, disable, or inspect OpenAI fast mode",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") enabled = true;
			else if (action === "off") enabled = false;
			else if (action !== "status") {
				ctx.ui.notify("Usage: /railfast on|off|status", "warning");
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

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsRailFastModel(ctx.model)) return;
		return withPriorityServiceTier(event.payload);
	});
}
