import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";

const fixture = fileURLToPath(new URL("../fixtures/fake-pi-rpc.mjs", import.meta.url));

test("PiRpcProcessTransport correlates responses and emits independent events", async () => {
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [fixture],
		cwd: process.cwd(),
	});
	const eventTypes: string[] = [];
	const settled = new Promise<void>((resolve) => {
		transport.onEvent((event) => {
			eventTypes.push(event.type);
			if (event.type === "agent_settled") resolve();
		});
	});

	await transport.start();
	const state = await transport.request({ type: "get_state" });
	await transport.request({ type: "prompt", message: "hello" });
	await settled;

	assert.deepEqual(state, {
		sessionId: "fixture-session",
		sessionFile: "/tmp/fixture.jsonl",
		isStreaming: false,
		model: { provider: "cus-resp", id: "gpt-5.6-luna", contextWindow: 128000 },
	});
	assert.deepEqual(eventTypes, ["agent_start", "message_end", "agent_settled"]);
	await transport.stop();
});

test("PiRpcProcessTransport surfaces RPC failures", async () => {
	const transport = new PiRpcProcessTransport({ command: process.execPath, args: [fixture], cwd: process.cwd() });
	await transport.start();
	await assert.rejects(() => transport.request({ type: "unknown" }), /unsupported/);
	await transport.stop();
});

test("PiRpcProcessTransport waits for exit after forced termination before releasing ownership", { timeout: 10_000 }, async () => {
	const transport = new PiRpcProcessTransport({ command: process.execPath, cwd: process.cwd(), args: ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log(JSON.stringify({type:"ready", pid:process.pid}));'] });
	const ready = new Promise<number>((resolve) => transport.onEvent((event) => { if (event.type === "ready") resolve(event["pid"] as number); }));
	await transport.start();
	const pid = await ready;
	await Promise.all([transport.stop(), transport.stop()]);
	assert.throws(() => process.kill(pid, 0), (error: any) => error.code === "ESRCH", "stop must wait until the child is reaped");
});

test("PiRpcProcessTransport rejects requests once shutdown starts", async () => {
	const transport = new PiRpcProcessTransport({ command: process.execPath, args: [fixture], cwd: process.cwd() });
	await transport.start();
	const stopping = transport.stop();
	await assert.rejects(() => transport.request({ type: "get_state" }), /not running/);
	await stopping;
});
