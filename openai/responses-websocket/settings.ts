import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const RAIL_RESPONSES_WEBSOCKET_SETTINGS_VERSION = 1;
export const RAIL_RESPONSES_WEBSOCKET_SETTINGS_DIR = "rail-openai-responses-ws";

export interface RailResponsesWebSocketRoute {
	provider: string;
	endpoint: string;
	models: string[];
}

export interface RailResponsesWebSocketSettings {
	routes: RailResponsesWebSocketRoute[];
	path: string;
	warning?: string;
}

export function railResponsesWebSocketSettingsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, RAIL_RESPONSES_WEBSOCKET_SETTINGS_DIR, "settings.json");
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRoute(value: unknown): RailResponsesWebSocketRoute | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const provider = nonEmptyString(record["provider"]);
	const endpoint = nonEmptyString(record["endpoint"]);
	if (!provider || !endpoint) return undefined;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return undefined;
	}
	if (url.protocol !== "wss:" || !url.pathname.endsWith("/responses")) return undefined;
	const models = Array.isArray(record["models"])
		? record["models"].map(nonEmptyString).filter((item): item is string => item !== undefined)
		: [];
	if (models.length === 0) return undefined;
	return { provider, endpoint: url.toString(), models: [...new Set(models)] };
}

export function readRailResponsesWebSocketSettings(agentDir?: string): RailResponsesWebSocketSettings {
	const path = railResponsesWebSocketSettingsPath(agentDir);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { routes: [], path };
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown> | null;
		if (parsed?.["version"] !== RAIL_RESPONSES_WEBSOCKET_SETTINGS_VERSION || !Array.isArray(parsed["routes"])) {
			return { routes: [], path, warning: "Rail Responses WebSocket settings are unreadable; no routes installed" };
		}
		const routes = parsed["routes"].map(parseRoute);
		if (routes.some((route) => route === undefined)) {
			return { routes: [], path, warning: "Rail Responses WebSocket settings contain an invalid route; no routes installed" };
		}
		return { routes: routes as RailResponsesWebSocketRoute[], path };
	} catch {
		return { routes: [], path, warning: "Rail Responses WebSocket settings are not valid JSON; no routes installed" };
	}
}

export function routeMatchesModel(route: RailResponsesWebSocketRoute, provider: string, modelId: string): boolean {
	return route.provider === provider && (route.models.includes("*") || route.models.includes(modelId));
}

export function hasRailResponsesWebSocketRoute(provider: string, modelId: string, agentDir?: string): boolean {
	return readRailResponsesWebSocketSettings(agentDir).routes.some((route) => routeMatchesModel(route, provider, modelId));
}