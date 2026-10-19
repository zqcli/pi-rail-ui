import assert from "node:assert/strict";
import { test } from "node:test";
import installRailUi from "../../index";

async function railUiCommands(sendUserMessage: (...args: any[]) => void = () => {}) {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const channels = new Map<string, Set<(data: unknown) => void>>();
	await installRailUi({
		registerTool: () => undefined,
		sendUserMessage,
		registerCommand: (name: string, options: any) => { commands.set(name, options.handler); },
		registerProvider: () => undefined,
		on: () => undefined,
		events: {
			emit: (channel: string, data: unknown) => { for (const handler of channels.get(channel) ?? []) handler(data); },
			on: (channel: string, handler: (data: unknown) => void) => {
				const handlers = channels.get(channel) ?? new Set<(data: unknown) => void>();
				handlers.add(handler);
				channels.set(channel, handlers);
				return () => handlers.delete(handler);
			},
		},
	} as any);
	return commands;
}

function context(mode: string) {
	const notifications: Array<[string, string]> = [];
	const ctx: any = {
		mode,
		ui: {
			notify: (text: string, level: string) => notifications.push([text, level]),
			setEditorComponent: () => undefined,
			setFooter: () => undefined,
		},
	};
	return { ctx, notifications };
}

test("/rail-ui outside the TUI warns and leaves the toggle untouched", async () => {
	const handler = (await railUiCommands()).get("rail-ui")!;
	const rpc = context("rpc");
	await handler("", rpc.ctx);
	assert.deepEqual(rpc.notifications, [["/rail-ui requires interactive TUI mode.", "warning"]]);

	// The ignored call must not have flipped the state: the first TUI toggle still disables.
	const tui = context("tui");
	await handler("", tui.ctx);
	assert.deepEqual(tui.notifications, [["Pi rail UI disabled", "info"]]);
});

test("/rail-ui disabling the custom interface never pauses or cancels an armed continuation", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const sends: Array<[string, unknown]> = [];
	const commands = await railUiCommands((message, options) => sends.push([message, options]));
	const { ctx } = context("tui");
	const statuses = new Map<string, string>();
	ctx.sessionManager = { getSessionId: () => "rail-toggle-continue" };
	ctx.isIdle = () => true;
	ctx.hasPendingMessages = () => false;
	ctx.ui.setStatus = (key: string, value?: string) => value === undefined ? statuses.delete(key) : statuses.set(key, value);
	try {
		await commands.get("rail-continue")!("2s continue without Rail UI", ctx);
		t.mock.timers.tick(500);
		await commands.get("rail-ui")!("", ctx);
		assert.equal(statuses.get("rail-continue"), "CONT-1-1m");
		t.mock.timers.tick(1499);
		assert.equal(sends.length, 0);
		t.mock.timers.tick(1);
		assert.deepEqual(sends, [["continue without Rail UI", { expandPromptTemplates: false }]]);
		assert.equal(statuses.has("rail-continue"), false);
	} finally { await commands.get("rail-continue")!("cancel all", ctx); }
});
