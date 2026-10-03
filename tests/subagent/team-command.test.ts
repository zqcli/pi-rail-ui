import assert from "node:assert/strict";
import { test } from "node:test";
import { installTeamCommand, runTeamCommand } from "../../tools/subagents/team-command";
import type { SessionBroker } from "../../tools/subagents/session-broker";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import { TEAM_JOURNAL_ENTRY_TYPE } from "../../tools/subagents/team-journal";
import type { TeamOverlayComponent } from "../../tools/subagents/team-overlay";

function setup(initialRequests: Array<{ to: string; task: string }> = [], budget?: "standard" | "long" | "unlimited") {
	const broker = { assertAliasesAvailable: async () => undefined } as unknown as SessionBroker;
	const host = new TeamSessionHost(broker, () => undefined, []);
	const prepared = host.runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage the Team." }, { alias: "worker", roleDescription: "Complete assigned work." }], lead: "lead",
		brief: { goal: "Run host-control tests." }, initialRequests, timeoutSeconds: null, ...(budget ? { budget } : {}),
	});
	return { host, teamId: prepared.teamId };
}

function commandContext(options: { hasUI?: boolean; mode?: "tui" | "rpc"; confirmation?: boolean; overlayKey?: string; message?: string } = {}) {
	const notifications: Array<{ text: string; type: string }> = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	const overlays: Array<{ output: string; options: any; disposed: boolean }> = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
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

test("budget prints unlimited instead of the raw sentinel limit", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root one" }], "unlimited");
	const { ctx, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} budget`, ctx);
	const output = notifications.at(-1)?.text ?? "";
	assert.match(output, /teamModelRequests: 0\/unlimited/u);
	assert.match(output, /activations 0\/unlimited/u);
	assert.doesNotMatch(output, /\/\d{6,}/u);
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
	assert.equal(activation?.scope.kind, "events");
	const events = activation?.input.scope.kind === "events" ? activation.input.scope.events : [];
	const event = events.find((item) => item.kind === "USER_COMMAND");
	assert.equal(event?.actor, "@host");
	assert.equal(event?.message, "Recheck the evidence before closing.");
	assert.match(notifications.at(-1)?.text ?? "", /Lead message applied/u);
});

test("/rail-team lead hands the Team to another member after confirmation and completes member aliases", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	assert.ok(command.getArgumentCompletions(`${teamId} le`).some((item: any) => item.label === "lead"));
	assert.deepEqual(command.getArgumentCompletions(`${teamId} lead `).map((item: any) => item.label), ["worker"], "only members other than the lead");

	const declined = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} lead worker`, declined.ctx);
	assert.equal(host.runtime.getTeam(teamId).lead, "lead");

	const { ctx, notifications, confirmations } = commandContext();
	await runTeamCommand(host, `${teamId} lead worker Rotating the lead`, ctx);
	assert.match(confirmations[0]!.title, /Make worker the lead/u);
	assert.equal(host.runtime.getTeam(teamId).lead, "worker");
	assert.match(notifications.at(-1)?.text ?? "", /worker is now the lead/u);
	const events = host.runtime.takeNextActivation(teamId)!;
	assert.equal(events.binding.memberId, "worker");
	assert.ok(events.input.scope.kind === "events" && events.input.scope.events.some((event) => event.message === "Host made you the Team lead: Rotating the lead"));
	await assert.rejects(runTeamCommand(host, `${teamId} lead`, ctx), /requires a member alias/u);
	await assert.rejects(runTeamCommand(host, `${teamId} lead lead`, ctx), /Team events/u, "refused while worker handles events");
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

test("no arguments opens the Team popup in the TUI; RPC, headless and explicit list keep text output", async () => {
	const { host, teamId } = setup();
	const interactive = commandContext();
	await runTeamCommand(host, "", interactive.ctx);
	assert.equal(interactive.overlays.length, 1);
	assert.equal(interactive.overlays[0]!.options.overlay, true);
	assert.equal(interactive.overlays[0]!.options.overlayOptions.width, "92%");
	assert.match(interactive.overlays[0]!.output, /\[Overview\]/u);
	assert.equal(interactive.notifications.length, 0);
	for (const [args, options] of [["", { hasUI: false, mode: "rpc" }], ["", { mode: "rpc" }], ["list", {}]] as const) {
		const context = commandContext(options);
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
	assert.match(context.notifications[0]!.text, /Lead message applied/u);
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
	assert.equal(title, "Raise Team budget");
	assert.equal(grant.confirmations.length, 0);
});

test("interactive grants offer only higher presets, confirm their preview, and retain the custom flow", async () => {
	const { host, teamId } = setup([], "standard");
	host.runtime.launch(teamId);
	for (const preset of ["long", "unlimited"] as const) {
		const { ctx, confirmations } = commandContext();
		ctx.ui.select = async (title: string, choices: string[]) => {
			assert.equal(title, "Raise Team budget");
			assert.deepEqual(choices, preset === "long" ? ["Raise to long", "Raise to unlimited", "Custom grant…"] : ["Raise to unlimited", "Custom grant…"]);
			return `Raise to ${preset}`;
		};
		await runTeamCommand(host, `${teamId} grant`, ctx);
		assert.match(confirmations[0]!.message, /teamWorks: used 0 · limit \d+ → \d+/u);
		assert.match(confirmations[0]!.message, /Releases no held work/u);
		assert.equal(host.runtime.inspectBudget(teamId).limits.teamActivations, preset === "long" ? 4096 : 1_000_000_000);
	}
	const custom = commandContext({ message: "approved" });
	let selected = 0;
	custom.ctx.ui.select = async (_title: string, choices: string[]) => {
		assert.deepEqual(choices, selected++ === 0 ? ["Custom grant…"] : ["team"]);
		return choices[0];
	};
	custom.ctx.ui.input = async (title: string) => title.startsWith("Increments") ? "teamActivations=+64" : "approved";
	await runTeamCommand(host, `${teamId} grant`, custom.ctx);
	assert.equal(selected, 2);
	assert.equal(host.runtime.inspectBudget(teamId).limits.teamActivations, 1_000_000_064);
	assert.match(custom.confirmations[0]!.message, /limit unlimited → unlimited/u);
});

test("declining a preset confirmation leaves all limits and grants unchanged", async () => {
	const { host, teamId } = setup([], "standard");
	host.runtime.launch(teamId);
	const before = host.runtime.inspectBudget(teamId);
	const { ctx, confirmations } = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} grant`, ctx);
	assert.equal(confirmations.length, 1);
	assert.match(confirmations[0]!.message, /Reason: Raise to long/u);
	assert.deepEqual(host.runtime.inspectBudget(teamId), before);
});

test("review command: now, every (with or without by), off and the bare status, each confirmed; bad forms and the lead are refused", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root" }]);
	host.runtime.launch(teamId);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	const labels = (prefix: string) => command.getArgumentCompletions(prefix)?.map((item: any) => item.value);
	assert.ok(labels(`${teamId} rev`).includes(`${teamId} review`));
	assert.deepEqual(labels(`${teamId} review `), [`${teamId} review now`, `${teamId} review every`, `${teamId} review off`]);
	assert.deepEqual(labels(`${teamId} review every 30 `), [`${teamId} review every 30 by`]);
	assert.deepEqual(labels(`${teamId} review every 30 by `), [`${teamId} review every 30 by worker`], "the lead is not offered");

	const bare = commandContext();
	await runTeamCommand(host, `${teamId} review`, bare.ctx);
	assert.equal(bare.notifications.at(-1)!.text, "Review: off");

	const every = commandContext();
	await runTeamCommand(host, `${teamId} review every 30 by worker`, every.ctx);
	assert.match(every.confirmations[0]!.message, /worker reviews the Team's progress and advises the lead; it cannot request or control work/u);
	assert.deepEqual(host.runtime.reviewSchedule(teamId), { by: "worker", everyMinutes: 30, nextAt: host.runtime.reviewSchedule(teamId)!.nextAt });
	assert.match(every.notifications.at(-1)!.text, /Review set: every 30 min/u);
	await runTeamCommand(host, `${teamId} review every 15`, commandContext().ctx);
	assert.deepEqual(host.runtime.reviewSchedule(teamId), { by: "worker", everyMinutes: 15, nextAt: host.runtime.reviewSchedule(teamId)!.nextAt }, "without by the reviewer stays");
	await runTeamCommand(host, `${teamId} review`, bare.ctx);
	assert.equal(bare.notifications.at(-1)!.text, "Review: worker every 15 min");

	const declined = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} review now`, declined.ctx);
	assert.equal(host.runtime.listWorks(teamId).some((work) => work.kind === "review"), false);
	const now = commandContext();
	await runTeamCommand(host, `${teamId} review now`, now.ctx);
	assert.ok(host.runtime.listWorks(teamId).some((work) => work.kind === "review" && work.assignee === "worker"));
	assert.match(now.notifications.at(-1)!.text, /Review work:\S+@1 started/u);
	await assert.rejects(runTeamCommand(host, `${teamId} review now`, commandContext().ctx), /a review is still open/u);

	for (const bad of ["review every", "review every 0", "review every 5m", "review every 5 worker", "review every 5 by", "review soon", "review now now"]) {
		await assert.rejects(runTeamCommand(host, `${teamId} ${bad}`, commandContext().ctx), /Usage: \/rail-team .* review \[now\|every <N> \[by <alias>\]\|off\]/u, bad);
	}
	await assert.rejects(runTeamCommand(host, `${teamId} review every 5 by lead`, commandContext().ctx), /other than the lead/u);
	await assert.rejects(runTeamCommand(host, `${teamId} review off`, commandContext({ hasUI: false }).ctx), /needs interactive confirmation/u);
	assert.ok(host.runtime.reviewSchedule(teamId));
	const off = commandContext();
	await runTeamCommand(host, `${teamId} review off`, off.ctx);
	assert.equal(host.runtime.reviewSchedule(teamId), undefined);
	assert.match(off.notifications.at(-1)!.text, /Review stopped/u);
	await assert.rejects(runTeamCommand(host, `${teamId} review now`, commandContext().ctx), /no reviewer is set/u);

	host.runtime.cancelTeam(teamId, "done");
	await assert.rejects(runTeamCommand(host, `${teamId} review every 5`, commandContext().ctx), /Team .* is cancelled; its review cannot be changed/u);
	await runTeamCommand(host, `${teamId} review`, bare.ctx);
	assert.equal(bare.notifications.at(-1)!.text, "Review: off");
});

