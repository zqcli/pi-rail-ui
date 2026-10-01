import assert from "node:assert/strict";
import { test } from "node:test";
import { installTeamCommand, runTeamCommand } from "../../tools/subagents/team-command";
import type { SessionBroker } from "../../tools/subagents/session-broker";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import type { TeamOverlayComponent } from "../../tools/subagents/team-overlay";

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

function commandContext(options: { hasUI?: boolean; confirmation?: boolean; overlayKey?: string; message?: string } = {}) {
	const notifications: Array<{ text: string; type: string }> = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	const overlays: Array<{ output: string; options: any; disposed: boolean }> = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (text: string, type: string) => notifications.push({ text, type }),
			confirm: async (title: string, message: string) => { confirmations.push({ title, message }); return options.confirmation ?? true; },
			select: async (_title: string, choices: string[]) => choices[0],
			input: async () => options.message,
			custom: async (factory: any, overlayOptions: any) => {
				let result: unknown;
				let component: TeamOverlayComponent;
				const record = { output: "", options: overlayOptions, disposed: false };
				component = factory({ requestRender: () => undefined, terminal: { rows: 40 } },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text }, { matches: () => false },
					(value: unknown) => { result = value; component.dispose(); record.disposed = true; });
				record.output = component.render(100).join("\n");
				overlays.push(record);
				component.handleInput(options.overlayKey ?? "\x1b");
				return result;
			},
		},
	};
	return { ctx: ctx as any, notifications, confirmations, overlays };
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

test("no arguments opens the Team popup with UI; headless and explicit list keep text output", async () => {
	const { host, teamId } = setup();
	const interactive = commandContext();
	await runTeamCommand(host, "", interactive.ctx);
	assert.equal(interactive.overlays.length, 1);
	assert.equal(interactive.overlays[0]!.options.overlay, true);
	assert.equal(interactive.overlays[0]!.options.overlayOptions.width, "92%");
	assert.match(interactive.overlays[0]!.output, /\[Overview\]/u);
	assert.equal(interactive.notifications.length, 0);
	for (const [args, hasUI] of [["", false], ["list", true]] as const) {
		const context = commandContext({ hasUI });
		await runTeamCommand(host, args, context.ctx);
		assert.equal(context.overlays.length, 0);
		assert.ok(context.notifications[0]!.text.includes(teamId));
	}
});

test("popup cancel closes before the existing confirmation and respects rejection", async () => {
	for (const confirmation of [false, true]) {
		const { host, teamId } = setup();
		const context = commandContext({ overlayKey: "c", confirmation });
		const confirm = context.ctx.ui.confirm;
		context.ctx.ui.confirm = async (title: string, message: string) => {
			assert.equal(context.overlays[0]!.disposed, true);
			return confirm(title, message);
		};
		await runTeamCommand(host, "", context.ctx);
		assert.equal(context.confirmations.length, 1);
		assert.equal(context.confirmations[0]!.title, `Cancel Team ${teamId}?`);
		assert.equal(host.runtime.getTeam(teamId).lifecycle, confirmation ? "cancelled" : "prepared");
	}
});

test("popup message gathers text then uses existing confirmation, or cancels without mutation", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	const cancelled = commandContext({ overlayKey: "m" });
	await runTeamCommand(host, "", cancelled.ctx);
	assert.equal(cancelled.confirmations.length, 0);
	const context = commandContext({ overlayKey: "m", message: "Review this work" });
	await runTeamCommand(host, "", context.ctx);
	assert.equal(context.confirmations.length, 1);
	assert.match(context.confirmations[0]!.message, /Review this work/u);
	assert.match(context.notifications[0]!.text, /Manager message applied/u);
});

test("popup resume and grant enter the existing selection paths", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	const resume = commandContext({ overlayKey: "r" });
	await runTeamCommand(host, "", resume.ctx);
	assert.match(resume.notifications[0]!.text, /has no held work/u);
	const grant = commandContext({ overlayKey: "g" });
	let title = "";
	grant.ctx.ui.select = async (value: string) => { title = value; return undefined; };
	await runTeamCommand(host, "", grant.ctx);
	assert.equal(title, "Grant budget to");
	assert.equal(grant.confirmations.length, 0);
});
