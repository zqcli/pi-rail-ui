import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, getToolStateChanges,
	normalizeContext, Type, type Api, type Message, type Model, type Tool,
} from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
	AgentSession, buildSessionContext, convertToLlm, createExtensionRuntime, ExtensionRunner, SessionManager,
	type Extension, type ExtensionContext, type ModelRegistry, type SessionBeforeCompactEvent, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { transformNativeSearchPayload } from "../../commands/rail-oai-search";
import { rememberLiveRequestContext, runRemoteCompaction } from "../../tools/gpt-compaction/core";
import { compactionIdentity } from "../../tools/gpt-compaction/model-eligibility";
import {
	clearRequestContextCache, rememberRequestContext, resolveCompactionRequestExtras,
} from "../../tools/gpt-compaction/request-context";
import { serializeMessagesToResponsesInput } from "../../tools/gpt-compaction/serializer";

const model: Model<Api> = {
	provider: "transcript-test", api: "openai-responses", id: "gpt-test", name: "Test",
	baseUrl: "https://example.invalid/v1", reasoning: true, input: ["text"],
	contextWindow: 128000, maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsStrictMode: true },
};
const tool = (name: string, description = name): Tool => ({
	name, description, parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }),
});
const system = (tools: Tool[], prompt = "base prompt") => normalizeContext({ systemPrompt: prompt, tools, messages: [] }).messages;
const resolve = (messages: Message[], currentModel = model, sessionId = "transcript-test") =>
	resolveCompactionRequestExtras(currentModel, compactionIdentity(currentModel), sessionId, messages);
const wire = (tools: Tool[]) => convertResponsesTools(tools, { strict: false, supportsStrictMode: true });

afterEach(() => clearRequestContextCache());

function harness(messages: Message[], currentModel = model) {
	const manager = SessionManager.inMemory();
	for (const message of messages) manager.appendMessage(message);
	const ctx = {
		model: currentModel,
		sessionManager: manager,
		getSystemPrompt: () => getCurrentSystemPrompt(convertToLlm(manager.buildSessionContext().messages)),
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only", baseUrl: currentModel.baseUrl }) },
	} as unknown as ExtensionContext;
	return { manager, ctx };
}

async function compact(ctx: ExtensionContext, branchEntries: SessionEntry[], firstKeptEntryId: string, customInstructions?: string) {
	let body: Record<string, unknown> | undefined;
	const event = {
		type: "session_before_compact", branchEntries, customInstructions,
		preparation: {
			firstKeptEntryId, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
			tokensBefore: 100, settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		},
		signal: new AbortController().signal, reason: "manual", willRetry: false,
	} as SessionBeforeCompactEvent;
	const result = await runRemoteCompaction({ event, ctx, deps: {
		executeRemote: async (request) => {
			body = request.body;
			return { ok: true, status: 200, checkpoint: { type: "compaction", encrypted_content: "test-checkpoint" } };
		},
	} });
	return { result, body };
}

function appendUser(manager: SessionManager, content: string) {
	return manager.appendMessage({ role: "user", content, timestamp: 1 });
}

test("current transcript replaces stale local tools but preserves unchanged provider wire and Fast/hosted extras", async () => {
	const read = tool("read");
	const oldEdit = tool("edit", "old interface");
	const removed = tool("removed");
	const initial = system([read, oldEdit, removed]);
	const { manager, ctx } = harness(initial);
	appendUser(manager, "history to compact");
	// The provider may make schemas strict independently of the persisted declaration.
	const strictRead = { ...wire([{ ...read, constrainedSampling: { type: "json_schema", strict: "require" } }])[0], provider_tag: "preserve" };
	const hosted = { type: "web_search", search_context_size: "high", filters: { allowed_domains: ["example.org"] } };
	const extras = {
		parallel_tool_calls: false, service_tier: "priority", reasoning: { effort: "high", summary: "auto" },
		text: { verbosity: "low" }, max_output_tokens: 2048, prompt_cache_key: "fast-key",
	};
	const payload = { model: model.id, tools: [strictRead, ...wire([oldEdit, removed]), hosted], ...extras };
	rememberLiveRequestContext(ctx, payload);
	const edit = tool("edit", "new interface");
	const added = tool("added");
	manager.appendMessage({ role: "system", content: "", ...getToolStateChanges([read, oldEdit, removed], [read, edit, added]), timestamp: 2 });
	const cut = appendUser(manager, "retained tail");
	const { result, body } = await compact(ctx, manager.getBranch(), cut);
	assert.equal(result.outcome, "success");
	assert.ok(body);
	assert.deepEqual(body["tools"], [strictRead, ...wire([edit]), hosted, ...wire([added])]);
	for (const [key, value] of Object.entries(extras)) assert.deepEqual(body[key], value);
	assert.doesNotMatch(JSON.stringify(body["input"]), /retained tail|base prompt/);
	assert.equal(body["instructions"], "base prompt");
	assert.deepEqual(payload.tools[0], strictRead, "resolving must not mutate the live payload");
});

