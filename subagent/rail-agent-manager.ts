import * as path from "node:path";
import { SessionManager, type ExtensionCommandContext, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { discoverAgents, type AgentConfig, type AgentDiscoveryResult, type AgentScope } from "./agents";
import type { FileAgentInstanceStore } from "./instance-store";
import type { SessionBroker } from "./session-broker";
import type { SessionAgentRoster } from "./session-links";
import { pickSessionOverlay } from "./session-picker";

const ACTION_CREATE = "Start persistent agent";
const ACTION_LINK = "Link saved session (safe copy)";
const ACTION_ADVANCED = "Advanced: link session in place";
const STATUS_KEY = "rail-agent";

export interface RailAgentManagerRuntime {
	broker: Pick<SessionBroker, "attach" | "detach" | "listLinked">;
	roster: Pick<SessionAgentRoster, "link">;
	store: Pick<FileAgentInstanceStore, "list">;
}

export interface RailAgentManagerDependencies {
	listSessions?: () => Promise<SessionInfo[]>;
	discoverProfiles?: (cwd: string, scope: AgentScope) => AgentDiscoveryResult;
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

function profileLabel(profile: AgentConfig): string {
	return `${profile.name} (${profile.source}) — ${compact(profile.description, 80)}`;
}

function defaultAlias(profileName: string, seed: string): string {
	const base = profileName.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[._-]+|[._-]+$/gu, "").slice(0, 40) || "agent";
	const suffix = seed.replace(/[^A-Za-z0-9]+/gu, "").slice(0, 6).toLowerCase() || Date.now().toString(36).slice(-6);
	return `${base}-${suffix}`;
}

function insertMention(ctx: ExtensionCommandContext, alias: string): void {
	const current = ctx.ui.getEditorText();
	const separator = current && !/\s$/u.test(current) ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}@agent/${alias} `);
}

function insertNewMention(ctx: ExtensionCommandContext, profile: string): void {
	const current = ctx.ui.getEditorText();
	const separator = current && !/\s$/u.test(current) ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}@new/${profile} `);
}

async function chooseProfile(
	ctx: ExtensionCommandContext,
	discoverProfiles: (cwd: string, scope: AgentScope) => AgentDiscoveryResult,
): Promise<AgentConfig | undefined> {
	const discovery = discoverProfiles(ctx.cwd, ctx.isProjectTrusted() ? "both" : "user");
	if (discovery.agents.length === 0) {
		ctx.ui.notify("No agent profiles are available", "warning");
		return undefined;
	}
	const labels = discovery.agents.map(profileLabel);
	const selected = await ctx.ui.select("Agent profile", labels);
	if (!selected) return undefined;
	const profile = discovery.agents[labels.indexOf(selected)];
	if (!profile) return undefined;
	if (profile.source === "project") {
		const approved = await ctx.ui.confirm("Use project-local agent?", `${profile.name}\n${profile.filePath}`);
		if (!approved) return undefined;
	}
	return profile;
}

async function startPersistentAgent(
	ctx: ExtensionCommandContext,
	discoverProfiles: (cwd: string, scope: AgentScope) => AgentDiscoveryResult,
): Promise<void> {
	const profile = await chooseProfile(ctx, discoverProfiles);
	if (!profile) return;
	insertNewMention(ctx, profile.name);
	ctx.ui.notify(`Describe the task after @new/${profile.name}; the persistent agent will be created when you submit`, "info");
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
	dependencies: Required<RailAgentManagerDependencies>,
	mode: "fork" | "exclusive",
): Promise<void> {
	const selected = await chooseSession(ctx, await dependencies.listSessions());
	if (!selected) return;
	const managed = (await runtime.store.list()).find((instance) => path.resolve(instance.sessionFile) === path.resolve(selected.path));
	if (managed) {
		const alias = managed.alias;
		runtime.roster.link(alias, managed.agentId);
		insertMention(ctx, alias);
		ctx.ui.notify(`Linked ${alias}; mention inserted in the editor`, "info");
		return;
	}
	const profile = await chooseProfile(ctx, dependencies.discoverProfiles);
	if (!profile) return;
	const alias = defaultAlias(profile.name, selected.id);
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
			agent: profile.name,
			profile,
			alias,
			cwd: selected.cwd || ctx.cwd,
			session: { mode, path: selected.path },
		});
		insertMention(ctx, instance.alias);
		ctx.ui.notify(`Linked ${instance.alias}; mention inserted in the editor`, "info");
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function manageLinkedAgents(ctx: ExtensionCommandContext, runtime: RailAgentManagerRuntime): Promise<void> {
	const instances = await runtime.broker.listLinked();
	if (instances.length === 0) {
		ctx.ui.notify("No persistent agents are linked to this session branch", "info");
		return;
	}
	const labels = instances.map((instance) => `${instance.alias} · ${instance.profile.name} · ${compact(instance.lastTask)}`);
	const selected = await ctx.ui.select("Linked agents", labels);
	if (!selected) return;
	const instance = instances[labels.indexOf(selected)];
	if (!instance) return;
	const action = await ctx.ui.select(instance.alias, ["Insert mention", "Show details", "Detach"]);
	if (action === "Insert mention") {
		insertMention(ctx, instance.alias);
		return;
	}
	if (action === "Show details") {
		ctx.ui.notify(`${instance.alias} (${instance.agentId})\n${compact(instance.profile.name)}\n${compact(instance.cwd, 120)}\n${compact(instance.lastTask, 200)}`, "info");
		return;
	}
	if (action === "Detach") {
		const approved = await ctx.ui.confirm("Detach persistent agent?", "The child session will be kept and can be linked again later.");
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
	const resolved: Required<RailAgentManagerDependencies> = {
		listSessions: dependencies.listSessions ?? (() => SessionManager.listAll()),
		discoverProfiles: dependencies.discoverProfiles ?? discoverAgents,
	};
	const linked = await runtime.broker.listLinked();
	const linkedAction = `Linked agents (${linked.length})`;
	const actions = linked.length > 0
		? [linkedAction, ACTION_CREATE, ACTION_LINK, ACTION_ADVANCED]
		: [ACTION_CREATE, ACTION_LINK, ACTION_ADVANCED];
	const action = await ctx.ui.select("Rail agents", actions);
	if (!action) return;
	if (action === ACTION_CREATE) return startPersistentAgent(ctx, resolved.discoverProfiles);
	if (action === ACTION_LINK) return linkSavedSession(ctx, runtime, resolved, "fork");
	if (action === ACTION_ADVANCED) return linkSavedSession(ctx, runtime, resolved, "exclusive");
	if (action === linkedAction) return manageLinkedAgents(ctx, runtime);
}
