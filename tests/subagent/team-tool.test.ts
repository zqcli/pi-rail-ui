import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { formatTeamView, installTeamTool, TeamLaunchWaitAbortedError } from "../../tools/subagents/team-tool";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import type { SessionBroker } from "../../tools/subagents/session-broker";
import { TEAM_JOURNAL_ENTRY_TYPE } from "../../tools/subagents/team-journal";
import { shortWorkRef, workRefKey, type ResultRecord, type TeamResult } from "../../tools/subagents/team-protocol";
import type { RuntimeActivation } from "../../tools/subagents/team-runtime";

const nativeModel: any = {
	provider: "cus-resp", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", api: "openai-responses",
	contextWindow: 128_000, maxTokens: 4096, reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function context(cwd = process.cwd()) {
	return {
		cwd, hasUI: true, model: nativeModel, thinkingLevel: "medium", scopedModels: [{ model: nativeModel, thinkingLevel: "medium" }],
		modelRegistry: {
			find: (provider: string, id: string) => provider === nativeModel.provider && id === nativeModel.id ? nativeModel : undefined,
			getAvailable: () => [nativeModel],
		},
	};
}

function setup(branch: any[] = []) {
	const broker = { assertAliasesAvailable: async () => undefined } as unknown as SessionBroker;
	const host = new TeamSessionHost(broker, () => undefined, branch);
	let tool: any;
	installTeamTool({ registerTool: (definition: any) => { tool = definition; } } as any, { host: () => host, broker: () => broker });
	return { host, broker, tool };
}

const prepareArgs = {
	action: "prepare",
	manager: { alias: "lead", roleDescription: "Coordinate the review.", model: null, cwd: null, fastMode: null, contextWindow: null },
	workers: [{ alias: "worker", roleDescription: "Inspect the assigned scope.", model: null, cwd: null, fastMode: null, contextWindow: null }],
	brief: { goal: "Review the requested change.", acceptanceCriteria: ["Report evidence and limitations."], constraints: null },
	initialRequests: [{ to: "worker", task: "Inspect the changed files.", inputRefs: null }],
	timeoutSeconds: null,
};

function terminal(teamId: string): TeamResult {
	return {
		version: 2, teamId, lifecycle: "closed", outcome: "succeeded", finalResultRefs: [], roots: [],
		members: [
			{ id: "lead", role: "manager", lifecycle: "closed", resourceState: "released" },
			{ id: "worker", role: "worker", lifecycle: "closed", resourceState: "released" },
		],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		unresolvedIncidents: [],
	};
}

test("prepare validates and pins the complete member policy without starting a provider", async () => {
	const { host, broker, tool } = setup();
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(Object.hasOwn(tool.parameters.properties, "searchMode"), false, "Search is derived by host policy, never a tool argument");

	const raw = { ...prepareArgs, unrelated: "must not be projected away" };
	assert.throws(() => tool.prepareArguments(raw), /unsupported field.*unrelated/u);
	await assert.rejects(tool.execute("bad", raw, undefined, undefined, context()), /unsupported field.*unrelated/u);
	assert.equal(host.runtime.listTeams().length, 0);

	const prepared = await tool.execute("prepare", prepareArgs, undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	const view = host.runtime.getTeam(teamId);
	assert.equal(view.lifecycle, "prepared");
	assert.equal(view.members.length, 2);
	assert.ok(view.members.every((member) => member.policy.cwd === process.cwd()));
	assert.ok(view.members.every((member) => member.policy.searchMode !== undefined));
	assert.equal(view.works.total, 1);
	assert.match(prepared.content[0].text, /nothing has started: no provider, no tool/u);
	assert.equal((broker as any).requests, undefined);

	const status = await tool.execute("status", { action: "status", teamId }, undefined, undefined, context());
	assert.match(status.content[0].text, /IDLE · no assigned work/u);
	assert.doesNotMatch(status.content[0].text, /IDLE[^\n]*done/u);
	assert.throws(() => tool.prepareArguments({ action: "launch", teamId, reason: "ignored" }), /does not accept field.*reason/u);
	assert.throws(() => tool.prepareArguments({ action: "status", teamId, brief: { goal: "extra" } }), /does not accept field.*brief/u);
	assert.equal(host.pinnedPolicies(teamId)?.size, 2, "invalid launch/status payloads do not consume the prepared policy");
});

test("N09 resolves native/default and trust-aware context reserves, pins policy, and refuses drift before opening", async () => {
	const root = await mkdtemp(join(tmpdir(), "rail-team-policy-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const oldAgentDir = process.env["PI_CODING_AGENT_DIR"];
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(join(project, ".pi"), { recursive: true });
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 16_384 } }));
		await writeFile(join(project, ".pi/settings.json"), JSON.stringify({ compaction: { enabled: true, modelOverrides: {
			"cus-resp/gpt-5.6-sol": { reserveTokens: 60_000 },
		} } }));
		process.env["PI_CODING_AGENT_DIR"] = agentDir;
		const trust = new ProjectTrustStore(agentDir);
		const { host, tool } = setup();
		const args = { ...prepareArgs, workers: [{ ...prepareArgs.workers[0], contextWindow: 32_000 }] };
		trust.set(root, true);
		await assert.rejects(tool.execute("prepare-trusted", args, undefined, undefined, context(project)), /contextWindow.*reserve|reserve.*contextWindow/u);
		assert.equal(host.runtime.listTeams().length, 0, "trusted project reserve rejects the plan before reserving a Team");

		trust.set(root, false);
		const prepared = await tool.execute("prepare", args, undefined, undefined, context(project));
		const teamId = prepared.details.view.teamId;
		assert.match(prepared.content[0].text, /native default 128000/u, "unspecified contextWindow uses the native model default");
		assert.match(prepared.content[0].text, /32000 \(explicit\).*reserve 16384/u);
		assert.equal(host.pinnedPolicies(teamId)?.get("worker")?.nativeContextWindow, 128_000);
		assert.equal(host.pinnedPolicies(teamId)?.get("worker")?.contextWindow, 32_000);
		let starts = 0;
		const opened: Array<{ memberId: string; contextWindow?: number }> = [];
		host.driver.openAndLaunch = async (_id, requests) => {
			starts++;
			opened.push(...requests.map((request: any) => ({ memberId: request.memberId, ...(request.contextWindow !== undefined ? { contextWindow: request.contextWindow } : {}) })));
			host.runtime.launch(teamId);
			return { lifetime: Promise.resolve(terminal(teamId)) };
		};

		trust.set(root, true);
		await assert.rejects(tool.execute("launch-trust-drift", { action: "launch", teamId }, undefined, undefined, context(project)), /project trust\/compaction policy changed/u);
		assert.equal(starts, 0);
		assert.equal(host.pinnedPolicies(teamId)?.size, 2, "failed preflight leaves the Team prepared and retryable");
		assert.equal(host.runtime.getTeam(teamId).lifecycle, "prepared");

		trust.set(root, false);
		nativeModel.contextWindow = 64_000;
		await assert.rejects(tool.execute("launch-model-drift", { action: "launch", teamId }, undefined, undefined, context(project)), /native model\/contextWindow changed/u);
		assert.equal(starts, 0);
		assert.equal(host.pinnedPolicies(teamId)?.size, 2);
		nativeModel.contextWindow = 128_000;

		await tool.execute("launch", { action: "launch", teamId }, undefined, undefined, context(project));
		assert.equal(starts, 1);
		assert.deepEqual(opened, [{ memberId: "lead" }, { memberId: "worker", contextWindow: 32_000 }]);
	} finally {
		if (oldAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = oldAgentDir;
		nativeModel.contextWindow = 128_000;
		await rm(root, { recursive: true, force: true });
	}
});

