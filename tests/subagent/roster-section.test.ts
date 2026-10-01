import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installRailSubagent } from "../../tools/subagents/index";
import { SessionBroker, type AgentInstance } from "../../tools/subagents/session-broker";

const model = {
	provider: "cus-resp", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", api: "openai-responses",
	contextWindow: 128_000, maxTokens: 4096, reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("before_agent_start puts the roster in a stable section instead of forcing the system prompt", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "rail-roster-section-"));
	const oldAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const oldDepth = process.env["PI_SUBAGENT_DEPTH"];
	process.env["PI_SUBAGENT_DEPTH"] = "0";
	process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
	await mkdir(process.env["PI_CODING_AGENT_DIR"], { recursive: true });
	const originalListLinked = SessionBroker.prototype.listLinked;
	let linked: AgentInstance[] = [];
	(SessionBroker.prototype as any).listLinked = async () => linked;
	t.after(async () => {
		SessionBroker.prototype.listLinked = originalListLinked;
		if (oldAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = oldAgentDir;
		if (oldDepth === undefined) delete process.env["PI_SUBAGENT_DEPTH"];
		else process.env["PI_SUBAGENT_DEPTH"] = oldDepth;
		await rm(root, { recursive: true, force: true });
	});

	const handlers = new Map<string, (...args: any[]) => any>();
	installRailSubagent({
		registerTool() {},
		registerCommand() {},
		appendEntry() {},
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
	} as any);
	const ctx = {
		cwd: root, mode: "rpc", hasUI: false, model, thinkingLevel: "medium",
		scopedModels: [{ model, thinkingLevel: "medium" }],
		modelRegistry: { find: () => model, getAvailable: () => [model] },
		sessionManager: { getBranch: () => [], getSessionName: () => "parent", getSessionId: () => "parent" },
	};
	await handlers.get("session_start")!({}, ctx);
	t.after(() => handlers.get("session_shutdown")!({ reason: "test" }, ctx));

	const instance = (lastTask: string): AgentInstance => ({
		version: 2, agentId: "agt_auth", alias: "auth-review", model: { provider: "cus-resp", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh" },
		sessionId: "session-auth", sessionFile: join(root, "auth.jsonl"), cwd: root,
		createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastTask,
	});
	const run = async (prompt: string, sections: Record<string, string> = {}) => {
		const event = { prompt, systemPrompt: "native", systemPromptOptions: { sections } };
		return { result: await handlers.get("before_agent_start")!(event, ctx), sections };
	};

	linked = [instance("Review auth concurrency")];
	const first = await run("hello");
	assert.equal(first.result, undefined, "a returned systemPrompt would be forced as the leading prompt");
	const section = first.sections["rail_model_sessions"]!;
	assert.match(section, /- auth-review \(agt_auth\) \[cus-resp\/gpt-5\.6-sol:xhigh\]/);
	assert.doesNotMatch(section, /Last task|idle|Review auth concurrency/);

	linked = [instance("A completely different task")];
	assert.equal((await run("hello again")).sections["rail_model_sessions"], section);

	const mentioned = await run("ask @agent/auth-review");
	assert.match(mentioned.sections["rail_model_sessions"]!, /must call subagent with target="auth-review"/);

	linked = [];
	const empty = await run("hello", { rail_model_sessions: "stale" });
	assert.equal("rail_model_sessions" in empty.sections, false);
});