test("actual hosted search transformation keeps collision policy across dynamic tool changes", async () => {
	const read = tool("read");
	const localSearch = tool("web_search");
	const removed = tool("removed");
	const { manager, ctx } = harness(system([read, localSearch, removed]));
	appendUser(manager, "history");
	const payload = transformNativeSearchPayload(model, "live", {
		model: model.id, input: [], tools: wire([read, localSearch, removed]),
	}) as { tools: unknown[] };
	const hosted = { type: "web_search", external_web_access: true };
	assert.deepEqual(payload.tools, [...wire([read, removed]), hosted]);
	rememberLiveRequestContext(ctx, payload);
	const initialCut = appendUser(manager, "initial retained tail");
	assert.deepEqual((await compact(ctx, manager.getBranch(), initialCut)).body?.["tools"], [...wire([read, removed]), hosted]);
	const changedRead = tool("read", "updated interface");
	const changedSearch = tool("web_search", "updated local search");
	const added = tool("added");
	manager.appendMessage({ role: "system", content: "", timestamp: 2,
		...getToolStateChanges([read, localSearch, removed], [changedRead, changedSearch, added]) });
	const cut = appendUser(manager, "keep");
	const { result, body } = await compact(ctx, manager.getBranch(), cut);
	assert.equal(result.outcome, "success");
	assert.deepEqual(body?.["tools"], [...wire([changedRead]), hosted, ...wire([added])]);
	assert.deepEqual(payload.tools, [...wire([read, removed]), hosted]);
	// A fresh request with search off must not retain the previous suppression.
	const off = transformNativeSearchPayload(model, "off", {
		model: model.id, input: [], tools: wire([changedRead, changedSearch, added]),
	});
	rememberLiveRequestContext(ctx, off);
	assert.deepEqual((await compact(ctx, manager.getBranch(), cut)).body?.["tools"], wire([changedRead, changedSearch, added]));
});

for (const override of ["systemPrompt", "forceSystemPrompt"] as const) {
	test(`Pi before_agent_start ${override} projection survives remote compaction without persistence`, async () => {
		const read = tool("read");
		const { manager, ctx } = harness(system([read], "structured base"));
		appendUser(manager, "history");
		manager.appendMessage({ role: "system", content: "", sections: { policy: "current policy" }, timestamp: 2 });
		const cut = appendUser(manager, "keep");
		const forced = "EXACT active run override";
		const extension = {
			path: "test-only", handlers: new Map([["before_agent_start", [(event: { systemPromptOptions: { forceSystemPrompt?: string } }) => {
				if (override === "systemPrompt") return { systemPrompt: forced };
				event.systemPromptOptions.forceSystemPrompt = forced;
				return undefined;
			}]]]),
		} as unknown as Extension;
		const runner = new ExtensionRunner([extension], createExtensionRuntime(), process.cwd(), manager, ctx.modelRegistry as ModelRegistry);
		const hook = await runner.emitBeforeAgentStart("test", undefined, { cwd: process.cwd(), customPrompt: "structured base" });
		// Exercise Pi's real projection and systemPrompt getter, without starting a provider.
		const session = Object.assign(Object.create(AgentSession.prototype), {
			agent: {}, _runSystemPromptOptions: hook.systemPromptOptions,
		});
		session._installAgentForcedPromptProjection();
		ctx.getSystemPrompt = () => session.systemPrompt;
		const before = structuredClone(manager.getBranch());
		const projected = await session.agent.transformContext(manager.buildSessionContext().messages);
		assert.equal(getCurrentSystemPrompt(projected), forced);
		assert.deepEqual(getCurrentTools(projected), [read]);
		const { result, body } = await compact(ctx, manager.getBranch(), cut, "compaction only");
		assert.equal(result.outcome, "success");
		assert.equal(body?.["instructions"], `${forced}\n\nAdditional instructions for this compaction only:\ncompaction only`);
		assert.deepEqual(body?.["tools"], wire([read]));
		assert.doesNotMatch(JSON.stringify(body?.["input"]), /structured base|current policy|active run override/);
		assert.deepEqual(manager.getBranch(), before);
		assert.doesNotMatch(JSON.stringify(before), /EXACT active run override/);
	});
}

