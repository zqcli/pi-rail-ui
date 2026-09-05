import * as path from "node:path";
import { SessionManager, type ExtensionCommandContext, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { FileAgentInstanceStore } from "./instance-store";
import type { RailAgentManager } from "./agent-manager";
import { pickRailModel } from "./model-picker";
import { availableRailModels, railModelReference, type RailModelRef } from "./models";
import { showRailAgentOverlay } from "./rail-agent-overlay";
import type { SessionBroker } from "./session-broker";
import type { SessionAgentRoster } from "./session-links";
import { pickSessionOverlay } from "./session-picker";

const ACTION_CREATE = "Start persistent model session";
const ACTION_LINK = "Link saved session (safe copy)";
const ACTION_ADVANCED = "Advanced: link session in place";
const STATUS_KEY = "rail-agent";

export interface RailAgentManagerRuntime {
	manager?: RailAgentManager;
	broker: Pick<SessionBroker, "attach" | "detach" | "listLinked">;
	roster: Pick<SessionAgentRoster, "link">;
	store: Pick<FileAgentInstanceStore, "list">;
}

export interface RailAgentManagerDependencies {
	listSessions?: () => Promise<SessionInfo[]>;
}

function compact(value: string, maxLength = 64): string {
	const oneLine = stripTerminalSequences(value).replace(/\s+/gu, " ").trim();
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 3)}...`;
}

function sessionLabel(info: SessionInfo, index: number, currentCwd: string): string {
	const current = path.resolve(info.cwd || path.dirname(info.path)) === path.resolve(currentCwd);
	const title = compact(info.name || info.firstMessage) || info.id.slice(0, 8);
	const project = compact(path.basename(info.cwd || path.dirname(info.path)), 24);
	return `${index + 1}. ${current ? "Current" : project} · ${title} · ${info.modified.toLocaleDateString()}`;
}

function defaultAlias(modelId: string, seed: string): string {
	const base = modelId.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[._-]+|[._-]+$/gu, "").slice(0, 40) || "model";
	const suffix = seed.replace(/[^A-Za-z0-9]+/gu, "").slice(0, 6).toLowerCase() || Date.now().toString(36).slice(-6);
	return `${base}-${suffix}`;
}

function insertMention(ctx: ExtensionCommandContext, alias: string): void {
	const current = ctx.ui.getEditorText();
	const separator = current && !/\s$/u.test(current) ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}@agent/${alias} `);
}