test("historical status pages result refs, keeps full records out of details, and fetches one explicit result", async () => {
	const teamId = "history-page-team";
	const branch: Array<{ type: string; customType?: string; data?: unknown }> = [{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: {
		version: 2, kind: "launched", teamId, at: 1, roster: { manager: "lead", workers: ["worker"] }, goal: "Read a bounded historical result index.",
	} }];
	const records: ResultRecord[] = Array.from({ length: 48 }, (_, index) => ({
		id: `result-${index}`, work: { workId: `work-${index}`, revision: 1 }, author: "worker",
		result: { status: "succeeded", summary: `Worker result ${index}` }, committedAt: index + 2, source: "explicit_reply",
	}));
	for (const record of records) branch.push({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: {
		version: 2, kind: "result", teamId, at: record.committedAt, result: record,
	} });
	const { host, tool } = setup(branch);
	const first = await tool.execute("history", { action: "status", teamId }, undefined, undefined, context());
	assert.match(first.content[0].text, /20 results|page:20/u);
	assert.match(first.content[0].text, /result-0/u);
	assert.doesNotMatch(first.content[0].text, /result-47/u);
	assert.deepEqual(Object.keys(first.details), [], "a page summary does not return the retained history result array in tool details");

	const next = await tool.execute("history-next", { action: "status", teamId, cursor: "page:20" }, undefined, undefined, context());
	assert.match(next.content[0].text, /result-20/u);
	assert.doesNotMatch(next.content[0].text, /result-0 ·/u);
	assert.deepEqual(Object.keys(next.details), []);

	const full = await tool.execute("history-result", { action: "status", teamId, resultRef: "result-47" }, undefined, undefined, context());
	assert.match(full.content[0].text, /Worker result 47/u);
	assert.deepEqual(full.details.resultRecord, records[47]);
	assert.equal("history" in full.details, false);
	assert.equal(host.history.teams[0]?.results.length, 48, "all refs remain host-readable despite paginated model output");
});

