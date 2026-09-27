import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentInstance, SessionBroker } from "../../tools/subagents/session-broker";
import type { RailModelRef } from "../../tools/subagents/models";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import type { TeamJournalRecord } from "../../tools/subagents/team-journal";
import { TEAM_MAX_LIVE_TEAMS, type BindingV2 } from "../../tools/subagents/team-protocol";

const model: RailModelRef = { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" };

function fakeBroker(onClose: (memberId: string) => void): SessionBroker {
	let nextAgent = 0;
	return {
		async openTeamMember({ binding }: { binding: BindingV2 }) {
			const instance = {
				version: 2,
				agentId: `agt_test${++nextAgent}`,
				alias: binding.memberId,
				model,
				sessionId: `session-${binding.memberId}`,
				sessionFile: `/tmp/${binding.memberId}.jsonl`,
				cwd: process.cwd(),
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
				lastTask: "Team member",
			} as AgentInstance;
			return {
				instance,
				sessionId: instance.sessionId,
				async runActivation(_activation: unknown, _onRequest: unknown, onNativeSettled: (completion: { status: "aborted" }) => void, signal?: AbortSignal) {
					if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
					onNativeSettled({ status: "aborted" });
				},
				terminate() {},
				async close() { onClose(binding.memberId); return {}; },
			};
		},
	} as unknown as SessionBroker;
}

async function createActiveHost(branch: string, records: Array<{ branch: string; record: TeamJournalRecord }>, onClose: (memberId: string) => void) {
	const broker = fakeBroker(onClose);
	const host = new TeamSessionHost(broker, (record) => records.push({ branch, record }), []);
	const prepared = host.runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage the Team." },
		workers: [{ alias: "worker", roleDescription: "Complete assigned work." }],
		brief: { goal: "Exercise the branch-owned Team lifecycle." },
		initialRequests: [],
		timeoutSeconds: null,
	});
	for (const memberId of ["lead", "worker"]) await host.driver.openMember({ teamId: prepared.teamId, memberId, model });
	return { host, teamId: prepared.teamId, lifetime: host.driver.launch(prepared.teamId) };
}

test("session host journals interruption before cleanup and seals its branch generation", async () => {
	let branch = "old-branch";
	const records: Array<{ branch: string; record: TeamJournalRecord }> = [];
	const closeOrder: string[] = [];
	const active = await createActiveHost(branch, records, (memberId) => {
		assert.equal(records.at(-1)?.record.kind, "interrupted", "the synchronous marker precedes asynchronous native cleanup");
		closeOrder.push(memberId);
	});
	const lifetime = active.lifetime.then((result) => result, (error: unknown) => { throw error; });

	await active.host.close("Session tree navigation");
	const result = await lifetime;
	branch = "new-branch";

	assert.equal(result.lifecycle, "interrupted");
	assert.deepEqual(records.map(({ branch: owner, record }) => [owner, record.kind]), [
		["old-branch", "launched"], ["old-branch", "interrupted"],
	]);
	assert.deepEqual(closeOrder.sort(), ["lead", "worker"]);
	assert.equal(active.host.journal.active, false);
	assert.throws(() => active.host.journal.write({ version: 2, kind: "interrupted", teamId: active.teamId, at: 1, reason: "late callback" }), /inactive/u);
	assert.equal(records.some((entry) => entry.branch === branch), false, "late work can never append to the selected branch");
});

test("host shutdown writes no interruption marker for a Team that already ended", async () => {
	const records: Array<{ branch: string; record: TeamJournalRecord }> = [];
	const active = await createActiveHost("current", records, () => {});
	const ended = await active.host.driver.stopTeam(active.teamId, "finished before the session switch");
	assert.equal(ended.lifecycle, "cancelled");
	await active.host.close("Parent session switch (resume)");
	assert.deepEqual(records.map(({ record }) => record.kind), ["launched", "terminal"],
		"the terminal fact stays last; an ended Team is never re-marked interrupted");
});

test("interruption journal write failure is surfaced as a host diagnostic while native cleanup still runs", async () => {
	const records: Array<{ branch: string; record: TeamJournalRecord }> = [];
	const closed: string[] = [];
	const broker = fakeBroker((memberId) => closed.push(memberId));
	const host = new TeamSessionHost(broker, (record) => {
		if (record.kind === "interrupted") throw new Error("synthetic journal disk failure");
		records.push({ branch: "current", record });
	}, []);
	const prepared = host.runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage the Team." },
		workers: [{ alias: "worker", roleDescription: "Complete assigned work." }],
		brief: { goal: "Surface missing interruption history." }, initialRequests: [], timeoutSeconds: null,
	});
	for (const memberId of ["lead", "worker"]) await host.driver.openMember({ teamId: prepared.teamId, memberId, model });
	const lifetime = host.driver.launch(prepared.teamId);

	await host.close("Journal failure test");
	const result = await lifetime;
	assert.ok(host.diagnostics.some((diagnostic) => diagnostic.teamId === prepared.teamId
		&& diagnostic.code === "INTERRUPTION_JOURNAL_FAILED" && /synthetic journal disk failure/u.test(diagnostic.message)));
	assert.deepEqual(closed.sort(), ["lead", "worker"], "journal failure does not skip native exit cleanup");
	assert.equal(records.some(({ record }) => record.kind === "interrupted"), false, "failure is not represented as a durable marker");
	assert.equal(host.journal.active, false);
	assert.ok(result.lifecycle === "interrupted" || result.lifecycle === "failed");
});

test("post-tree fallback retires the old writer without appending into the new leaf", async () => {
	const records: Array<{ branch: string; record: TeamJournalRecord }> = [];
	let branch = "old-branch";
	const active = await createActiveHost(branch, records, () => {});
	const lifetime = active.lifetime.then((result) => result, (error: unknown) => { throw error; });
	branch = "new-branch";

	await active.host.closeAfterBranchChange("Tree already changed");
	const result = await lifetime;

	assert.equal(result.lifecycle, "interrupted");
	assert.deepEqual(records.map(({ branch: owner, record }) => [owner, record.kind]), [["old-branch", "launched"]]);
	assert.equal(active.host.journal.active, false);
});

test("the driver forgets member activity of Teams the Runtime has evicted", async () => {
	const host = new TeamSessionHost(fakeBroker(() => {}), () => {}, []);
	const teamIds: string[] = [];
	for (let index = 0; index < TEAM_MAX_LIVE_TEAMS + 1; index++) {
		const prepared = host.runtime.prepare({
			manager: { alias: `lead-${index}`, roleDescription: "Manage the Team." },
			workers: [{ alias: `worker-${index}`, roleDescription: "Complete assigned work." }],
			brief: { goal: "Exercise driver bookkeeping." },
			initialRequests: [],
			timeoutSeconds: null,
		});
		teamIds.push(prepared.teamId);
		await host.driver.openMember({ teamId: prepared.teamId, memberId: `lead-${index}`, model });
		assert.ok(host.driver.memberActivity(prepared.teamId, `lead-${index}`));
		await host.driver.stopTeam(prepared.teamId, "done");
	}
	assert.equal(host.runtime.listTeams().some((team) => team.teamId === teamIds[0]), false, "the Runtime evicted the oldest ended Team");
	assert.equal(host.driver.memberActivity(teamIds[0]!, "lead-0"), undefined, "its member activity is released with it");
	assert.ok(host.driver.memberActivity(teamIds.at(-1)!, `lead-${TEAM_MAX_LIVE_TEAMS}`), "retained Teams keep their activity");
});
