import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { TeamRpcV2Connection } from "../../tools/subagents/team-rpc-v2";
import { TeamRuntime } from "../../tools/subagents/team-runtime";
import type { ChildRequestFrame, PrivateReply } from "../../tools/subagents/team-protocol";
import type { RpcEvent } from "../../tools/subagents/rpc-worker";
import { loadoutFor } from "../fixtures/team-loadout";

const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("../../tools/subagents/team-extension-v2.ts", import.meta.url));
const provider = fileURLToPath(new URL("../fixtures/team-loadout-provider.mjs", import.meta.url));

for (const restricted of [true, false]) test(`real Pi codemode and tool_search ${restricted ? "cannot bypass a Team member allowlist" : "preserve unrestricted deferred access"}`, { timeout: 20_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "rail-team-loadout-"));
	const events: RpcEvent[] = [];
	const transport = new PiRpcProcessTransport({ command: process.execPath,
		args: [cli, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
			"-e", "builtin:codemode", "-e", "builtin:tool-search", "-e", provider, "-e", extension,
			"--model", "rail-team-loadout/probe", "--mode", "rpc", "--session-dir", dir],
		cwd: dir, env: { PATH: process.env["PATH"] ?? "", HOME: dir, PI_CODING_AGENT_DIR: dir,
			PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
	});
	t.after(async () => { await transport.stop(); await rm(dir, { recursive: true, force: true }); });
	await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultTools: ["codemode", "tool_search"], compaction: { enabled: false }, retry: { enabled: false } }));
	transport.onEvent((event) => events.push(event));
	await transport.start();
	const runtime = new TeamRuntime();
	const plan = runtime.prepare({ members: [{ alias: "lead", roleDescription: "Verify tool restrictions." },
		{ alias: "worker", roleDescription: "Remain idle while the lead probes the native tools." }], lead: "lead",
		brief: { goal: "Keep the native Team boundaries while executing allowed tools." }, timeoutSeconds: null });
	runtime.launch(plan.teamId);
	const activation = runtime.takeNextActivation(plan.teamId)!;
	const { binding, scope } = activation;
	const frames: ChildRequestFrame[] = [];
	const connection = new TeamRpcV2Connection(transport, binding,
		loadoutFor(binding.memberId, restricted ? ["codemode", "tool_search", "allowed_code", "allowed_deferred"] : null),
		() => undefined);
	const completion = await connection.sendActivation(activation, async (frame, intentId): Promise<PrivateReply> => {
		frames.push(frame);
		const request = frame.request;
		switch (request.action) {
			case "input_ready":
				assert.equal(runtime.inputReady(binding, scope.activationId, request.deliveryId).ok, true);
				return { kind: "ack" };
			case "provider_gate": return { kind: "gate", decision: await runtime.waitAtProviderGate(binding, scope) };
			case "tool_gate": return { kind: "gate", decision: runtime.gate(binding, scope, "tool_gate", request.toolCallId, request.toolName, request.endIntent, request.inputHash) };
			case "tool_result":
				assert.equal(runtime.toolResult(binding, scope, request.toolCallId, request.toolName, request.isError).ok, true);
				return { kind: "ack" };
			case "business": return { kind: "business", reply: runtime.handleAction(binding, scope, frame.sequence, frame.rpcRequestId, request.args, intentId) };
			case "boundary": return { kind: "ack" };
		}
	});
	assert.equal(completion.status, "success", JSON.stringify({ completion,
		toolResults: events.filter((event) => event.type === "tool_execution_end").map((event) => ({ name: event["toolName"], result: event["result"] })) }));
	assert.ok(completion.appliedToolCallId, "only the final model-issued Team yield commits the end intent");
	assert.equal(runtime.nativeSettled(binding, scope.activationId, completion).ok, true);
	await connection.deactivate(activation);
	await connection.close();
	const entries = events.filter((event) => event.type === "entry_appended").map((event) => event["entry"] as any);
	const executed = entries.filter((entry) => entry.customType === "team-loadout-executed").map((entry) => entry.data.name);
	assert.deepEqual(executed, restricted ? ["allowed_code", "allowed_deferred"]
		: ["allowed_code", "denied_code", "allowed_deferred", "denied_deferred", "denied_deferred"]);
	assert.deepEqual(entries.filter((entry) => entry.customType === "team-loadout-indirect-team").map((entry) => entry.data), [{ isError: true }]);
	const providerCalls = entries.filter((entry) => entry.customType === "team-loadout-provider");
	assert.equal(providerCalls.length, 4);
	assert.equal(providerCalls[0].data.declared.includes("denied_deferred"), false);
	assert.equal(providerCalls[2].data.declared.includes("denied_deferred"), true, "tool_search actually widened Pi's active declarations");
	assert.equal(frames.filter((frame) => frame.request.action === "business").length, 1);
	const nested = events.filter((event) => event.type === "tool_execution_end" && event["parentToolCallId"]);
	for (const name of ["allowed_code", "allowed_deferred"]) assert.ok(nested.some((event) => event["toolName"] === name && event["isError"] === false));
	for (const name of ["denied_code", "denied_deferred"]) assert.ok(nested.some((event) => event["toolName"] === name && event["isError"] === restricted));
	assert.ok(nested.some((event) => event["toolName"] === "subagent" && event["isError"] === true));
	assert.ok(nested.some((event) => event["toolName"] === "team" && event["isError"] === true));
	assert.equal(events.some((event) => event.type === "extension_error"), false);
});