test("pre-aborted launch performs no opens, retains prepared policy, and can be retried", async () => {
	const { host, tool } = setup();
	const prepared = await tool.execute("prepare", prepareArgs, undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	let starts = 0;
	host.driver.openAndLaunch = async () => {
		starts++;
		host.runtime.launch(teamId);
		return { lifetime: Promise.resolve(terminal(teamId)) };
	};
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(tool.execute("launch", { action: "launch", teamId }, controller.signal, undefined, context()), /aborted before opening/u);
	assert.equal(starts, 0, "an already-aborted call never opens a member or provider");
	assert.equal(host.runtime.getTeam(teamId).lifecycle, "prepared");
	assert.equal(host.pinnedPolicies(teamId)?.size, 2, "preflight abort retains the policy for retry/cancel");

	const retried = await tool.execute("launch", { action: "launch", teamId }, undefined, undefined, context());
	assert.equal(starts, 1);
	assert.match(retried.content[0].text, /CLOSED · outcome succeeded/u);
});

test("launch waits for the full Team lifetime and passes only the prepared member requests", async () => {
	const { host, tool } = setup();
	const prepared = await tool.execute("prepare", prepareArgs, undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	let resolveLifetime!: (result: TeamResult) => void;
	const lifetime = new Promise<TeamResult>((resolve) => { resolveLifetime = resolve; });
	let requests: unknown;
	host.driver.openAndLaunch = async (id, values) => {
		assert.equal(id, teamId);
		requests = values;
		host.runtime.launch(teamId);
		return { lifetime };
	};
	const updates: any[] = [];
	let settled = false;
	const pending = tool.execute("launch", { action: "launch", teamId }, undefined, (update: any) => updates.push(update), context())
		.finally(() => { settled = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(settled, false, "launch remains pending until the Team lifetime settles");
	assert.equal((requests as any[]).length, 2);
	assert.ok((requests as any[]).every((request) => request.teamId === teamId));
	assert.ok((requests as any[]).every((request) => !Object.hasOwn(request, "searchMode")));
	assert.equal(host.pinnedPolicies(teamId), undefined, "the validated policy is consumed synchronously at launch admission");

	resolveLifetime(terminal(teamId));
	const result = await pending;
	assert.equal(settled, true);
	assert.ok(updates.length > 0);
	assert.match(result.content[0].text, new RegExp(`Team ${teamId} CLOSED · outcome succeeded`, "u"));
	assert.match(result.content[0].text, /Roots: none/u);
	assert.doesNotMatch(result.content[0].text, /fresh final summary|coordinator summary/u);
});

const theme = {
	fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text,
	strikethrough: (text: string) => text, underline: (text: string) => text,
};

/** Drive the Runtime without an executor: BOOT yields, then the worker replies to each root with `result(index)`. */
function completeRoots(host: TeamSessionHost, teamId: string, result: (index: number) => unknown): string[] {
	const refs: string[] = [];
	let index = 0;
	for (let activation = host.runtime.takeNextActivation(teamId); activation; activation = host.runtime.takeNextActivation(teamId)) {
		assert.equal(host.runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
		const call = `call-${index}`;
		const args = activation.scope.kind === "management" ? { action: "yield" } : { action: "reply", result: result(index++) };
		assert.equal(host.runtime.handleAction(activation.binding, activation.scope, 1, call, args, call).ok, true);
		host.runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: call });
		host.runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
		if (activation.scope.kind === "work") refs.push(host.runtime.getWork(teamId, activation.scope.work!)!.current.resultRef!);
	}
	return refs;
}

test("launch final output carries every selected result in full with a timeline, so no status call is needed", async () => {
	const { host, tool } = setup();
	const tasks = Array.from({ length: 8 }, (_value, index) => ({ to: "worker", task: `Inspect part ${index + 1}.`, inputRefs: null }));
	const prepared = await tool.execute("prepare", { ...prepareArgs, initialRequests: tasks }, undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	let refs: string[] = [];
	host.driver.openAndLaunch = async () => {
		host.runtime.launch(teamId);
		refs = completeRoots(host, teamId, (index) => ({ status: "succeeded", summary: `Part ${index + 1} summary.`,
			findings: index < 4 ? [`FINDING-${index + 1} ${"x".repeat(2_000)}`, `MORE-${index + 1} y`]
				: [`FINDING-${index + 1} ${"x".repeat(5_400)}`, `MORE-${index + 1} ${"y".repeat(5_400)}`], limitations: [`LIMIT-${index + 1}`] }));
		return { lifetime: Promise.resolve({ ...terminal(teamId), finalResultRefs: refs }) };
	};
	const result = await tool.execute("launch", { action: "launch", teamId }, undefined, undefined, context());
	const text: string = result.content[0].text;
	assert.match(text, /^Members:\n- lead · manager · .* · results 0\n- worker · worker · .* · results 8$/mu);
	assert.match(text, /^Timeline \(m:ss from launch\):\n- 0:00 launch · initial (work [2-9a-hjkmnp-z]{4}@1 → worker(, )?){8}\n- \d+:\d\d lead management activation \(BOOT\)\n- \d+:\d\d lead ended management activation \(manager idle\)\n- \d+:\d\d worker started work [2-9a-hjkmnp-z]{4}@1\n- \d+:\d\d worker succeeded result for work [2-9a-hjkmnp-z]{4}@1\n- \d+:\d\d lead management activation \(ROOT_RESULT_READY\)$/mu,
		"the timeline records dispatch, each activation and each result, from the Runtime launch");
	assert.equal(text.match(/worker succeeded result for/gu)?.length, 8);
	assert.doesNotMatch(text, /ended work \S+ \(reply\)/u, "a committed reply is shown once, as its result");
	assert.match(text, /Part 1 summary\.\nFindings:\n- FINDING-1 x+\n- MORE-1 y+\nLimitations:\n- LIMIT-1/u, "a short result is included in full, not as a preview");
	for (const ref of refs.slice(0, 4)) assert.doesNotMatch(text, new RegExp(`resultRef ${ref}`, "u"), "short results are never truncated");
	assert.ok(Buffer.byteLength(text, "utf8") <= 48 * 1024, "the final text stays bounded");
	assert.match(text, new RegExp(`\\[Result truncated for the parent; full record: subagent_team status teamId [^ ]+ resultRef ${refs[7]}\\]`, "u"),
		"only an over-budget record is truncated, and it names the exact resultRef to read");
	assert.equal(result.details.members[1].output.startsWith("result → lead · awaiting review\nPart 8 summary.\nFindings:"), true,
		"the member panel's final answer is its full latest result, under one line saying where it went");
});

/** Reserve the next activation and acknowledge its input, as a native member would. */
function activate(host: TeamSessionHost, teamId: string): RuntimeActivation {
	const activation = host.runtime.takeNextActivation(teamId)!;
	assert.equal(host.runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
	return activation;
}

/** Stage `args` as the activation's end intent and settle it as confirmed by the transcript. */
function endActivation(host: TeamSessionHost, activation: RuntimeActivation, args: unknown, sequence = 1): void {
	const call = `end-${activation.scope.activationId}`;
	assert.equal(host.runtime.handleAction(activation.binding, activation.scope, sequence, call, args, call).ok, true);
	host.runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: call });
	host.runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
}

const sourceWriterArgs = {
	...prepareArgs,
	workers: ["source", "writer"].map((alias) => ({ ...prepareArgs.workers[0]!, alias })),
	initialRequests: [{ to: "source", task: "Find the fixture.", inputRefs: null }, { to: "writer", task: "Write the change.", inputRefs: null }],
};

test("launch panel says who a waiting member waits on, what a held one asks, and why the Team has not finished", async () => {
	const { host, tool } = setup();
	const prepared = await tool.execute("prepare", sourceWriterArgs, undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	const notLaunched = await tool.execute("status", { action: "status", teamId }, undefined, undefined, context());
	assert.doesNotMatch(notLaunched.content[0].text, /Waiting for:/u, "a Team that is not active waits for nothing");

	let resolveLifetime!: (result: TeamResult) => void;
	const lifetime = new Promise<TeamResult>((resolve) => { resolveLifetime = resolve; });
	host.driver.openAndLaunch = async () => { host.runtime.launch(teamId); return { lifetime }; };
	const updates: any[] = [];
	const pending = tool.execute("launch", { action: "launch", teamId }, undefined, (update: any) => updates.push(update), context());
	await new Promise<void>((resolve) => setImmediate(resolve));
	endActivation(host, activate(host, teamId), { action: "yield" });
	const source = activate(host, teamId);
	const writer = activate(host, teamId);
	endActivation(host, source, { action: "yield", attention: "Which fixture should I use?", checkpoint: "stopped before choosing" });
	endActivation(host, writer, { action: "yield", waitingFor: [source.scope.work], checkpoint: "needs the fixture" });
	await new Promise((resolve) => setTimeout(resolve, 300));

	const update = updates.at(-1);
	const detail = (alias: string): string => update.details.members.find((member: any) => member.alias === alias).detail;
	assert.equal(detail("source"), 'held · asks: "Which fixture should I use?" · queued for Manager');
	assert.equal(detail("writer"), `waiting on source (held ${shortWorkRef(source.scope.work!)})`);
	assert.equal(update.details.waitingFor, "Manager decision on source's question");
	assert.match(update.content[0].text, /^Works: [^\n]*\nWaiting for: Manager decision on source's question\n/mu, "the Team header carries the reason under the work counts");
	const status = await tool.execute("status", { action: "status", teamId }, undefined, undefined, context());
	assert.match(status.content[0].text, /^Waiting for: Manager decision on source's question$/mu);

	const tagged = { fg: (color: string, text: string) => `{${color}|${text}}`, bold: (text: string) => text };
	const render = (details: unknown) => tool.renderResult({ ...update, details }, { expanded: false, isPartial: true }, tagged).render(200).join("\n");
	const panel = render(update.details);
	assert.match(panel, /\{warning\|Waiting for: Manager decision on source's question\}/u, "a question for the Manager is colored as a warning");
	assert.match(panel, /held · asks: "Which fixture should I use\?" · queued for Manager/u);
	assert.match(panel, /waiting on source \(held work /u);
	assert.ok(render({ ...update.details, waitingFor: "Manager decisions on 3 questions" }).includes("{warning|Waiting for: Manager decisions on 3 questions}"));
	for (const text of ["Manager review of 2 results", "Manager to close the Team", "source, writer (running) · review (waiting on source)"]) {
		assert.ok(render({ ...update.details, waitingFor: text }).includes(`{dim|Waiting for: ${text}}`), `${text} is not a warning`);
	}
	const { waitingFor: _omitted, ...withoutReason } = update.details;
	assert.doesNotMatch(render(withoutReason), /Waiting for:/u, "no reason, no line");

	resolveLifetime(terminal(teamId));
	await pending;
});

test("launch panel titles each task with who asked and which work, says where a result went, and shows what the Manager handles or has dispatched", async () => {
	const { host, tool } = setup();
	const prepared = await tool.execute("prepare", { ...sourceWriterArgs, initialRequests: [{ to: "writer", task: "Write the change.", inputRefs: null }] },
		undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	let resolveLifetime!: (result: TeamResult) => void;
	const lifetime = new Promise<TeamResult>((resolve) => { resolveLifetime = resolve; });
	host.driver.openAndLaunch = async () => { host.runtime.launch(teamId); return { lifetime }; };
	const updates: any[] = [];
	const pending = tool.execute("launch", { action: "launch", teamId }, undefined, (update: any) => updates.push(update), context());
	await new Promise<void>((resolve) => setImmediate(resolve));
	/** The members of the newest panel update, once the throttled publish has run. */
	const panel = async () => {
		await new Promise((resolve) => setTimeout(resolve, 300));
		const members: any[] = updates.at(-1).details.members;
		const run = (alias: string) => members.find((member) => member.alias === alias);
		return { run, title: (alias: string): string | undefined => run(alias).transcript.entries.find((entry: any) => entry.initial)?.label };
	};

	endActivation(host, activate(host, teamId), { action: "yield" });
	const writer = activate(host, teamId);
	const writerRef = writer.scope.work!;
	const requested = host.runtime.handleAction(writer.binding, writer.scope, 1, "ask-source", { action: "request", to: "source", task: "Find the fixture." }, "ask-source");
	const fixtureRef = (requested as any).receipt.work;
	endActivation(host, writer, { action: "yield", waitingFor: [fixtureRef], checkpoint: "needs the fixture" }, 2);
	const source = activate(host, teamId);

	let now = await panel();
	assert.equal(now.title("writer"), `task from lead · ${shortWorkRef(writerRef)}`);
	assert.equal(now.title("source"), `task from writer (sub-task) · ${shortWorkRef(fixtureRef)}`, "work a peer asked for is a sub-task of that peer");
	assert.equal(now.run("lead").transcript.entries.some((entry: any) => entry.initial), false, "the Manager's task is the Team goal, in the header");
	assert.equal(now.run("writer").detail, `waiting on 1 sub-task: source (running ${shortWorkRef(fixtureRef)})`);
	assert.equal(now.run("lead").detail, "dispatched: writer (waiting)", "the Manager's open dispatch replaces 'no assigned work'");

	endActivation(host, source, { action: "reply", result: { status: "succeeded", summary: "Fixture found." } });
	endActivation(host, activate(host, teamId), { action: "reply", result: { status: "succeeded", summary: "Change written." } });
	now = await panel();
	assert.equal(now.title("source"), `last task from writer (sub-task) · ${shortWorkRef(fixtureRef)}`, "an ended task is the last one");
	assert.equal(now.title("writer"), `last task from lead · ${shortWorkRef(writerRef)}`);
	assert.ok(now.run("source").output.startsWith("result → writer\nFixture found."), "a sub-task's result goes to the peer that asked");
	assert.ok(now.run("writer").output.startsWith("result → lead · awaiting review\nChange written."));
	assert.match(now.run("lead").detail, /^dispatched: writer \(awaiting review\) · \d+ pending events$/u);
	const rendered = tool.renderResult({ ...updates.at(-1) }, { expanded: false, isPartial: true }, theme).render(100).join("\n");
	assert.match(rendered, /result → lead · awaiting review/u);
	assert.match(rendered, /last task from lead · work \S+@1\s+Write the change\./u);
	assert.doesNotMatch(rendered, /initial task/u);

	const manager = activate(host, teamId);
	const accept = { action: "control", command: "accept_result", work: writerRef, disposition: "accepted", reason: "looks right" };
	assert.equal(host.runtime.handleAction(manager.binding, manager.scope, 1, "accept", accept, "accept").ok, true);
	now = await panel();
	assert.equal(now.run("lead").detail, "handling ROOT_RESULT_READY, TEAM_QUIESCENT", "a running Manager says which events it is handling");
	assert.ok(now.run("writer").output.startsWith("result → lead · accepted\n"));

	const revise = { action: "control", command: "revise_work", workId: writerRef.workId, expectedRevision: 1, task: "Write the change, with tests.", inputRefs: [] };
	assert.equal(host.runtime.handleAction(manager.binding, manager.scope, 2, "revise", revise, "revise").ok, true);
	now = await panel();
	assert.equal(now.title("writer"), `task from lead · ${shortWorkRef({ workId: writerRef.workId, revision: 2 })} · revised`);
	assert.equal(now.run("writer").transcript.entries[0].text, "Write the change, with tests.", "the task text is the current revision's");
	assert.ok(now.run("writer").output.startsWith("result → lead · superseded\n"), "the earlier result belongs to a revision that was replaced");

	resolveLifetime(terminal(teamId));
	await pending;
});

test("launch panel keeps the generic wait text while every dependency is terminal but its native cleanup is pending", async () => {
	const { host, tool } = setup();
	const prepared = await tool.execute("prepare", sourceWriterArgs, undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	let resolveLifetime!: (result: TeamResult) => void;
	const lifetime = new Promise<TeamResult>((resolve) => { resolveLifetime = resolve; });
	host.driver.openAndLaunch = async () => { host.runtime.launch(teamId); return { lifetime }; };
	const updates: any[] = [];
	const pending = tool.execute("launch", { action: "launch", teamId }, undefined, (update: any) => updates.push(update), context());
	await new Promise<void>((resolve) => setImmediate(resolve));
	endActivation(host, activate(host, teamId), { action: "yield" });
	const source = activate(host, teamId);
	const writer = activate(host, teamId);
	endActivation(host, writer, { action: "yield", waitingFor: [source.scope.work], checkpoint: "needs the source" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	const detail = (alias: string): string => updates.at(-1).details.members.find((member: any) => member.alias === alias).detail;
	assert.equal(detail("writer"), `waiting on source (running ${shortWorkRef(source.scope.work!)})`);

	host.runtime.hostControl(teamId).message_manager("Drop the source work.");
	const manager = activate(host, teamId);
	assert.equal(manager.scope.kind, "management");
	const cancel = { action: "control", command: "cancel_work", workId: source.scope.work!.workId, expectedRevision: 1, reason: "Not needed." };
	assert.equal(host.runtime.handleAction(manager.binding, manager.scope, 1, "cancel-source", cancel, "cancel-source").ok, true);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(detail("writer"), "waiting on other work", "source is cancelled, so it is no longer something to wait on");
	assert.equal(detail("source"), `running ${shortWorkRef(source.scope.work!)}`, "until its activation confirms cleanup");

	host.runtime.nativeSettled(source.binding, source.scope.activationId, { status: "aborted" });
	host.runtime.cleanupFinished(source.binding, source.scope.activationId, { ok: true });
	endActivation(host, manager, { action: "yield" }, 2);
	resolveLifetime(terminal(teamId));
	await pending;
});

test("launch final text keeps the Manager's verdict: the waive reason, the whole close reason, and `waived` beside the worker's own status", async () => {
	const { host, tool } = setup();
	const prepared = await tool.execute("prepare", prepareArgs, undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	// More than 400 bytes of CJK whose last sentence used to be cut off.
	const reason = `${"界".repeat(150)}。最后一句必须保留。`;
	const waiveReason = "Quoted three result IDs that do not exist; the content itself was verified separately.";
	let root: TeamResult["roots"][number]["work"] | undefined;
	host.driver.openAndLaunch = async () => {
		host.runtime.launch(teamId);
		const [ref] = completeRoots(host, teamId, () => ({ status: "succeeded", summary: "Worker says everything is done." }));
		root = host.runtime.listWorks(teamId)[0]!.work;
		return { lifetime: Promise.resolve({ ...terminal(teamId), outcome: "partial", reason, finalResultRefs: [ref!],
			roots: [{ work: root, state: "resolved", resultRef: ref!, review: { disposition: "waived", reason: waiveReason } }] }) };
	};
	const result = await tool.execute("launch", { action: "launch", teamId }, undefined, undefined, context());
	const text: string = result.content[0].text;
	const key = workRefKey(root!);
	assert.match(text, new RegExp(`^Team ${teamId} CLOSED · outcome partial · ${reason}$`, "mu"), "the close reason is printed whole");
	assert.match(text, new RegExp(`^Roots: ${key} resolved \\(waived: ${waiveReason}\\)$`, "mu"), "a waived root says why");
	assert.match(text, new RegExp(`^### worker · ${key} · succeeded · waived · result:`, "mu"), "the worker's own status is not the final verdict on the root");

	const header = formatTeamView({ ...host.runtime.getTeam(teamId), reason }, [], 0).find((line) => line.startsWith("Reason:"));
	assert.equal(header, `Reason: ${reason}`, "the Team header's Reason line is not cut at 400 bytes either");
	assert.ok(Buffer.byteLength(reason, "utf8") > 400);
});

test("launch panel reuses grouped subagent panels per member, live and after the Team ends", async () => {
	const { host, tool } = setup();
	const prepared = await tool.execute("prepare", prepareArgs, undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	const preparedPanel = tool.renderResult(prepared, { expanded: false, isPartial: false }, theme).render(200).join("\n");
	assert.match(preparedPanel, /nothing has started.*\n.*ContextWindow native default/u, "prepare shows the pinned plan text");

	let resolveLifetime!: (result: TeamResult) => void;
	const lifetime = new Promise<TeamResult>((resolve) => { resolveLifetime = resolve; });
	host.driver.openAndLaunch = async () => { host.runtime.launch(teamId); return { lifetime }; };
	const live = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 10, turns: 1 };
	host.driver.memberActivity = (_id: string, memberId: string) => memberId !== "worker" ? undefined : {
		transcript: { entries: [{ id: "tool:1", kind: "tool", label: "bash", groupId: "tool:1", text: "git status", status: "running", order: 5 }], omittedEntries: 0 },
		output: "", liveUsage: live, durationMs: 61_000,
	} as any;
	const updates: any[] = [];
	const pending = tool.execute("launch", { action: "launch", teamId }, undefined, (update: any) => updates.push(update), context());
	await new Promise((resolve) => setTimeout(resolve, 300));

	const update = updates.at(-1);
	const [lead, worker] = update.details.members;
	assert.deepEqual([lead.alias, lead.role, worker.alias, worker.role], ["lead", "manager", "worker", "worker"]);
	assert.equal(worker.usage.input, 7, "in-flight native usage is shown before Runtime folds it");
	assert.equal(worker.transcript.entries[0].text, "Inspect the changed files.", "the member's current work is its initial task");
	assert.equal(lead.transcript.entries.some((entry: any) => entry.initial), false, "the Manager's goal is in the Team header, not repeated as its task");
	assert.match(lead.detail, /^dispatched: worker \(queued\) · \d+ pending events$/u, "the Manager's own dispatch is still open");
	assert.equal(worker.status, "waiting", "queued work that has not started yet is waiting, not idle");
	assert.match(worker.detail, /^queued for a worker slot$/u);
	assert.match(update.content[0].text, /lead\s+manager · .*pending events/u);
	const livePanel = tool.renderResult(update, { expanded: false, isPartial: true }, theme).render(160).join("\n");
	assert.match(livePanel, new RegExp(`Team ${teamId} · ACTIVE`, "u"));
	assert.match(livePanel, /2 members · 0 complete · 0 running · 1 waiting · 1 idle · 0 failed/u);
	assert.match(livePanel, /lead · manager · /u);
	assert.match(livePanel, /worker · worker · [^\n]*\n[^\n]*FAST off/u);
	const tagged = { fg: (color: string, text: string) => `{${color}|${text}}`, bold: (text: string) => text };
	const troubled = structuredClone(update);
	troubled.details.view.health = "needs_attention";
	troubled.details.view.incidents = [{ id: "incident:1", code: "WORK_HELD", message: "needs scope", state: "open", createdAt: 1 }];
	const troubledPanel = tool.renderResult(troubled, { expanded: false, isPartial: true }, tagged).render(160).join("\n");
	assert.match(troubledPanel, /^\{warning\|Team [^\n]*needs attention 1/u, "a Team that needs attention is not styled like a healthy one");
	assert.match(troubledPanel, /\{warning\|Incident incident:1 \[WORK_HELD\]/u);
	assert.match(troubledPanel, /\{dim\|Works: /u);
	const expandedPanel = tool.renderResult(update, { expanded: true, isPartial: true }, theme).render(160).join("\n");
	assert.match(expandedPanel, /Recent activity[\s\S]*tool bash\s+git status/u);

	resolveLifetime(terminal(teamId));
	const result = await pending;
	assert.match(result.content[0].text, new RegExp(`Team ${teamId} CLOSED`, "u"), "the model still receives the bounded TeamResult text");
	assert.equal(result.details.members.length, 2, "the finished panel keeps every member panel");
	const finalPanel = tool.renderResult(result, { expanded: false, isPartial: false }, theme).render(160).join("\n");
	assert.match(finalPanel, /lead · manager/u);
	assert.match(finalPanel, /worker · worker/u);
	assert.ok(JSON.parse(JSON.stringify(result.details)).members.length === 2, "details stay serializable for session reload");
});

test("runtime launch abort is a structured tool error, preserves host control, and cannot update a retired generation", async () => {
	const { host, tool } = setup();
	const prepared = await tool.execute("prepare", prepareArgs, undefined, undefined, context());
	const teamId = prepared.details.view.teamId;
	let rejectLifetime!: (error: Error) => void;
	const lifetime = new Promise<TeamResult>((_resolve, reject) => { rejectLifetime = reject; });
	host.driver.openAndLaunch = async (id) => {
		assert.equal(id, teamId);
		host.runtime.launch(teamId);
		return { lifetime };
	};
	const controller = new AbortController();
	const updates: any[] = [];
	const notifications: string[] = [];
	const ctx = { ...context(), ui: { notify: (message: string) => notifications.push(message) } };
	const waiting = tool.execute("launch", { action: "launch", teamId }, controller.signal, (update: any) => updates.push(update), ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	controller.abort();
	await assert.rejects(waiting, (error: unknown) => {
		assert.ok(error instanceof TeamLaunchWaitAbortedError);
		assert.equal(error.code, "TEAM_LAUNCH_WAIT_ABORTED");
		assert.equal(error.lifecycle, "active");
		return true;
	});
	assert.equal(host.runtime.getTeam(teamId).lifecycle, "active", "unknown abort cause does not cancel the Team");
	assert.equal(host.pinnedPolicies(teamId), undefined, "runtime abort occurs only after launch admission");
	const initialUpdateCount = updates.length;
	host.runtime.messageManager(teamId, "late host observation");
	await new Promise((resolve) => setTimeout(resolve, 275));
	assert.equal(updates.length, initialUpdateCount, "a settled launch call receives no late progress callback");
	await host.close("Retire after launch detaches");
	rejectLifetime(new Error("late lifetime failure"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(notifications, [], "a detached lifetime cannot notify through its retired generation");
});