test("Pi's normal prompt rendering and section patches stay aligned with current tools", async () => {
	const read = tool("read");
	const added = tool("added");
	const { manager, ctx } = harness([]);
	const runner = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), manager, ctx.modelRegistry as ModelRegistry);
	const { systemPromptOptions: options } = await runner.emitBeforeAgentStart("test", undefined, {
		cwd: process.cwd(), customPrompt: "structured base", selectedTools: [read.name],
		sections: { policy: "old policy", obsolete: "obsolete section" },
	});
	const session = Object.assign(Object.create(AgentSession.prototype), {
		agent: { state: { tools: [], messages: [] } }, _runSystemPromptOptions: options,
		_toolRegistry: new Map([[read.name, read], [added.name, added]]),
	});
	manager.appendMessage(session._preparePromptAndToolLoadout(options, []));
	manager.appendMessage({ role: "system", content: "", toolsAdded: [read], timestamp: 1 });
	appendUser(manager, "history");
	options.sections["policy"] = "current policy";
	delete options.sections["obsolete"];
	options.selectedTools = [added.name];
	manager.appendMessage(session._preparePromptAndToolLoadout(options, manager.buildSessionContext().messages));
	manager.appendMessage({ role: "system", content: "", ...getToolStateChanges([read], [added]), timestamp: 2 });
	const cut = appendUser(manager, "keep");
	ctx.getSystemPrompt = () => session.systemPrompt;
	assert.equal(ctx.getSystemPrompt(), getCurrentSystemPrompt(convertToLlm(manager.buildSessionContext().messages)));
	const { result, body } = await compact(ctx, manager.getBranch(), cut);
	assert.equal(result.outcome, "success");
	assert.equal(body?.["instructions"], session.systemPrompt);
	assert.equal(String(body?.["instructions"]).match(/current policy/g)?.length, 1);
	assert.doesNotMatch(String(body?.["instructions"]), /old policy|obsolete section/);
	assert.deepEqual(body?.["tools"], wire([added]));
	assert.doesNotMatch(JSON.stringify(body?.["input"]), /structured base|policy|obsolete section/);
});

test("resume without cache reconstructs every current declaration, including additive transport tools", async () => {
	const read = tool("read");
	const added = tool("later");
	const messages = system([read]);
	messages.push({ role: "system", content: "", toolsAdded: [added], timestamp: 2 });
	const { manager, ctx } = harness(messages, { ...model, compat: { ...model.compat, supportsToolSearch: true, supportsMidConvoSystemMessages: true } });
	appendUser(manager, "old");
	const cut = appendUser(manager, "keep");
	const { result, body } = await compact(ctx, manager.getBranch(), cut);
	assert.equal(result.outcome, "success");
	assert.deepEqual(body?.["tools"], wire([read, added]));
	// A live additive transport might cache only the initial top-level tools.
	rememberRequestContext({ model: model.id, tools: wire([read]) }, compactionIdentity(model), "transcript-test", messages);
	assert.deepEqual(resolve(messages).tools, wire([read, added]));
});

test("removing all local tools leaves hosted tools; a different session or endpoint cannot inherit extras", () => {
	const read = tool("read");
	const messages = system([read]);
	const hosted = { type: "web_search_preview" };
	rememberRequestContext({ model: model.id, tools: [...wire([read]), hosted], service_tier: "priority" }, compactionIdentity(model), "transcript-test", messages);
	messages.push({ role: "system", content: "", toolsRemoved: [{ name: "read" }], timestamp: 2 });
	assert.deepEqual(resolve(messages), { tools: [hosted], service_tier: "priority" });
	assert.deepEqual(resolve(messages, model, "another-session"), { tools: [] });
	assert.deepEqual(resolve(messages, { ...model, baseUrl: "https://other.invalid/v1" }), { tools: [] });
});

