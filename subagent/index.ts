import * as path from "node:path";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig, type AgentScope } from "./agents";
import { FileAgentInstanceStore } from "./instance-store";
import {
	applySubagentMentionCompletion,
	buildSubagentRosterPrompt,
	extractSubagentMentions,
	subagentMentionSuggestions,
} from "./interaction";
import type { RpcEvent } from "./rpc-worker";
import { SessionBroker } from "./session-broker";
import { SessionAgentRoster } from "./session-links";
import { installStatefulSubagentTool } from "./tool";
import { createRpcWorkerFactory } from "./worker-factory";

interface SubagentRuntime {
	ctx: ExtensionContext;
	broker: SessionBroker;
	roster: SessionAgentRoster;
	store: FileAgentInstanceStore;
}

function sessionTitle(info: SessionInfo, index: number): string {
	const title = info.name?.trim() || info.firstMessage.trim().replace(/\s+/gu, " ").slice(0, 60) || info.id.slice(0, 8);
	const cwd = path.basename(info.cwd || path.dirname(info.path));
	return `${index + 1}. ${title} · ${cwd} · ${info.modified.toLocaleDateString()}`;
}

function profileTitle(profile: AgentConfig): string {
	return `${profile.name} (${profile.source}) — ${profile.description}`;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

export default function installStatefulSubagent(pi: ExtensionAPI): void {
	if (Number(process.env["PI_SUBAGENT_DEPTH"] ?? "0") > 0) return;
	const stateDir = path.join(getAgentDir(), "stateful-subagents");
	let runtime: SubagentRuntime | undefined;

	const getRuntime = (): SubagentRuntime => {
		if (!runtime) throw new Error("Persistent subagent runtime is not ready");
		return runtime;
	};

	const handleChildUiRequest = async (
		request: RpcEvent,
		source: { agentId: string; alias: string },
	): Promise<Record<string, unknown> | undefined> => {
		const current = runtime?.ctx;
		if (!current?.hasUI) return { cancelled: true };
		const method = request["method"];
		if (method === "notify") {
			const notifyType = request["notifyType"];
			current.ui.notify(`[${source.alias}] ${String(request["message"] ?? "")}`, notifyType === "warning" || notifyType === "error" ? notifyType : "info");
			return undefined;
		}
		if (method === "setStatus") {
			current.ui.setStatus(`subagent:${source.agentId}:${String(request["statusKey"] ?? "child")}`, request["statusText"] === undefined ? undefined : String(request["statusText"]));
			return undefined;
		}
		if (method === "setWidget") {
			const lines = Array.isArray(request["widgetLines"]) ? request["widgetLines"].map(String) : undefined;
			current.ui.setWidget(
				`subagent:${source.agentId}:${String(request["widgetKey"] ?? "child")}`,
				lines,
				{ placement: request["widgetPlacement"] === "belowEditor" ? "belowEditor" : "aboveEditor" },
			);
			return undefined;
		}
		if (method === "setTitle") {
			current.ui.setTitle(`[${source.alias}] ${String(request["title"] ?? "")}`);
			return undefined;
		}
		if (method === "set_editor_text") {
			current.ui.setEditorText(String(request["text"] ?? ""));
			return undefined;
		}
		if (method === "confirm") {
			return { confirmed: await current.ui.confirm(`[${source.alias}] ${String(request["title"] ?? "Subagent")}`, String(request["message"] ?? "")) };
		}
		if (method === "select") {
			const options = Array.isArray(request["options"]) ? request["options"].map(String) : [];
			const value = await current.ui.select(`[${source.alias}] ${String(request["title"] ?? "Subagent")}`, options);
			return value === undefined ? { cancelled: true } : { value };
		}
		if (method === "input") {
			const value = await current.ui.input(`[${source.alias}] ${String(request["title"] ?? "Subagent")}`, String(request["placeholder"] ?? ""));
			return value === undefined ? { cancelled: true } : { value };
		}
		if (method === "editor") {
			const value = await current.ui.editor(`[${source.alias}] ${String(request["title"] ?? "Subagent")}`, String(request["prefill"] ?? ""));
			return value === undefined ? { cancelled: true } : { value };
		}
		return { cancelled: true };
	};

	installStatefulSubagentTool(pi, {
		broker: () => getRuntime().broker,
		discoverProfiles: discoverAgents,
	});

	const installAutocomplete = (ctx: ExtensionContext) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: unique([...(current.triggerCharacters ?? []), "@"]),
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);
				const active = runtime;
				if (active) {
					const instances = await active.broker.listLinked();
					const profiles = discoverAgents(ctx.cwd, ctx.isProjectTrusted() ? "both" : "user").agents;
					const suggestions = subagentMentionSuggestions(
						beforeCursor,
						instances.map((instance) => ({ alias: instance.alias, description: `${instance.profile.name} · ${instance.lastTask}` })),
						profiles.map((profile) => ({
							name: profile.name,
							source: profile.source,
							description: `${profile.source} · ${profile.description}`,
						})),
					);
					if (suggestions) return suggestions;
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return prefix.startsWith("@agent/") || prefix.startsWith("@new/")
					? applySubagentMentionCompletion(lines, cursorLine, cursorCol, item.value, prefix)
					: current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (/(?:^|\s)@(agent|new)\/[^\s@]*$/u.test(beforeCursor)) return false;
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	};

	const attachExistingSession = async (ctx: ExtensionContext) => {
		const active = getRuntime();
		const scopeChoice = await ctx.ui.select("Session scope", ["Current project", "All projects"]);
		if (!scopeChoice) return;
		const sessions = (scopeChoice === "All projects" ? await SessionManager.listAll() : await SessionManager.list(ctx.cwd))
			.filter((info) => info.path !== ctx.sessionManager.getSessionFile())
			.sort((a, b) => b.modified.getTime() - a.modified.getTime())
			.slice(0, 250);
		if (sessions.length === 0) {
			ctx.ui.notify("No attachable sessions found", "warning");
			return;
		}
		const labels = sessions.map(sessionTitle);
		const selectedLabel = await ctx.ui.select("Select a Pi session", labels);
		if (!selectedLabel) return;
		const selected = sessions[labels.indexOf(selectedLabel)];
		if (!selected) return;

		const managed = (await active.store.list()).find((instance) => instance.sessionFile === selected.path);
		if (managed) {
			const alias = await ctx.ui.input("Persistent alias", managed.alias);
			if (!alias?.trim()) return;
			active.roster.link(alias.trim(), managed.agentId);
			ctx.ui.notify(`Attached managed subagent ${alias.trim()}`, "info");
			return;
		}

		const profileScope: AgentScope = ctx.isProjectTrusted() ? "both" : "user";
		const profiles = discoverAgents(ctx.cwd, profileScope).agents;
		const profileLabels = profiles.map(profileTitle);
		const selectedProfileLabel = await ctx.ui.select("Adopt session as profile", profileLabels);
		if (!selectedProfileLabel) return;
		const profile = profiles[profileLabels.indexOf(selectedProfileLabel)];
		if (!profile) return;
		if (profile.source === "project") {
			const approved = await ctx.ui.confirm("Use project-local agent?", `${profile.name}\n${profile.filePath}`);
			if (!approved) return;
		}
		const defaultAlias = `${profile.name}-${selected.id.slice(0, 6)}`;
		const alias = await ctx.ui.input("Persistent alias", defaultAlias);
		if (!alias?.trim()) return;
		const modeLabel = await ctx.ui.select("Attach mode", ["Fork and adopt (recommended)", "Exclusive attach"]);
		if (!modeLabel) return;
		const mode = modeLabel.startsWith("Fork") ? "fork" as const : "exclusive" as const;
		const approved = await ctx.ui.confirm(
			"Attach session as subagent?",
			`Alias: ${alias.trim()}\nProfile: ${profile.name}\nCWD: ${selected.cwd}\nMode: ${mode}`,
		);
		if (!approved) return;
		const instance = await active.broker.attach({
			agent: profile.name,
			profile,
			alias: alias.trim(),
			cwd: selected.cwd || ctx.cwd,
			session: { mode, path: selected.path },
		});
		ctx.ui.notify(`Attached ${instance.alias} (${instance.agentId})`, "info");
	};

	const manageAgents = async (_args: string, ctx: ExtensionCommandContext) => {
		const active = getRuntime();
		const action = await ctx.ui.select("Persistent subagents", ["List linked", "Attach existing session", "Detach"]);
		if (!action) return;
		if (action === "Attach existing session") {
			await attachExistingSession(ctx);
			return;
		}
		const instances = await active.broker.listLinked();
		if (instances.length === 0) {
			ctx.ui.notify("No persistent subagents linked to this session branch", "info");
			return;
		}
		const labels = instances.map((instance) => `${instance.alias} · ${instance.profile.name} · ${instance.lastTask}`);
		const selected = await ctx.ui.select(action === "Detach" ? "Detach subagent" : "Linked subagents", labels);
		if (!selected) return;
		const instance = instances[labels.indexOf(selected)];
		if (!instance) return;
		if (action === "Detach") {
			await active.broker.detach(instance.alias);
			ctx.ui.notify(`Detached ${instance.alias}; child session was kept`, "info");
			return;
		}
		ctx.ui.notify(`${instance.alias} (${instance.agentId})\n${instance.profile.name}\n${instance.cwd}\n${instance.lastTask}`, "info");
	};

	pi.registerCommand("agents", { description: "Manage persistent subagents and attach saved Pi sessions", handler: manageAgents });
	pi.registerCommand("subagents", { description: "Alias for /agents", handler: manageAgents });

	pi.on("session_start", async (_event, ctx) => {
		if (runtime) await runtime.broker.shutdown();
		const store = new FileAgentInstanceStore(stateDir);
		const roster = new SessionAgentRoster((customType, data) => pi.appendEntry(customType, data));
		roster.restore(ctx.sessionManager.getBranch());
		const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted() ? "both" : "user");
		const broker = new SessionBroker({
			profiles: discovery.agents,
			store,
			roster,
			workerFactory: createRpcWorkerFactory({ stateDir, onUiRequest: handleChildUiRequest }),
			defaultCwd: ctx.cwd,
		});
		runtime = { ctx, broker, roster, store };
		if (ctx.mode === "tui") installAutocomplete(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!runtime) return;
		runtime.ctx = ctx;
		runtime.roster.restore(ctx.sessionManager.getBranch());
	});

	pi.on("before_agent_start", async (event) => {
		const active = runtime;
		if (!active) return;
		const mentions = extractSubagentMentions(event.prompt);
		const profiles = discoverAgents(active.ctx.cwd, active.ctx.isProjectTrusted() ? "both" : "user").agents;
		const prompt = buildSubagentRosterPrompt(await active.broker.listLinked(), mentions, profiles);
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.on("session_shutdown", async () => {
		const active = runtime;
		runtime = undefined;
		if (active) await active.broker.shutdown();
	});
}

export * from "./agents";
export * from "./identity";
export * from "./instance-store";
export * from "./interaction";
export * from "./rpc-transport";
export * from "./rpc-worker";
export * from "./session-broker";
export * from "./session-lease";
export * from "./session-links";
export * from "./tool";