test("review command on a Team from history shows its schedule and reviews, and changes nothing", async () => {
	const at = 1_700_000_000_000;
	const data = [
		{ version: 2, kind: "launched", teamId: "hist-1", at, roster: { lead: "lead", members: ["lead", "worker"] }, goal: "Old goal", review: { by: "worker", everyMinutes: 20 } },
		{ version: 2, kind: "review", teamId: "hist-1", at: at + 1, review: { id: "review:abcd", at: at + 1, by: "worker", work: { workId: "work:x", revision: 1 }, status: "succeeded",
			verdict: "off_track", summary: "OFF TRACK: nothing merged.", snapshot: { elapsedMs: 125_000, works: { total: 1, resolved: 0, running: 1, blocked: 0, held: 0, failed: 0, cancelled: 0 }, finishedSinceLast: 0, budget: [] } } },
	].map((record) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: record }));
	const host = new TeamSessionHost({ assertAliasesAvailable: async () => undefined } as unknown as SessionBroker, () => undefined, data);
	assert.equal(host.history.skipped, 0);
	const { ctx, notifications } = commandContext();
	await runTeamCommand(host, "hist-1 review", ctx);
	assert.equal(notifications.at(-1)!.text, "Review: worker every 20 min\nreview:abcd · 2:05 · worker · off track: OFF TRACK: nothing merged.");
	await assert.rejects(runTeamCommand(host, "hist-1 review now", ctx), /read-only history/u);
});