test("cache without declaration provenance cannot reuse an unrelated same-name strict definition", () => {
	const read = tool("read");
	rememberRequestContext({ model: model.id, tools: wire([{ ...read, description: "stale", constrainedSampling: { type: "json_schema", strict: "require" } }]) }, compactionIdentity(model), "transcript-test");
	assert.deepEqual(resolve(system([read])).tools, wire([read]));
});

test("Codex new and redefined tools explicitly use strict false; required strict schemas use the official converter", () => {
	const codex = { ...model, api: "openai-codex-responses" as const, compat: {} };
	const old = tool("read", "old");
	const read = tool("read", "new");
	const added = tool("added");
	const strict = { ...tool("strict"), constrainedSampling: { type: "json_schema", strict: "require" } } satisfies Tool;
	const messages = system([old]);
	rememberRequestContext({ model: model.id, tools: [{ ...wire([old])[0], strict: null }] }, compactionIdentity(codex), "transcript-test", messages);
	messages.push({ role: "system", content: "", ...getToolStateChanges([old], [read, added, strict]), timestamp: 2 });
	const tools = resolve(messages, codex).tools as Record<string, unknown>[];
	assert.deepEqual(tools, wire([read, added, strict]));
	assert.equal(tools[0]?.["strict"], false);
	assert.equal(tools[1]?.["strict"], false);
	assert.equal(tools[2]?.["strict"], true);
	assert.deepEqual((tools[2]?.["parameters"] as Record<string, unknown>)["required"], ["path", "limit"]);
});

test("declaration provenance and resolved schemas are independent snapshots", () => {
	const read = { ...tool("read"), constrainedSampling: { type: "json_schema", strict: "prefer" } } satisfies Tool;
	const messages = system([read]);
	const oldWire = { ...wire([read])[0], provider_tag: "old-wire" };
	rememberRequestContext({ model: model.id, tools: [oldWire] }, compactionIdentity(model), "transcript-test", messages);
	// toToolDeclaration clones parameters, but not constrainedSampling itself.
	(read.constrainedSampling as { strict: string }).strict = "require";
	assert.deepEqual(resolve(messages).tools, wire([read]), "mutating a declaration must invalidate the old wire snapshot");
	const plain = tool("plain");
	const resolved = resolve(system([plain])).tools as { parameters: Record<string, unknown> }[];
	resolved[0]!.parameters["properties"] = {};
	assert.deepEqual(resolve(system([plain])).tools, wire([plain]), "request mutation must not modify the transcript");
});

test("system checkpoints replace retained deltas; the effective current instructions appear once", async () => {
	const read = tool("read");
	const messages = system([read], "base instructions");
	messages.push({ role: "system", content: "", sections: { rules: "old rules", removed: "obsolete section" }, timestamp: 2 });
	const { manager, ctx } = harness(messages);
	appendUser(manager, "old history");
	const retained = appendUser(manager, "retained history");
	manager.appendMessage({ role: "system", content: "one-time delta", sections: { rules: "current rules", removed: null }, timestamp: 3 });
	manager.appendCompaction("native summary", retained, 100);
	manager.appendMessage({ role: "system", content: "post-checkpoint delta", sections: { rules: "final rules" }, toolsRemoved: [{ name: "read" }], timestamp: 4 });
	const cut = appendUser(manager, "keep this");
	const branch = manager.getBranch();
	const expected = getCurrentSystemPrompt(convertToLlm(buildSessionContext(branch, branch.at(-1)?.id).messages));
	const { result, body } = await compact(ctx, branch, cut, "  focus on risks  ");
	assert.equal(result.outcome, "success");
	assert.equal(body?.["instructions"], `${expected}\n\nAdditional instructions for this compaction only:\nfocus on risks`);
	assert.equal(String(body?.["instructions"]).match(/one-time delta/g)?.length, 1);
	assert.doesNotMatch(String(body?.["instructions"]), /old rules|obsolete section|current rules/);
	assert.deepEqual(body?.["tools"], []);
	assert.doesNotMatch(JSON.stringify(body?.["input"]), /instructions|delta|rules|keep this/);
});

