import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	hasRailResponsesWebSocketRoute,
	railResponsesWebSocketSettingsPath,
	readRailResponsesWebSocketSettings,
} from "../../openai/responses-websocket/settings";

test("Responses WebSocket settings accept an exact WSS responses route", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-responses-ws-settings-"));
	const path = railResponsesWebSocketSettingsPath(agentDir);
	await mkdir(join(agentDir, "rail-openai-responses-ws"), { recursive: true });
	await writeFile(path, JSON.stringify({
		version: 1,
		routes: [{
			provider: "cus-resp",
			endpoint: "wss://ai.example.test/v1/responses",
			models: ["gpt-test", "gpt-test"],
		}],
	}));
	const settings = readRailResponsesWebSocketSettings(agentDir);
	assert.equal(settings.warning, undefined);
	assert.deepEqual(settings.routes, [{
		provider: "cus-resp",
		endpoint: "wss://ai.example.test/v1/responses",
		models: ["gpt-test"],
	}]);
	assert.equal(hasRailResponsesWebSocketRoute("cus-resp", "gpt-test", agentDir), true);
	assert.equal(hasRailResponsesWebSocketRoute("cus-resp", "other", agentDir), false);
});

test("Responses WebSocket settings fail closed for non-WSS endpoints", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-responses-ws-invalid-"));
	const path = railResponsesWebSocketSettingsPath(agentDir);
	await mkdir(join(agentDir, "rail-openai-responses-ws"), { recursive: true });
	await writeFile(path, JSON.stringify({
		version: 1,
		routes: [{ provider: "cus-resp", endpoint: "https://ai.example.test/v1/responses", models: ["gpt-test"] }],
	}));
	const settings = readRailResponsesWebSocketSettings(agentDir);
	assert.deepEqual(settings.routes, []);
	assert.match(settings.warning ?? "", /invalid route/u);
});