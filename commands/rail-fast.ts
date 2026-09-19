import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isGptModel } from "../openai/model-eligibility";

const STATUS_KEY = "rail-oai-fast";
const INSTALL_EVENT = "rail-oai-fast:install";
export const RAIL_FAST_MODE_FLAG = "rail-oai-fast-enabled";
const SUPPORTED_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
]);

export type NativeFastModel = {
	api: string;
	id: string;
	name?: string;
	samplingParams?: Record<string, unknown>;
};

let enabled = false;
let activeForCurrentModel = false;

type InstallClaim = { claimed: boolean };

function claimSharedInstall(pi: ExtensionAPI): boolean {
	const claim: InstallClaim = { claimed: false };
	pi.events.emit(INSTALL_EVENT, claim);
	if (claim.claimed) return false;
	pi.events.on(INSTALL_EVENT, (data) => {
		if (data && typeof data === "object" && "claimed" in data) (data as InstallClaim).claimed = true;
	});
	return true;
}

export function railFastExtensionPath(): string {
	return fileURLToPath(new URL("./rail-fast-standalone.ts", import.meta.url));
}

export function supportsNativeFastMode(model: NativeFastModel | undefined): model is NativeFastModel {
	return model !== undefined && SUPPORTED_APIS.has(model.api);
}

export function supportsNativeGptFastMode(model: NativeFastModel | undefined): model is NativeFastModel {
	return supportsNativeFastMode(model) && isGptModel(model);
}

/**
 * Fast mode is injected into each provider payload instead of mutating the
 * active model's samplingParams. Pi refreshes the active model object whenever
 * an extension re-registers its provider (hosted search does this on model
 * switches), which silently drops model mutations and would leave a switched
 * back GPT request without service_tier. Injecting per payload also preserves
 * the model's original sampling parameters untouched.
 */
function withNativeFastServiceTier(payload: unknown): unknown {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	if (record["service_tier"] === "priority") return undefined;
	return { ...record, service_tier: "priority" };
}

export function railFastFooterLabel(): string | undefined {
	if (!enabled) return undefined;
	return activeForCurrentModel ? "FAST" : "FAST inactive";
}

function updateStatus(ctx: ExtensionContext): void {
	const model = ctx.model as NativeFastModel | undefined;
	activeForCurrentModel = enabled && supportsNativeGptFastMode(model);
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
	if (!claimSharedInstall(pi)) return;
	pi.registerFlag?.(RAIL_FAST_MODE_FLAG, {
		description: "Enable Rail native fast mode for this child process",
		type: "boolean",
	});
	pi.registerCommand("rail-oai-fast", {
		description: "Toggle Pi native OpenAI fast mode for the current model",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") {
				enabled = true;
			} else if (action === "off") {
				enabled = false;
			}
			else if (action !== "status") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /rail-oai-fast on|off|status", "warning");
				return;
			}

			updateStatus(ctx);
			notifyStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = pi.getFlag?.(RAIL_FAST_MODE_FLAG) === true;
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!enabled || !supportsNativeGptFastMode(ctx.model as NativeFastModel | undefined)) return undefined;
		return withNativeFastServiceTier(event.payload);
	});

	pi.on("session_shutdown", async () => {
		enabled = false;
		activeForCurrentModel = false;
	});
}
