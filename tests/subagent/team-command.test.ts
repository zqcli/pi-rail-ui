import assert from "node:assert/strict";
import { test } from "node:test";
import { installTeamCommand, runTeamCommand } from "../../tools/subagents/team-command";
import type { SessionBroker } from "../../tools/subagents/session-broker";
import { TeamSessionHost } from "../../tools/subagents/team-host";

function setup(initialRequests: Array<{ to: string; task: string }> = []) {
	const broker = { assertAliasesAvailable: async () => undefined } as unknown as SessionBroker;
	const host = new TeamSessionHost(broker, () => undefined, []);
	const prepared = host.runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage the Team." },
		workers: [{ alias: "worker", roleDescription: "Complete assigned work." }],
		brief: { goal: "Run host-control tests." }, initialRequests, timeoutSeconds: null,
	});
	return { host, teamId: prepared.teamId };
}

function commandContext(options: { hasUI?: boolean; confirmation?: boolean } = {}) {
	const notifications: Array<{ text: string; type: string }> = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (text: string, type: string) => notifications.push({ text, type }),
			confirm: async (title: string, message: string) => { confirmations.push({ title, message }); return options.confirmation ?? true; },
			select: async (_title: string, choices: string[]) => choices[0],
			input: async () => undefined,
		},
	};
	return { ctx: ctx as any, notifications, confirmations };
}

test("rail-team registers ID/subcommand completion and prints every root budget", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root one" }, { to: "worker", task: "root two" }]);
	let command: any;
	installTeamCommand({ registerCommand: (name: string, value: any) => { assert.equal(name, "rail-team"); command = value; } } as any, () => host);
	assert.ok(command.getArgumentCompletions(`${teamId} sta`).some((item: any) => item.label === "status"));
	assert.ok(command.getArgumentCompletions("li").some((item: any) => item.value === "list"));

	const { ctx, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} budget`, ctx);
	const output = notifications.at(-1)?.text ?? "";
	const budget = host.runtime.inspectBudget(teamId);
	assert.match(output, /Team .* budget/u);
	assert.match(output, /teamModelRequests: 0\//u);
	assert.match(output, /Roots \(2\)/u);
	for (const root of budget.roots) assert.ok(output.includes(root.rootId), `missing root ${root.rootId}`);
	assert.match(output, /activations 0\//u);
});

test("budget grants show exact impacts and require confirmation; headless UI cannot mutate", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	const before = host.runtime.inspectBudget(teamId);
	const noUi = commandContext({ hasUI: false });
	await assert.rejects(runTeamCommand(host, `${teamId} grant team teamToolCalls=+3 because the user approved it`, noUi.ctx), /needs interactive confirmation/u);
	assert.deepEqual(host.runtime.inspectBudget(teamId), before);

	const { ctx, confirmations, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} grant team teamToolCalls=+3 because the user approved it`, ctx);
	assert.equal(confirmations.length, 1);
	assert.match(confirmations[0]!.message, /teamToolCalls: used 0 · limit \d+ → \d+/u);
	assert.match(confirmations[0]!.message, /Reason: because the user approved it/u);
	assert.match(confirmations[0]!.message, /Usage never resets/u);
	const after = host.runtime.inspectBudget(teamId);
	assert.equal(after.limits.teamToolCalls, before.limits.teamToolCalls + 3);
	assert.equal(after.grants.length, 1);
	assert.match(notifications.at(-1)?.text ?? "", /Budget granted/u);
});

test("host messages are confirmed and become explicitly attributed Manager events", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	const { ctx, confirmations, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} message Recheck the evidence before closing.`, ctx);
	assert.equal(confirmations.length, 1);
	assert.match(confirmations[0]!.message, /grants no budget or tool permission/u);
	const activation = host.runtime.takeNextActivation(teamId);
	assert.equal(activation?.scope.kind, "management");
	const events = activation?.input.scope.kind === "management" ? activation.input.scope.events : [];
	const event = events.find((item) => item.kind === "USER_COMMAND");
	assert.equal(event?.actor, "@host");
	assert.equal(event?.message, "Recheck the evidence before closing.");
	assert.match(notifications.at(-1)?.text ?? "", /Manager message applied/u);
});

test("cancel of a prepared Team is explicitly confirmed and closes resources without a provider", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "never started" }]);
	const noUi = commandContext({ hasUI: false });
	await assert.rejects(runTeamCommand(host, `${teamId} cancel`, noUi.ctx), /needs interactive confirmation/u);
	assert.equal(host.runtime.getTeam(teamId).lifecycle, "prepared");

	const { ctx, confirmations, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} cancel host test cancellation`, ctx);
	assert.equal(confirmations.length, 1);
	assert.equal(host.runtime.getTeam(teamId).lifecycle, "cancelled");
	assert.ok(host.runtime.getTeam(teamId).members.every((member) => member.resourceState === "released"));
	assert.match(notifications.at(-1)?.text ?? "", /all member exits are confirmed/u);
});
