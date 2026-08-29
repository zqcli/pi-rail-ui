import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedSearchProviderCapture } from "../openai/hosted-search-capture";
import {
	HOSTED_SEARCH_ENTRY_TYPE,
	restoreHostedSearchActivities,
} from "../openai/hosted-search-activity";

const STATUS_KEY = "rail-oai-search";
const SOURCE_INCLUDE = "web_search_call.action.sources";
const KNOWN_NON_RESPONSES_APIS = new Set([
	"openai-completions",
	"mistral-conversations",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"pi-messages",
]);

export type RailOaiSearchMode = "live" | "cached" | "off";

type SearchModel = {
	id?: string;
	name?: string;
	provider?: string;
	api?: string;
};

type JsonObject = Record<string, unknown>;

let mode: RailOaiSearchMode = "off";
let activeForCurrentModel = false;
let turnActive = false;
let searchRunning = false;

function isRecord(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResponsesPayload(payload: unknown): payload is JsonObject {
	if (!isRecord(payload)) return false;
	const input = payload["input"];
	return typeof input === "string" || Array.isArray(input);
}

function isLocalWebSearchFunction(tool: unknown): boolean {
	if (!isRecord(tool) || tool["type"] !== "function") return false;
	if (tool["name"] === "web_search") return true;
	const definition = tool["function"];
	return isRecord(definition) && definition["name"] === "web_search";
}

function isHostedWebSearchTool(tool: unknown): boolean {
	if (!isRecord(tool) || typeof tool["type"] !== "string") return false;
	return /^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/.test(tool["type"]);
}

function normalizeToolChoice(toolChoice: unknown): unknown {
	if (!isRecord(toolChoice)) return toolChoice;
	if (isLocalWebSearchFunction(toolChoice) || isHostedWebSearchTool(toolChoice)) return "auto";
	if (toolChoice["type"] !== "allowed_tools" || !Array.isArray(toolChoice["tools"])) return toolChoice;

	let replacedSearchTool = false;
	const tools = toolChoice["tools"].filter((tool) => {
		if (!isLocalWebSearchFunction(tool) && !isHostedWebSearchTool(tool)) return true;
		replacedSearchTool = true;
		return false;
	});
	if (!replacedSearchTool) return toolChoice;
	tools.push({ type: "web_search" });
	return { ...toolChoice, tools };
}

export function isGptModel(model: SearchModel | undefined): boolean {
	if (!model) return false;
	return `${model.id ?? ""} ${model.name ?? ""}`.toLowerCase().includes("gpt");
}

export function transformNativeSearchPayload(
	model: SearchModel | undefined,
	searchMode: RailOaiSearchMode,
	payload: unknown,
): unknown {
	if (searchMode === "off" || !isGptModel(model) || !isResponsesPayload(payload)) return payload;

	if (payload["tools"] !== undefined && !Array.isArray(payload["tools"])) return payload;
	if (payload["include"] != null && !Array.isArray(payload["include"])) return payload;

	let hostedTool: JsonObject | undefined;
	const tools = (payload["tools"] ?? []).filter((tool) => {
		if (isLocalWebSearchFunction(tool)) return false;
		if (!isHostedWebSearchTool(tool)) return true;
		if (!hostedTool) hostedTool = tool;
		return false;
	});
	const {
		type: _type,
		external_web_access: _externalWebAccess,
		indexed_web_access: _indexedWebAccess,
		...hostedOptions
	} = hostedTool ?? {};
	tools.push({
		...hostedOptions,
		type: "web_search",
		external_web_access: searchMode === "live",
	});

	const include = (payload["include"] ?? []).filter((item) => item !== SOURCE_INCLUDE);
	include.push(SOURCE_INCLUDE);

	return {
		...payload,
		tools,
		include,
		...(payload["tool_choice"] === undefined
			? {}
			: { tool_choice: normalizeToolChoice(payload["tool_choice"]) }),
	};
}

function isActiveSearchModel(model: SearchModel | undefined): boolean {
	return isGptModel(model) && !KNOWN_NON_RESPONSES_APIS.has(model?.api?.toLowerCase() ?? "");
}

function updateStatus(ctx: ExtensionContext): void {
	activeForCurrentModel = mode !== "off" && isActiveSearchModel(ctx.model);
	if (!ctx.hasUI) return;

	const status = searchRunning
		? "SEARCHING"
		: mode === "off"
		? undefined
		: `SEARCH ${mode.toUpperCase()}${activeForCurrentModel ? "" : " (inactive)"}`;
	ctx.ui.setStatus(STATUS_KEY, status);
}

function notifyStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (mode === "off") {
		ctx.ui.notify("Rail native search disabled.", "info");
		return;
	}

	const suffix = activeForCurrentModel ? "" : " (inactive for current model)";
	ctx.ui.notify(`Rail native search set to ${mode}${suffix}.`, "info");
}

export function installRailOaiSearch(pi: ExtensionAPI): void {
	const capture = new HostedSearchProviderCapture(pi, {
		isEnabled: (model) => mode !== "off" && isGptModel(model),
		onActivityChanged: (activity, ctx) => {
			searchRunning = activity.observed && !activity.terminal;
			updateStatus(ctx);
		},
	});

	pi.registerCommand("rail-oai-search", {
		description: "Set GPT native web search mode",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action !== "live" && action !== "cached" && action !== "off") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /rail-oai-search live|cached|off", "warning");
				return;
			}

			await ctx.waitForIdle();
			mode = action;
			searchRunning = false;
			capture.sync(ctx, mode !== "off" && isActiveSearchModel(ctx.model));
			updateStatus(ctx);
			notifyStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		mode = "off";
		turnActive = false;
		searchRunning = false;
		restoreHostedSearchActivities(ctx.sessionManager.getBranch());
		capture.sync(ctx, false);
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreHostedSearchActivities(ctx.sessionManager.getBranch());
	});

	pi.on("model_select", async (_event, ctx) => {
		searchRunning = false;
		capture.sync(ctx, mode !== "off" && isActiveSearchModel(ctx.model));
		updateStatus(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnActive = true;
		capture.sync(ctx, mode !== "off" && isActiveSearchModel(ctx.model));
		capture.startTurn();
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") capture.associateMessage(event.message);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const snapshot = await capture.finishTurn(event.message);
		searchRunning = false;
		updateStatus(ctx);
		if (snapshot) pi.appendEntry(HOSTED_SEARCH_ENTRY_TYPE, snapshot);
	});

	pi.on("turn_end", async (_event, ctx) => {
		turnActive = false;
		searchRunning = false;
		updateStatus(ctx);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const transformed = transformNativeSearchPayload(ctx.model, turnActive ? mode : "off", event.payload);
		return transformed === event.payload ? undefined : transformed;
	});

	pi.on("session_shutdown", async () => {
		mode = "off";
		activeForCurrentModel = false;
		turnActive = false;
		searchRunning = false;
		capture.shutdown();
	});
}