test("legacy compaction without a system snapshot retains earlier declarations through later partial updates", async () => {
	const read = tool("read");
	const removed = tool("removed");
	const added = tool("added");
	const { manager, ctx } = harness(system([read, removed], "legacy base"));
	appendUser(manager, "old");
	const kept = appendUser(manager, "retained");
	manager.appendCompaction("old-format native summary", kept, 100);
	manager.appendMessage({ role: "system", content: "later delta", toolsAdded: [added], toolsRemoved: [{ name: "removed" }], timestamp: 2 });
	const cut = appendUser(manager, "keep");
	const branch = manager.getBranch().map((entry) => {
		if (entry.type !== "compaction") return entry;
		const { systemMessage: _snapshot, ...legacy } = entry;
		return legacy;
	});
	const { result, body } = await compact(ctx, branch, cut);
	assert.equal(result.outcome, "success");
	assert.equal(body?.["instructions"], "legacy base\n\nlater delta");
	assert.deepEqual(body?.["tools"], wire([read, added]));
});

test("an empty effective prompt and authoritative checkpoint do not resurrect old state", async () => {
	const { manager, ctx } = harness(system([tool("old")]));
	appendUser(manager, "old history");
	const kept = appendUser(manager, "retained");
	manager.appendCompaction("summary", kept, 100);
	const cut = appendUser(manager, "keep");
	const emptySystem: Message[] = [{ role: "system", content: "", timestamp: 3 }];
	const branch = manager.getBranch().map((entry) => entry.type === "compaction"
		? { ...entry, systemMessage: getCurrentSystemMessage(emptySystem)! } : entry);
	ctx.getSystemPrompt = () => "";
	const { body } = await compact(ctx, branch, cut);
	assert.equal(body?.["instructions"], "");
	assert.deepEqual(body?.["tools"], []);
});

test("unrepresentable required tool constraints fail before executing a remote request", async () => {
	const strict = { ...tool("required"), constrainedSampling: { type: "json_schema", strict: "require" } } satisfies Tool;
	const { manager, ctx } = harness(system([strict]), { ...model, compat: { supportsStrictMode: false } });
	appendUser(manager, "old");
	const cut = appendUser(manager, "keep");
	const { result, body } = await compact(ctx, manager.getBranch(), cut);
	assert.equal(result.outcome, "failed");
	if (result.outcome === "failed") assert.equal(result.reason, "tool-declarations-invalid");
	assert.equal(body, undefined);
});

test("remote declarations use the event branch snapshot, not a subsequently advanced live branch", async () => {
	const read = tool("read");
	const { manager, ctx } = harness(system([read], "snapshot instructions"));
	appendUser(manager, "history");
	const cut = appendUser(manager, "retained");
	const branch = manager.getBranch();
	manager.appendMessage({ role: "system", content: "future instructions", toolsRemoved: [{ name: "read" }], toolsAdded: [tool("future")], timestamp: 5 });
	const { result, body } = await compact(ctx, branch, cut);
	assert.equal(result.outcome, "success");
	assert.equal(body?.["instructions"], ctx.getSystemPrompt());
	assert.deepEqual(body?.["tools"], wire([read]));
	if (result.outcome === "success") {
		assert.equal((result.compaction.details as { boundary: { parentEntryId: string } }).boundary.parentEntryId, cut);
	}
});

test("new grammar declarations use the official Responses custom-tool format", () => {
	const grammar: Tool = {
		name: "patch", description: "Apply patch", parameters: Type.Object({ input: Type.String() }),
		constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/s" } },
	};
	const currentModel = { ...model, compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true } };
	const expected = convertResponsesTools([grammar], { strict: false, supportsStrictMode: true, supportsOpenAIGrammarTools: true });
	assert.equal(expected[0]?.type, "custom");
	assert.deepEqual(resolve(system([grammar]), currentModel).tools, expected);
});

test("system deltas between a tool call and its result neither duplicate instructions nor destroy real output", () => {
	const read = tool("read");
	const messages = normalizeContext({ systemPrompt: "instructions", tools: [read], messages: [
		{ role: "assistant", content: [{ type: "toolCall", id: "call|fc_call", name: "read", arguments: { path: "file" } }],
			api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		{ role: "system", content: "new instructions", toolsRemoved: [{ name: "read" }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "call|fc_call", toolName: "read", content: [{ type: "text", text: "real output" }], isError: false, timestamp: 3 },
	] }).messages;
	assert.deepEqual(getCurrentTools(messages), []);
	const input = serializeMessagesToResponsesInput(model, convertToLlm(messages));
	assert.equal(input.length, 2);
	assert.deepEqual(input[1], { type: "function_call_output", call_id: "call", output: "real output" });
	assert.doesNotMatch(JSON.stringify(input), /instructions|No result provided/);
});