function insertNewMention(ctx: ExtensionCommandContext, model: RailModelRef): void {
	const current = ctx.ui.getEditorText();
	const separator = current && !/\s$/u.test(current) ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}@new/${railModelReference(model)} `);
}

async function startPersistentSession(ctx: ExtensionCommandContext): Promise<void> {
	const model = await pickRailModel(ctx);
	if (!model) return;
	insertNewMention(ctx, model);
	const reference = railModelReference(model);
	ctx.ui.notify(`Describe the task after @new/${reference}; a persistent session will be created when you submit`, "info");
}

async function chooseSession(ctx: ExtensionCommandContext, sessions: SessionInfo[]): Promise<SessionInfo | undefined> {
	const parentFile = ctx.sessionManager.getSessionFile();
	const available = sessions
		.filter((info) => info.path !== parentFile)
		.sort((a, b) => {
			const aCurrent = path.resolve(a.cwd || path.dirname(a.path)) === path.resolve(ctx.cwd);
			const bCurrent = path.resolve(b.cwd || path.dirname(b.path)) === path.resolve(ctx.cwd);
			if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
			return b.modified.getTime() - a.modified.getTime();
		})
		.slice(0, 250);
	if (available.length === 0) {
		ctx.ui.notify("No saved Pi sessions are available", "warning");
		return undefined;
	}
	if (ctx.mode === "tui") return pickSessionOverlay(ctx, available);
	const labels = available.map((info, index) => sessionLabel(info, index, ctx.cwd));
	const selected = await ctx.ui.select("Saved Pi session", labels);
	return selected ? available[labels.indexOf(selected)] : undefined;
}

async function linkSavedSession(
	ctx: ExtensionCommandContext,
	runtime: RailAgentManagerRuntime,
	listSessions: () => Promise<SessionInfo[]>,
	mode: "fork" | "exclusive",
): Promise<void> {
	const selected = await chooseSession(ctx, await listSessions());
	if (!selected) return;
	const managed = mode === "exclusive" && (await runtime.store.list()).find((instance) => path.resolve(instance.sessionFile) === path.resolve(selected.path));
	const managedView = managed && runtime.manager
		? (await runtime.manager.snapshot()).agents.find((agent) => agent.instance.agentId === managed.agentId)
		: undefined;
	if (managed && managedView?.phase !== "in-use-elsewhere" && managedView?.phase !== "unknown") {
		runtime.roster.link(managed.alias, managed.agentId);
		insertMention(ctx, managed.alias);
		ctx.ui.notify(`Linked ${managed.alias}; mention inserted in the editor`, "info");
		return;
	}
	const model = await pickRailModel(ctx);
	if (!model) return;
	const alias = defaultAlias(model.modelId, selected.id);
	if (mode === "exclusive") {
		const approved = await ctx.ui.confirm(
			"Link session in place?",
			"Only continue if no other Pi process has this session open. The safe-copy action is recommended.",
		);
		if (!approved) return;
	}
	ctx.ui.setStatus(STATUS_KEY, mode === "fork" ? "Copying and linking session..." : "Linking session in place...");
	try {
		const instance = await runtime.broker.attach({
			model,
			alias,
			cwd: selected.cwd || ctx.cwd,
			session: { mode, path: selected.path },
		});
		insertMention(ctx, instance.alias);
		ctx.ui.notify(`Linked ${instance.alias} to ${railModelReference(model)}; mention inserted`, "info");
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function manageLinkedSessions(ctx: ExtensionCommandContext, runtime: RailAgentManagerRuntime): Promise<void> {
	const instances = await runtime.broker.listLinked();
	if (instances.length === 0) {
		ctx.ui.notify("No persistent model sessions are linked to this conversation branch", "info");
		return;
	}
	const labels = instances.map((instance) => `${instance.alias} · ${railModelReference(instance.model)} · ${compact(instance.lastTask)}`);
	const selected = await ctx.ui.select("Linked model sessions", labels);
	if (!selected) return;
	const instance = instances[labels.indexOf(selected)];
	if (!instance) return;
	const action = await ctx.ui.select(instance.alias, ["Insert mention", "Show details", "Detach"]);
	if (action === "Insert mention") {
		insertMention(ctx, instance.alias);
		return;
	}
	if (action === "Show details") {
		ctx.ui.notify(`${instance.alias} (${instance.agentId})\n${railModelReference(instance.model)}\n${compact(instance.cwd, 120)}\n${compact(instance.lastTask, 200)}`, "info");
		return;
	}
	if (action === "Detach") {
		const approved = await ctx.ui.confirm("Detach model session?", "The child session will be kept and can be linked again later.");
		if (!approved) return;
		await runtime.broker.detach(instance.alias);
		ctx.ui.notify(`Detached ${instance.alias}; child session was kept`, "info");
	}
}

export async function runRailAgentManager(
	ctx: ExtensionCommandContext,
	runtime: RailAgentManagerRuntime,
	dependencies: RailAgentManagerDependencies = {},
): Promise<void> {
	if (!ctx.hasUI) throw new Error("/rail-agent requires TUI or RPC UI support");
	const listSessions = dependencies.listSessions ?? (() => SessionManager.listAll());
	if (ctx.mode === "tui") {
		if (!runtime.manager) throw new Error("Rail agent manager runtime is not configured");
		const parentFile = ctx.sessionManager.getSessionFile();
		const models = availableRailModels(ctx);
		return showRailAgentOverlay(ctx, {
			manager: runtime.manager,
			models,
			loadSessions: async () => (await listSessions())
				.filter((session) => session.path !== parentFile)
				.sort((left, right) => right.modified.getTime() - left.modified.getTime())
				.slice(0, 250),
			currentCwd: ctx.cwd,
			insertMention: (alias) => insertMention(ctx, alias),
		});
	}
	const linked = await runtime.broker.listLinked();
	const linkedAction = `Linked model sessions (${linked.length})`;
	const actions = linked.length > 0
		? [linkedAction, ACTION_CREATE, ACTION_LINK, ACTION_ADVANCED]
		: [ACTION_CREATE, ACTION_LINK, ACTION_ADVANCED];
	const action = await ctx.ui.select("Rail agents", actions);
	if (!action) return;
	if (action === ACTION_CREATE) return startPersistentSession(ctx);
	if (action === ACTION_LINK) return linkSavedSession(ctx, runtime, listSessions, "fork");
	if (action === ACTION_ADVANCED) return linkSavedSession(ctx, runtime, listSessions, "exclusive");
	if (action === linkedAction) return manageLinkedSessions(ctx, runtime);
}