/** Launch the Team and let the worker's native activation fail: the worker is faulted with its process still owned. */
function faultWorker(host: TeamSessionHost, teamId: string): void {
	const runtime = host.runtime;
	runtime.launch(teamId);
	const take = () => {
		const activation = runtime.takeNextActivation(teamId)!;
		assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
		return activation;
	};
	const boot = take();
	assert.equal(runtime.handleAction(boot.binding, boot.scope, 1, "boot", { action: "yield" }, "boot").ok, true);
	runtime.nativeSettled(boot.binding, boot.scope.activationId, { status: "success", appliedToolCallId: "boot" });
	runtime.cleanupFinished(boot.binding, boot.scope.activationId, { ok: true });
	const work = take();
	runtime.nativeSettled(work.binding, work.scope.activationId, { status: "error", error: { code: "NATIVE_FAILURE", message: "boom" } });
	runtime.cleanupFinished(work.binding, work.scope.activationId, { ok: true });
}

test("/rail-team revive completes faulted aliases, confirms what happens, and reopens the member", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root" }]);
	faultWorker(host, teamId);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	assert.ok(command.getArgumentCompletions(`${teamId} rev`).some((item: any) => item.label === "revive"));
	assert.deepEqual(command.getArgumentCompletions(`${teamId} revive `).map((item: any) => item.label), ["worker"], "only faulted members with a live process");

	const declined = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} revive worker`, declined.ctx);
	assert.equal(host.runtime.getTeam(teamId).members.find((member) => member.id === "worker")!.lifecycle, "faulted");
	await assert.rejects(runTeamCommand(host, `${teamId} revive`, declined.ctx), /requires a member alias/u);

	const { ctx, confirmations, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} revive worker`, ctx);
	assert.match(confirmations[0]!.title, /Revive worker of /u);
	assert.match(confirmations[0]!.message, /reopened.*failed work stays failed/u);
	assert.doesNotMatch(confirmations[0]!.message, /held for the unavailable lead/u);
	assert.equal(host.runtime.getTeam(teamId).members.find((member) => member.id === "worker")!.lifecycle, "open");
	assert.match(notifications.at(-1)?.text ?? "", /worker revived/u);
	assert.equal(command.getArgumentCompletions(`${teamId} revive `), null);
});

