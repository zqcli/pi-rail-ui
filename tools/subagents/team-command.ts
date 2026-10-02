import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BudgetScope } from "./team-budget";
import { previewText } from "./team-codec";
import type { TeamSessionHost } from "./team-host";
import { showTeamOverlay } from "./team-overlay";
import { ROOT_GRANTABLE_COUNTERS, TEAM_GRANTABLE_COUNTERS, TEAM_BUDGET_PRESETS, workRefKey } from "./team-protocol";
import type { GrantPreview } from "./team-runtime";
import { formatBudgetLimit, formatHistoryEntry, formatHistorySummary, formatTeamView } from "./team-tool";

const SUBCOMMANDS = ["status", "results", "result", "budget", "cancel", "resume", "grant", "message", "lead"] as const;
const USAGE = "Usage: /rail-team [list] | /rail-team <teamId> status|results [page:N]|result <resultRef>|budget|cancel [reason]|resume|grant [team|root:<rootId>] [counter=+N ...] [reason]|message <text>|lead <alias> [reason]";

/**
 * `/rail-team`: the user-facing HostControl entry. It is a host command, never a model action:
 * every mutation shows its exact effect and requires an explicit confirmation in the UI.
 */
export function installTeamCommand(pi: ExtensionAPI, getHost: () => TeamSessionHost | undefined): void {
	pi.registerCommand("rail-team", {
		description: "Inspect and control Rail Teams (status, budget, cancel, resume, grant, message, lead)",
		getArgumentCompletions: (prefix) => {
			const host = getHost();
			if (!host) return null;
			const parts = prefix.split(/\s+/u);
			if (parts.length <= 1) {
				const ids = ["list", ...host.runtime.listTeams().map((team) => team.teamId)].filter((id) => id.startsWith(parts[0] ?? ""));
				return ids.length ? ids.map((id) => ({ value: id, label: id })) : null;
			}
			if (parts.length === 2) {
				const subs = SUBCOMMANDS.filter((sub) => sub.startsWith(parts[1] ?? ""));
				return subs.length ? subs.map((sub) => ({ value: `${parts[0]} ${sub}`, label: sub })) : null;
			}
			if (parts.length === 3 && parts[1] === "lead") {
				const team = host.runtime.listTeams().find((item) => item.teamId === parts[0]);
				const aliases = (team?.members ?? []).filter((member) => member.id !== team!.lead && member.id.startsWith(parts[2] ?? "")).map((member) => member.id);
				return aliases.length ? aliases.map((alias) => ({ value: `${parts[0]} lead ${alias}`, label: alias })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const host = getHost();
			if (!host) { ctx.ui.notify("The Team runtime is not ready", "error"); return; }
			try { await runTeamCommand(host, args.trim(), ctx); }
			catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
}

export async function runTeamCommand(host: TeamSessionHost, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!args.trim() && ctx.mode === "tui") {
		const choice = await showTeamOverlay(ctx, host);
		if (!choice) return;
		let text = "";
		if (choice.action === "message") {
			text = (await ctx.ui.input("Message the lead", "What should the lead know?"))?.trim() ?? "";
			if (!text) return;
		}
		await runTeamCommand(host, `${choice.teamId} ${choice.action}${text ? ` ${text}` : ""}`, ctx);
		return;
	}
	const [teamId, subcommand = "status", ...rest] = args.split(/\s+/u).filter(Boolean);
	if (!teamId || teamId === "list") {
		const teams = host.runtime.listTeams();
		const liveIds = new Set(teams.map((team) => team.teamId));
		const lines = [
			...teams.map((team) => `${team.teamId} · ${team.lifecycle.toUpperCase()} · ${team.health === "ok" ? "ok" : "needs attention"} · lead ${team.lead} · works ${team.works.total}`),
			...host.history.teams.filter((entry) => !liveIds.has(entry.teamId)).map(formatHistorySummary),
			...(host.history.skipped ? [`${host.history.skipped} malformed Team history entries skipped`] : []),
		];
		ctx.ui.notify(lines.join("\n") || "No teams", "info");
		return;
	}
	const text = rest.join(" ").trim();
	const liveTeam = host.runtime.listTeams().find((team) => team.teamId === teamId);
	if (!liveTeam) {
		const entry = host.history.teams.find((team) => team.teamId === teamId);
		if (!entry) throw new Error(`Unknown teamId ${teamId}. ${USAGE}`);
		if (subcommand === "status" || subcommand === "results") {
			ctx.ui.notify(formatHistoryEntry(entry, text || undefined), "info");
			return;
		}
		if (subcommand === "result") {
			const historical = entry.results.find((result) => result.id === text);
			if (!historical) throw new Error(`Unknown resultRef ${text} for Team ${teamId}`);
			ctx.ui.notify(formatResult(historical), "info");
			return;
		}
		throw new Error(`Team ${teamId} is read-only history; nothing can be resumed or changed.`);
	}
	switch (subcommand) {
		case "status":
			ctx.ui.notify(formatTeamView(host.runtime.getTeam(teamId), host.runtime.listWorks(teamId), undefined, host.runtime.panelFacts(teamId)).join("\n"), "info");
			return;
		case "results": {
			const page = host.runtime.listResultRefsPage(teamId, text || undefined);
			const lines = [`Result refs · ${page.total} total`, ...page.items.map((item) => `  ${item.id} · ${item.author} · ${workRefKey(item.work)} · ${item.status}: ${previewText(item.summaryPreview, 240)}`)];
			if (page.cursor) lines.push(`Next page: /rail-team ${teamId} results ${page.cursor}`);
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}
		case "result": {
			if (!text) throw new Error(`result requires a resultRef: /rail-team ${teamId} result <resultRef>`);
			const liveResult = host.runtime.getResult(teamId, text);
			if (liveResult) { ctx.ui.notify(formatResult(liveResult), "info"); return; }
			const historical = host.history.teams.find((entry) => entry.teamId === teamId)?.results.find((result) => result.id === text);
			if (!historical) throw new Error(`Unknown resultRef ${text} for Team ${teamId}`);
			ctx.ui.notify(formatResult(historical), "info");
			return;
		}
		case "budget":
			ctx.ui.notify(budgetLines(host, teamId).join("\n"), "info");
			return;
		case "cancel": {
			const alreadyEnded = ["closed", "failed", "cancelled", "interrupted"].includes(liveTeam.lifecycle);
			const retryCleanup = alreadyEnded && liveTeam.members.some((member) => member.resourceState !== "released");
			if (alreadyEnded && !retryCleanup) {
				ctx.ui.notify(`Team ${teamId} already ended as ${liveTeam.lifecycle}; all member exits are confirmed.`, "info");
				return;
			}
			const title = retryCleanup ? `Retry cleanup for Team ${teamId}?` : `Cancel Team ${teamId}?`;
			const message = retryCleanup
				? `Team ${teamId} already ended as ${liveTeam.lifecycle}. Retry only the unconfirmed member exits; no work will resume.`
				: "All unfinished work is cancelled and every member is stopped. This cannot be undone.";
			if (!await confirm(ctx, title, message)) return;
			const result = await host.driver.stopTeam(teamId, text || (retryCleanup ? "Host cleanup retry" : "Cancelled by the user"));
			const failures: string[] = [];
			for (const member of result.members.filter((item) => item.resourceState !== "released")) {
				try { await host.driver.closeMember(teamId, member.id); }
				catch (error) { failures.push(`${member.id}: ${error instanceof Error ? error.message : String(error)}`); }
			}
			const remaining = host.runtime.getTeam(teamId).members.filter((member) => member.resourceState !== "released");
			if (remaining.length || failures.length) throw new Error(`Team ${teamId} cancellation is incomplete; leases remain held: ${[...remaining.map((member) => `${member.id}=${member.resourceState}`), ...failures].join("; ")}`);
			ctx.ui.notify(retryCleanup
				? `Team ${teamId} remains ${host.runtime.getTeam(teamId).lifecycle}; all member exits are confirmed`
				: `Team ${teamId} cancelled; all member exits are confirmed`, "info");
			return;
		}
		case "message": {
			if (liveTeam.lifecycle !== "active") throw new Error(`Team ${teamId} is ${liveTeam.lifecycle}; a lead message requires an active Team.`);
			if (!text) throw new Error("message requires text: /rail-team <teamId> message <text>");
			if (!await confirm(ctx, `Message the lead of ${teamId}?`, `${previewText(text, 1024)}\n\nThis becomes a USER_COMMAND event for the lead; it grants no budget or tool permission.`)) return;
			const receipt = host.runtime.messageLead(teamId, text);
			ctx.ui.notify(`Lead message ${receipt.status}`, "info");
			return;
		}
		case "resume":
			if (liveTeam.lifecycle !== "active") throw new Error(`Team ${teamId} is ${liveTeam.lifecycle}; held work cannot be resumed.`);
			await resumeHold(host, teamId, text, ctx);
			return;
		case "lead": {
			const [alias, ...reasonWords] = rest;
			if (!alias) throw new Error("lead requires a member alias: /rail-team <teamId> lead <alias> [reason]");
			if (liveTeam.lifecycle !== "active") throw new Error(`Team ${teamId} is ${liveTeam.lifecycle}; the lead cannot be changed.`);
			const reason = reasonWords.join(" ");
			if (!await confirm(ctx, `Make ${alias} the lead of ${teamId}?`, `${liveTeam.lead} stays a member. Unprocessed Team events go to ${alias}; after a lead failure its incidents resolve and the other members resume.`)) return;
			host.runtime.handoverLead(teamId, alias, reason || undefined);
			ctx.ui.notify(`${alias} is now the lead of ${teamId}`, "info");
			return;
		}
		case "grant":
			if (liveTeam.lifecycle !== "active") throw new Error(`Team ${teamId} is ${liveTeam.lifecycle}; budget cannot be granted.`);
			await grantBudget(host, teamId, rest, ctx);
			return;
		default:
			throw new Error(USAGE);
	}
}

function formatResult(record: { id: string; author: string; work: { workId: string; revision: number }; result: { status: string; summary: string; findings?: string[]; evidence?: Array<{ basis: string; source: string; locator?: string }>; limitations?: string[]; artifacts?: string[] } }): string {
	return [
		`${record.id} · ${record.author} · ${workRefKey(record.work)} · ${record.result.status}`,
		record.result.summary,
		...(record.result.findings?.length ? ["Findings:", ...record.result.findings.map((item) => `- ${item}`)] : []),
		...(record.result.evidence?.length ? ["Evidence:", ...record.result.evidence.map((item) => `- ${item.basis}: ${item.source}${item.locator ? ` (${item.locator})` : ""}`)] : []),
		...(record.result.limitations?.length ? ["Limitations:", ...record.result.limitations.map((item) => `- ${item}`)] : []),
		...(record.result.artifacts?.length ? ["Artifacts:", ...record.result.artifacts.map((item) => `- ${item}`)] : []),
	].join("\n");
}

/** Full host budget: every root, not the bounded Team-view summary. */
function budgetLines(host: TeamSessionHost, teamId: string): string[] {
	const budget = host.runtime.inspectBudget(teamId);
	const { limits, used } = budget;
	const lines = [`Team ${teamId} budget`,
		...TEAM_GRANTABLE_COUNTERS.map((counter) => `  ${counter}: ${used[counter]}/${formatBudgetLimit(limits[counter])}`),
		`  teamWorks: ${used.teamWorks}/${formatBudgetLimit(limits.teamWorks)}`,
		`Roots (${budget.roots.length}):`];
	for (const root of budget.roots) {
		lines.push(`  ${root.rootId}: activations ${root.used.rootActivations}/${formatBudgetLimit(root.limits.rootActivations)} · model requests ${root.used.rootModelRequests}/${formatBudgetLimit(root.limits.rootModelRequests)} · tool calls ${root.used.rootToolCalls}/${formatBudgetLimit(root.limits.rootToolCalls)} · children ${root.used.rootChildren}/${formatBudgetLimit(root.limits.rootChildren)}`);
	}
	if (budget.grants.length) lines.push(`Grants (${budget.grants.length}):`, ...budget.grants.map((grant) =>
		`  ${grant.id} · ${grant.scope.kind === "team" ? "team" : `root ${grant.scope.rootId}`} · ${Object.entries(grant.increments).map(([key, value]) => `${key}+${value}`).join(", ")} · ${previewText(grant.reason, 120)}`));
	return lines;
}

async function resumeHold(host: TeamSessionHost, teamId: string, instructionText: string, ctx: ExtensionCommandContext): Promise<void> {
	requireUi(ctx);
	const holds = host.runtime.listHolds(teamId);
	if (!holds.length) { ctx.ui.notify(`Team ${teamId} has no held work`, "info"); return; }
	const labels = holds.map((hold) => `${workRefKey(hold.work)} · ${hold.reason} · ${hold.assignee} · ${previewText(hold.message, 160)}`);
	const choice = await ctx.ui.select(`Release which hold of ${teamId}?`, labels);
	if (choice === undefined) return;
	const hold = holds[labels.indexOf(choice)]!;
	const instruction = instructionText || (await ctx.ui.input("Resume instruction for the assignee", "What should change before retrying?"))?.trim();
	if (!instruction) return;
	const detail = [`Work ${workRefKey(hold.work)} (${hold.assignee}, root ${hold.rootId})`, `Hold: ${hold.reason} · incident ${hold.incidentId}`,
		`Incident: ${previewText(hold.message, 400)}`, `Task: ${hold.task}`, `Instruction: ${previewText(instruction, 400)}`,
		"Only this hold is released. No budget is raised and no faulted member is restarted."].join("\n");
	if (!await ctx.ui.confirm("Release this hold?", detail)) return;
	host.runtime.releaseHold(teamId, hold.work, hold.incidentId, instruction);
	ctx.ui.notify(`Released hold on ${workRefKey(hold.work)}`, "info");
}

async function grantBudget(host: TeamSessionHost, teamId: string, args: string[], ctx: ExtensionCommandContext): Promise<void> {
	requireUi(ctx);
	let [scopeArg, ...rest] = args;
	if (!scopeArg) {
		const limits = host.runtime.inspectBudget(teamId).limits;
		const presets = (["long", "unlimited"] as const).filter((preset) => Object.entries(TEAM_BUDGET_PRESETS[preset])
			.some(([counter, value]) => value > limits[counter as keyof typeof limits]));
		const labels = presets.map((preset) => `Raise to ${preset}`);
		const choice = await ctx.ui.select("Raise Team budget", [...labels, "Custom grant…"]);
		if (choice === undefined) return;
		if (choice !== "Custom grant…") {
			const preset = presets[labels.indexOf(choice)]!;
			const preview = host.runtime.previewRaiseBudget(teamId, preset);
			if (!await confirmBudgetGrant(host, teamId, preview, `Raise to ${preset}`, ctx)) return;
			const receipt = host.runtime.raiseBudget(teamId, preset);
			ctx.ui.notify(`Budget raised to ${preset}${"released" in receipt ? `; released ${receipt.released.length} hold(s)` : ""}`, "info");
			return;
		}
		const roots = host.runtime.inspectBudget(teamId).roots.map((root) => `root:${root.rootId}`);
		scopeArg = await ctx.ui.select("Grant budget to", ["team", ...roots]);
		if (scopeArg === undefined) return;
	}
	const scope: BudgetScope = scopeArg === "team" ? { kind: "team" }
		: scopeArg.startsWith("root:") ? { kind: "root", rootId: scopeArg.slice(5) }
		: (() => { throw new Error(`Grant scope must be "team" or "root:<rootId>"; got ${scopeArg}`); })();
	const counters: readonly string[] = scope.kind === "team" ? TEAM_GRANTABLE_COUNTERS : ROOT_GRANTABLE_COUNTERS;
	const incrementArgs = rest.filter((arg) => /^[A-Za-z]+=\+?\d+$/u.test(arg));
	let reason = rest.filter((arg) => !incrementArgs.includes(arg)).join(" ").trim();
	let incrementText = incrementArgs.join(" ");
	if (!incrementText) {
		incrementText = (await ctx.ui.input(`Increments (${counters.join(", ")})`, "teamModelRequests=+64 teamToolCalls=+128"))?.trim() ?? "";
		if (!incrementText) return;
	}
	const increments: Record<string, number> = {};
	for (const part of incrementText.split(/[\s,]+/u).filter(Boolean)) {
		const match = /^([A-Za-z]+)=\+?(\d+)$/u.exec(part);
		if (!match || !counters.includes(match[1]!)) throw new Error(`Invalid increment ${part}; allowed counters for this scope: ${counters.join(", ")}`);
		increments[match[1]!] = Number(match[2]);
	}
	if (!reason) {
		reason = (await ctx.ui.input("Grant reason", "Why is more budget needed?"))?.trim() ?? "";
		if (!reason) return;
	}
	const preview = host.runtime.previewGrant(teamId, scope, increments);
	if (!await confirmBudgetGrant(host, teamId, preview, reason, ctx)) return;
	const receipt = host.runtime.grantBudget(teamId, scope, increments, reason);
	ctx.ui.notify(`Budget granted${"released" in receipt ? `; released ${receipt.released.length} hold(s)` : ""}`, "info");
}

async function confirmBudgetGrant(host: TeamSessionHost, teamId: string, preview: GrantPreview, reason: string, ctx: ExtensionCommandContext): Promise<boolean> {
	const scope = preview.scope;
	const holds = host.runtime.listHolds(teamId);
	const released = preview.released.map((work) => {
		const hold = holds.find((item) => item.work.workId === work.workId && item.work.revision === work.revision);
		return `  ${workRefKey(work)}${hold ? ` · ${hold.assignee} · ${previewText(hold.message, 120)}` : ""}`;
	});
	const remaining = holds.filter((hold) => !preview.released.some((work) => work.workId === hold.work.workId && work.revision === hold.work.revision));
	const detail = [
		`Scope: ${scope.kind === "team" ? `Team ${teamId}` : `root ${scope.rootId}`}`,
		...preview.changes.map((change) => `  ${change.counter}: used ${change.used} · limit ${formatBudgetLimit(change.limit)} → ${formatBudgetLimit(change.proposed)}`),
		`Reason: ${previewText(reason, 200)}`,
		released.length ? `Releases ${released.length} budget hold(s):` : "Releases no held work (it only raises the limits).",
		...released,
		...(remaining.length ? [`Stays held: ${remaining.map((hold) => `${workRefKey(hold.work)} (${hold.reason})`).join(", ")}`] : []),
		"Usage never resets; limits only grow.",
	].join("\n");
	return ctx.ui.confirm("Grant this budget?", detail);
}

function requireUi(ctx: ExtensionCommandContext): void {
	if (!ctx.hasUI) throw new Error("This Team control needs interactive confirmation; without a UI, held work stays paused and the Team can only be cancelled.");
}

async function confirm(ctx: ExtensionCommandContext, title: string, message: string): Promise<boolean> {
	requireUi(ctx);
	return ctx.ui.confirm(title, message);
}
