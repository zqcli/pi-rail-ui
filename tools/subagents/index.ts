import { installTeamCommand } from "./team-command";
import { TEAM_JOURNAL_ENTRY_TYPE } from "./team-journal";
import { TeamSessionHost } from "./team-host";
import { installTeamTool } from "./team-tool";
import * as path from "node:path";
import {
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FileAgentInstanceStore } from "./instance-store";
import { RailAgentManager } from "./agent-manager";
import {
	applySubagentMentionCompletion,
	buildSubagentRosterPrompt,
	extractSubagentMentions,
	handleDirectSubagentControlInput,
	subagentMentionContext,
	subagentMentionSuggestions,
} from "./interaction";
import { availableRailModels, railModelReference } from "./models";
import type { RpcEvent } from "./rpc-worker";
import { runRailAgentManager } from "./rail-agent-manager";
import { SessionBroker, type TeamLifecycleRequest } from "./session-broker";
import { SessionAgentRoster } from "./session-links";
import { FileSessionLeaseManager } from "./session-lease";
import { buildParentSessionLabel } from "./session-name";
import { createStatelessAgentRunner } from "./stateless-runner";
import { installStatefulSubagentTool } from "./tool";
import { createRpcWorkerFactory } from "./worker-factory";

interface SubagentRuntime {
	host: TeamSessionHost;
	ctx: ExtensionContext;
	broker: SessionBroker;
	roster: SessionAgentRoster;
	store: FileAgentInstanceStore;
	manager: RailAgentManager;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

export function installRailSubagent(pi: ExtensionAPI): void {
	if (Number(process.env["PI_SUBAGENT_DEPTH"] ?? "0") > 0) return;
	const stateDir = path.join(getAgentDir(), "stateful-subagents");
	let runtime: SubagentRuntime | undefined;
	const teamHosts = new Set<TeamSessionHost>();
	const reportedHostDiagnostics = new WeakMap<TeamSessionHost, number>();
	const reportHostDiagnosticsToLog = (host: TeamSessionHost): void => {
		const start = reportedHostDiagnostics.get(host) ?? 0;
		for (const diagnostic of host.diagnostics.slice(start)) {
			console.error(`Team ${diagnostic.teamId} interruption history marker was NOT persisted (${diagnostic.code}): ${diagnostic.message}`);
		}
		reportedHostDiagnostics.set(host, host.diagnostics.length);
	};
	const notifyHostDiagnostics = (host: TeamSessionHost, ctx: ExtensionContext, allowRetired = false): void => {
		if (!ctx.hasUI || (!allowRetired && runtime?.host !== host)) return;
		const start = reportedHostDiagnostics.get(host) ?? 0;
		for (const diagnostic of host.diagnostics.slice(start)) {
			ctx.ui.notify(`Team ${diagnostic.teamId} interruption history marker was NOT persisted (${diagnostic.code}): ${diagnostic.message}`, "error");
		}
		reportedHostDiagnostics.set(host, host.diagnostics.length);
	};

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

	installTeamTool(pi, { host: () => getRuntime().host, broker: () => getRuntime().broker });
	installTeamCommand(pi, () => runtime?.host);
	installStatefulSubagentTool(pi, {
		broker: () => getRuntime().broker,
		knownFastMode: (target) => runtime?.broker.knownFastMode(target),
		knownModel: (target) => runtime?.broker.knownModel(target),
		renderContext: () => runtime?.ctx,
		runStateless: createStatelessAgentRunner(),
		getMarkdownTheme,
	});

	const installAutocomplete = (ctx: ExtensionContext) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: unique([...(current.triggerCharacters ?? []), "@"]),
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);
				const active = runtime;
				// Ordinary file/command completion must not read the agent store or enumerate models.
				if (active && subagentMentionContext(beforeCursor)) {
					const instances = await active.broker.listLinked();
					const models = availableRailModels(ctx);
					const suggestions = subagentMentionSuggestions(
						beforeCursor,
						instances.map((instance) => ({ alias: instance.alias, description: `${railModelReference(instance.model)} · ${instance.lastTask}` })),
						models.map((model) => ({
							reference: railModelReference(model),
							description: model.name ?? model.modelId,
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
				if (subagentMentionContext(beforeCursor)) return false;
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	};

	pi.registerCommand("rail-agent", {
		description: "Start, link, and manage Rail persistent model sessions",
		handler: (_args, ctx) => runRailAgentManager(ctx, getRuntime()),
	});

	const createTeamHost = (ctx: ExtensionContext, broker: SessionBroker): TeamSessionHost => {
		const host = new TeamSessionHost(broker, (record) => pi.appendEntry(TEAM_JOURNAL_ENTRY_TYPE, record), ctx.sessionManager.getBranch());
		teamHosts.add(host);
		return host;
	};

	const closeRuntime = async (active: SubagentRuntime, reason: string): Promise<void> => {
		const failures: unknown[] = [];
		try { await active.host.close(reason); }
		catch (error) { failures.push(error); }
		if (!active.host.hasUnreleasedResources()) teamHosts.delete(active.host);
		try { await active.broker.shutdown(); }
		catch (error) { failures.push(error); }
		if (failures.length) throw new AggregateError(failures, "Subagent runtime cleanup is incomplete");
	};

	const routeTeamLifecycle = (broker: SessionBroker): void => {
		broker.setTeamLifecycleRouter(async (request: TeamLifecycleRequest) => {
			const host = [...teamHosts].find((candidate) => candidate.hasTeam(request.teamId));
			if (!host) throw new Error(`Team ${request.teamId} has no lifecycle host`);
			if (request.scope === "member") {
				await host.driver.stopMember(request.teamId, request.memberId, `Host ${request.action} of Team member ${request.memberId}`);
				const member = host.runtime.getTeam(request.teamId).members.find((candidate) => candidate.id === request.memberId);
				if (member?.resourceState !== "released") {
					throw new Error(`Team member ${request.memberId} exit is not confirmed; its Team ownership is retained`);
				}
				if (!host.hasUnreleasedResources()) teamHosts.delete(host);
				return;
			}

			let stopError: unknown;
			try { await host.driver.stopTeam(request.teamId, request.reason, request.mode); }
			catch (error) { stopError = error; }
			for (const member of host.runtime.getTeam(request.teamId).members.filter((candidate) => candidate.resourceState !== "released")) {
				try { await host.driver.closeMember(request.teamId, member.id); }
				catch {
					// A protocol/unbind error after a confirmed process exit is recorded by Runtime;
					// only a still-owned resource prevents shutdown from proceeding.
				}
			}
			const state = host.runtime.getTeam(request.teamId);
			const unreleased = state.members.filter((candidate) => candidate.resourceState !== "released");
			if (unreleased.length) {
				const errors = [stopError, new Error(`Team ${request.teamId} still owns member resource(s): ${unreleased.map((member) => `${member.id}=${member.resourceState}`).join(", ")}`)].filter(Boolean);
				throw new AggregateError(errors, "Team interruption is incomplete; ownership remains held");
			}
			if (!host.hasUnreleasedResources()) teamHosts.delete(host);
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (runtime) {
			const previous = runtime;
			runtime = undefined;
			try { await closeRuntime(previous, "Parent session runtime replaced"); }
			catch (error) { reportHostDiagnosticsToLog(previous.host); throw error; }
			reportHostDiagnosticsToLog(previous.host);
		}
		const store = new FileAgentInstanceStore(stateDir);
		const roster = new SessionAgentRoster((customType, data) => pi.appendEntry(customType, data));
		roster.restore(ctx.sessionManager.getBranch());
		const broker = new SessionBroker({
			store,
			roster,
			workerFactory: createRpcWorkerFactory({ stateDir, onUiRequest: handleChildUiRequest }),
			defaultCwd: ctx.cwd,
			parentSessionLabel: buildParentSessionLabel(
				ctx.sessionManager.getSessionName(),
				ctx.sessionManager.getSessionId(),
				ctx.cwd,
			),
			aliasLeaseManager: new FileSessionLeaseManager(stateDir),
		});
		routeTeamLifecycle(broker);
		const host = createTeamHost(ctx, broker);
		try {
			await broker.prewarmFastModes();
			const manager = new RailAgentManager(broker, store, roster, stateDir);
			runtime = { ctx, broker, roster, store, manager, host };
		} catch (error) {
			try { await host.close("Subagent runtime startup failed"); }
			catch (cleanupError) { throw new AggregateError([error, cleanupError], "Subagent startup and Team cleanup failed", { cause: error }); }
			teamHosts.delete(host);
			await broker.shutdown();
			throw error;
		}
		if (ctx.mode === "tui") installAutocomplete(ctx);
	});

	const sealBeforeSessionReplacement = async (reason: string, ctx: ExtensionContext): Promise<{ cancel: true } | undefined> => {
		const active = runtime;
		if (!active || !active.host.active) return undefined;
		try { await active.host.close(reason); }
		catch (error) {
			notifyHostDiagnostics(active.host, ctx);
			if (ctx.hasUI && runtime?.host === active.host) {
				ctx.ui.notify(`Session replacement cancelled: Team resources are not confirmed closed (${error instanceof Error ? error.message : String(error)})`, "error");
			}
			return { cancel: true };
		}
		notifyHostDiagnostics(active.host, ctx);
		return undefined;
	};

	pi.on("session_before_tree", async (_event, ctx) =>
		sealBeforeSessionReplacement("Session tree navigation interrupted the Team generation", ctx));
	pi.on("session_before_switch", async (event, ctx) =>
		sealBeforeSessionReplacement(`Parent session switch (${event.reason})`, ctx));
	pi.on("session_before_fork", async (_event, ctx) =>
		sealBeforeSessionReplacement("Parent session fork interrupted the Team generation", ctx));

	pi.on("session_tree", async (_event, ctx) => {
		const previous = runtime;
		if (!previous) return;
		// session_before_tree normally seals the old journal before Pi changes the leaf. This fallback
		// permanently revokes it now, so a late cleanup callback cannot append into the selected branch.
		if (previous.host.active) {
			try { await previous.host.closeAfterBranchChange("Session branch changed before Team shutdown completed"); }
			catch (error) {
				console.error(`Team cleanup remains incomplete after session navigation: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!previous.host.hasUnreleasedResources()) teamHosts.delete(previous.host);
		const host = createTeamHost(ctx, previous.broker);
		runtime = { ...previous, ctx, host };
		previous.roster.restore(ctx.sessionManager.getBranch());
		await previous.broker.prewarmFastModes();
	});

	pi.on("input", async (event, ctx) => {
		const active = runtime;
		return handleDirectSubagentControlInput(
			event,
			ctx,
			active ? (target, request, signal) => active.manager.control(target, request, signal) : undefined,
		);
	});

	pi.on("before_agent_start", async (event) => {
		const active = runtime;
		if (!active) return;
		const mentions = extractSubagentMentions(event.prompt);
		const prompt = buildSubagentRosterPrompt(await active.broker.listLinked(), mentions);
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const active = runtime;
		runtime = undefined;
		if (!active) return;
		try { await closeRuntime(active, `Parent session shutdown: ${event.reason}`); }
		catch (error) {
			notifyHostDiagnostics(active.host, ctx, true);
			if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			throw error;
		}
		notifyHostDiagnostics(active.host, ctx, true);
	});
}

export * from "./identity";
export * from "./agent-manager";
export * from "./instance-store";
export * from "./interaction";
export * from "./model-picker";
export * from "./models";
export * from "./rpc-transport";
export * from "./rpc-worker";
export * from "./rail-agent-manager";
export * from "./rail-agent-overlay";
export * from "./session-broker";
export * from "./session-lease";
export * from "./session-links";
export * from "./session-name";
export * from "./stateless-runner";
export * from "./tool";
export * from "./transcript";