test("a unique Team ID prefix is accepted wherever a teamId is parsed; an ambiguous or unknown one is refused", async () => {
	// Deterministic IDs that share a long prefix, as the popup's 8-character Team IDs can.
	let counter = 0;
	const host = new TeamSessionHost({ assertAliasesAvailable: async () => undefined } as unknown as SessionBroker, () => undefined, [], { createId: () => `shared-${String(++counter * 7919).padStart(8, "0")}` });
	const prepare = () => host.runtime.prepare({ members: [{ alias: "lead", roleDescription: "Lead." }, { alias: "worker", roleDescription: "Work." }], lead: "lead", brief: { goal: "Other." }, timeoutSeconds: null }).teamId;
	const teamId = prepare();
	const second = prepare();
	let common = 0;
	while (teamId[common] === second[common]) common++;
	assert.ok(common >= 7 && common < teamId.length - 1, `${teamId} ${second}`);
	const { ctx, notifications } = commandContext();
	await runTeamCommand(host, `${teamId.slice(0, common + 1)} status`, ctx);
	assert.ok(notifications.at(-1)!.text.includes(teamId));
	await assert.rejects(runTeamCommand(host, `${teamId.slice(0, common)} status`, ctx), (error: Error) => error.message.includes("Ambiguous") && error.message.includes(teamId) && error.message.includes(second));
	await assert.rejects(runTeamCommand(host, "nope status", ctx), /Unknown teamId nope/u);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	assert.deepEqual(command.getArgumentCompletions(`${teamId.slice(0, common + 1)} lead `).map((item: any) => item.label), ["worker"], "completion also resolves a prefix");
});

test("popup v asks which faulted member to revive; l asks which open member becomes the lead", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root" }]);
	host.runtime.launch(teamId);
	const none = commandContext({ overlayKey: "v" });
	await runTeamCommand(host, "", none.ctx);
	assert.match(none.notifications[0]!.text, /no faulted member that can be revived/u);
	assert.equal(none.confirmations.length, 0);
	host.runtime.cancelTeam(teamId, "reset");

	const second = setup([{ to: "worker", task: "root" }]);
	faultWorker(second.host, second.teamId);
	const revive = commandContext({ overlayKey: "v" });
	const asked: string[][] = [];
	revive.ctx.ui.select = async (_title: string, choices: string[]) => { asked.push(choices); return choices[0]; };
	await runTeamCommand(second.host, "", revive.ctx);
	assert.deepEqual(asked, [["worker"]]);
	assert.match(revive.confirmations[0]!.title, /Revive worker of /u);
	assert.equal(second.host.runtime.getTeam(second.teamId).members.find((member) => member.id === "worker")!.lifecycle, "open");

	const third = setup();
	third.host.runtime.launch(third.teamId);
	const lead = commandContext({ overlayKey: "l" });
	const options: string[][] = [];
	lead.ctx.ui.select = async (_title: string, choices: string[]) => { options.push(choices); return choices[0]; };
	await runTeamCommand(third.host, "", lead.ctx);
	assert.deepEqual(options, [["worker"]], "only open members other than the lead");
	assert.match(lead.confirmations[0]!.title, /Make worker the lead/u);
	assert.equal(third.host.runtime.getTeam(third.teamId).lead, "worker");
});
