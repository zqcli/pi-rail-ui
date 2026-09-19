import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { RpcSessionWorker, buildRpcWorkerArgs } from "../../tools/subagents/rpc-worker";
import { createStatelessAgentRunner } from "../../tools/subagents/stateless-runner";
import { railFastExtensionPath } from "../../commands/rail-fast";
import { railOaiSearchExtensionPath } from "../../commands/rail-oai-search";
import { HostedSearchActivity, HostedSearchSseObserver } from "../../openai/hosted-search-activity";
import type { RailModelRef } from "../../tools/subagents/models";
import type { WorkerStartSpec } from "../../tools/subagents/session-broker";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const providerFixture = fileURLToPath(new URL("../fixtures/rail-fast-provider.mjs", import.meta.url));
const railExtension = fileURLToPath(new URL("../../index.ts", import.meta.url));
const model: RailModelRef = { provider: "rail-fast-probe", modelId: "gpt-fast-probe", name: "GPT fast probe" };

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Each response carries exactly one complete hosted web_search_call item with a
// stable id plus the assistant's final text. The same bytes are read by Pi's
// Responses parser (which ignores web_search_call items but must still surface the
// final text) and by the rail-oai-search HostedSearchSseObserver (which must count
// the stable id once, not once per lifecycle event and not once per output copy).
function responseEvents(text: string, responseId: string): string {
	const searchId = `${responseId}-web-search`;
	const query = `hosted search for ${responseId}`;
	const source = { type: "url", url: "https://example.com/rail-fast-source", title: "Rail fast source" };
	const searchItem = {
		id: searchId,
		type: "web_search_call",
		status: "completed",
		action: { type: "search", query, sources: [source] },
	};
	const item = {
		type: "message",
		id: `${responseId}-message`,
		role: "assistant",
		status: "completed",
		phase: "final_answer",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const response = {
		id: responseId,
		status: "completed",
		output: [searchItem, item],
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
	};
	return [
		sse("response.created", { type: "response.created", response: { id: responseId } }),
		sse("response.output_item.added", {
			type: "response.output_item.added",
			output_index: 0,
			item: { id: searchId, type: "web_search_call", status: "in_progress", action: { type: "search", query } },
		}),
		sse("response.web_search_call.in_progress", { type: "response.web_search_call.in_progress", output_index: 0, item_id: searchId }),
		sse("response.web_search_call.searching", { type: "response.web_search_call.searching", output_index: 0, item_id: searchId }),
		sse("response.web_search_call.completed", { type: "response.web_search_call.completed", output_index: 0, item_id: searchId }),
		sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: searchItem }),
		sse("response.output_item.done", { type: "response.output_item.done", output_index: 1, item }),
		sse("response.completed", { type: "response.completed", response }),
	].join("");
}

test("real stateless and persistent children apply fast mode and hosted search to their first provider payload", { timeout: 30_000 }, async (t) => {
	const observed = new HostedSearchActivity({ provider: model.provider, model: model.modelId });
	const observer = new HostedSearchSseObserver(observed);
	observer.push(responseEvents("observed probe", "resp_observe"));
	observer.end();
	const snapshot = observed.snapshot();
	assert.equal(snapshot.callCount, 1);
	assert.deepEqual(snapshot.calls, [{
		id: "resp_observe-web-search",
		status: "completed",
		type: "search",
		query: "hosted search for resp_observe",
		url: undefined,
	}]);
	assert.deepEqual(snapshot.sources, [{ title: "Rail fast source", url: "https://example.com/rail-fast-source" }]);
	assert.equal(snapshot.phase, "completed");

	const requests: Array<Record<string, unknown>> = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(raw) as Record<string, unknown>);
			const responseId = `rail-fast-${requests.length}`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(responseEvents(`fast response ${requests.length}`, responseId));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fast probe server did not bind");
	const sandbox = await mkdtemp(join(tmpdir(), "rail-fast-integration-"));
	const agentDir = join(sandbox, "agent");
	await mkdir(agentDir, { recursive: true });
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const previousGateway = process.env["RAIL_FAST_PROBE_GATEWAY"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	process.env["RAIL_FAST_PROBE_GATEWAY"] = `http://127.0.0.1:${address.port}/v1`;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		if (previousGateway === undefined) delete process.env["RAIL_FAST_PROBE_GATEWAY"];
		else process.env["RAIL_FAST_PROBE_GATEWAY"] = previousGateway;
		await rm(sandbox, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});

	const runner = createStatelessAgentRunner({
		resolveInvocation: (args) => ({
			command: process.execPath,
			args: [bundleCli, "--no-extensions", "--offline", ...args, "-e", providerFixture],
		}),
	});
	const stateless = await runner({ model, task: "stateless fast probe", cwd: process.cwd(), fastMode: true });
	assert.equal(stateless.output, "fast response 1", JSON.stringify({ stateless, requests }));
	assert.equal(stateless.usage.searches, 1, JSON.stringify({ stateless, requests }));
	const ordinary = await runner({ model, task: "stateless ordinary probe", cwd: process.cwd() });
	assert.equal(ordinary.output, "fast response 2", JSON.stringify({ ordinary, requests }));
	assert.equal(ordinary.usage.searches, 1, JSON.stringify({ ordinary, requests }));

	const spec: WorkerStartSpec = {
		agentId: "agt_fast_probe",
		mode: "new",
		model,
		alias: "fast-probe",
		sessionName: "subagent · fast probe",
		cwd: process.cwd(),
		fastMode: true,
	};
	const transport = new PiRpcProcessTransport({
		command: process.execPath,
		args: [bundleCli, "--no-extensions", "--offline", ...buildRpcWorkerArgs(spec), "-e", providerFixture],
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
	});
	await transport.start();
	const worker = await RpcSessionWorker.connect(spec, transport);
	try {
		const persistent = await worker.send("persistent fast probe");
		assert.equal(persistent.output, "fast response 3");
		assert.equal(persistent.usage.searches, 1, JSON.stringify({ persistent, requests }));
	} finally {
		await worker.stop().catch(() => undefined);
		await transport.stop().catch(() => undefined);
	}

	assert.equal(requests.length, 3);
	assert.deepEqual(requests.map((body) => body["service_tier"]), ["priority", undefined, "priority"]);
	for (const body of requests) {
		const tools = body["tools"] as Array<Record<string, unknown>>;
		assert.deepEqual(tools.filter((tool) => tool["type"] === "web_search"), [{ type: "web_search", external_web_access: true }]);
		assert.deepEqual(body["include"], ["web_search_call.action.sources"]);
	}

	for (const extensions of [[railExtension, railFastExtensionPath()], [railFastExtensionPath(), railExtension]]) {
		const dedupTransport = new PiRpcProcessTransport({
			command: process.execPath,
			args: [
				bundleCli,
				"--mode", "rpc",
				"--name", "rail-fast-dedup",
				"--no-extensions",
				"--offline",
				"-e", providerFixture,
				"-e", extensions[0]!,
				"-e", extensions[1]!,
				"--model", "rail-fast-probe/gpt-fast-probe",
			],
			cwd: process.cwd(),
			env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SUBAGENT_DEPTH: "1" },
		});
		await dedupTransport.start();
		try {
			const commands = await dedupTransport.request({ type: "get_commands" }) as { commands?: Array<{ name?: string }> };
			assert.equal(commands.commands?.filter((command) => command.name === "rail-oai-fast").length, 1);
		} finally {
			await dedupTransport.stop().catch(() => undefined);
		}
	}

	for (const extensions of [[railExtension, railOaiSearchExtensionPath()], [railOaiSearchExtensionPath(), railExtension]]) {
		const dedupTransport = new PiRpcProcessTransport({
			command: process.execPath,
			args: [
				bundleCli,
				"--mode", "rpc",
				"--name", "rail-search-dedup",
				"--no-extensions",
				"--offline",
				"-e", providerFixture,
				"-e", extensions[0]!,
				"-e", extensions[1]!,
				"--rail-oai-search-mode", "live",
				"--model", "rail-fast-probe/gpt-fast-probe",
			],
			cwd: process.cwd(),
			env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SUBAGENT_DEPTH: "1" },
		});
		await dedupTransport.start();
		try {
			const commands = await dedupTransport.request({ type: "get_commands" }) as { commands?: Array<{ name?: string }> };
			assert.equal(commands.commands?.filter((command) => command.name === "rail-oai-search").length, 1);
			let unsubscribeSettled!: () => void;
			const settled = new Promise<void>((resolve) => {
				unsubscribeSettled = dedupTransport.onEvent((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribeSettled();
					resolve();
				});
			});
			await dedupTransport.request({ type: "prompt", message: "search install order probe" });
			await settled;
			const request = requests.at(-1);
			assert.ok(request, "search install order probe did not reach the provider");
			const tools = request["tools"] as Array<Record<string, unknown>>;
			assert.deepEqual(tools.filter((tool) => tool["type"] === "web_search"), [{ type: "web_search", external_web_access: true }]);
			assert.deepEqual(request["include"], ["web_search_call.action.sources"]);
		} finally {
			await dedupTransport.stop().catch(() => undefined);
		}
	}
});