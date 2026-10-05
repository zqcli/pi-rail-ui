import { readFile, stat } from "node:fs/promises";
import type { AgentInstance, SessionBroker } from "./session-broker";
import { restoreTeamHistory, type TeamHistory } from "./team-history";
import { TeamJournalGeneration, type TeamJournalSink } from "./team-journal";
import { TeamMemberDriver } from "./team-member-driver";
import { TeamRuntime, type TeamRuntimeOptions } from "./team-runtime";
import type { ResolvedTeamMemberPolicy } from "./tool";

type BranchEntry = { type: string; customType?: string; data?: unknown };

export interface TeamMemberSession {
	instance?: AgentInstance;
	size: number;
	reason?: "already deleted" | "not this Team's session";
}

export interface TeamHostDiagnostic {
	code: "INTERRUPTION_JOURNAL_FAILED";
	teamId: string;
	message: string;
}

/**
 * One session-branch generation of the Team runtime: its journal permission, Runtime, Driver,
 * display-only history and the policies pinned between prepare and launch. A generation never
 * outlives its branch; `close` interrupts every unfinished Team (journaled into the same, still
 * current session), waits for member exits, then permanently revokes the journal.
 */
export class TeamSessionHost {
	readonly journal: TeamJournalGeneration;
	readonly runtime: TeamRuntime;
	readonly driver: TeamMemberDriver;
	readonly history: TeamHistory;
	private readonly pinned = new Map<string, Map<string, ResolvedTeamMemberPolicy>>();
	private readonly endedAt = new Map<string, number>();
	private readonly verifiedSessions = new Map<string, Set<string>>();
	private readonly transitionDiagnostics: TeamHostDiagnostic[] = [];
	private retiring = false;
	private closing: Promise<void> | undefined;

	constructor(readonly broker: SessionBroker, sink: TeamJournalSink, branch: readonly BranchEntry[], options: Omit<TeamRuntimeOptions, "journal"> = {}) {
		this.journal = new TeamJournalGeneration((record) => {
			sink(record);
			if (record.kind === "terminal" || record.kind === "interrupted") this.endedAt.set(record.teamId, record.kind === "terminal" ? record.endedAt ?? record.at : record.at);
		});
		// The full-ledger invariant sweep is O(works) per call on the UI thread; tests opt in explicitly.
		this.runtime = new TeamRuntime({ checkInvariants: false, existingTeamIds: () => this.history.teams.map((entry) => entry.teamId), ...options, journal: this.journal });
		this.driver = new TeamMemberDriver(this.runtime, broker);
		let history: TeamHistory;
		// History is display-only and must never prevent new Teams from starting.
		try { history = restoreTeamHistory(branch); } catch { history = { teams: [], skipped: 1 }; }
		this.history = history;
	}

	/** False once retirement begins: no new prepare/launch, command mutations, or tool updates. */
	get active(): boolean { return !this.retiring && this.journal.active; }
	get diagnostics(): readonly TeamHostDiagnostic[] { return this.transitionDiagnostics; }

	hasTeam(teamId: string): boolean {
		try { this.runtime.getTeam(teamId); return true; }
		catch { return false; }
	}

	teamEndedAt(teamId: string): number | undefined {
		return this.endedAt.get(teamId) ?? this.history.teams.find((team) => team.teamId === teamId)?.at;
	}

	/** A reused alias is not enough: the saved session must belong to this Team. */
	async memberSessions(teamId: string, aliases: readonly string[]): Promise<Map<string, TeamMemberSession>> {
		const saved = await this.broker.listSaved();
		const sessions = new Map<string, TeamMemberSession>();
		for (const alias of aliases) {
			const instance = saved.find((item) => item.alias === alias);
			if (!instance) { sessions.set(alias, { size: 0, reason: "already deleted" }); continue; }
			try {
				const text = await readFile(instance.sessionFile, "utf8");
				if (!text.includes(teamId)) { sessions.set(alias, { size: 0, reason: "not this Team's session" }); continue; }
				const { size } = await stat(instance.sessionFile);
				let verified = this.verifiedSessions.get(teamId);
				if (!verified) this.verifiedSessions.set(teamId, verified = new Set());
				verified.add(instance.agentId);
				sessions.set(alias, { instance, size });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				// A failed store deletion can leave a verified descriptor after the file was removed.
				sessions.set(alias, this.verifiedSessions.get(teamId)?.has(instance.agentId)
					? { instance, size: 0 } : { size: 0, reason: "already deleted" });
			}
		}
		return sessions;
	}

	forgetTeam(teamId: string): void {
		if (this.hasTeam(teamId)) this.runtime.forgetTeam(teamId);
		this.history.teams = this.history.teams.filter((team) => team.teamId !== teamId);
		this.endedAt.delete(teamId);
		this.verifiedSessions.delete(teamId);
		this.unpin(teamId);
	}

	hasUnreleasedResources(): boolean {
		return this.runtime.listTeams().some((team) => team.members.some((member) => member.resourceState !== "released"));
	}

	pin(teamId: string, policies: Map<string, ResolvedTeamMemberPolicy>): void {
		if (!this.active) throw new Error("The Team runtime for this session branch has ended");
		this.pinned.set(teamId, policies);
	}
	pinnedPolicies(teamId: string): Map<string, ResolvedTeamMemberPolicy> | undefined { return this.pinned.get(teamId); }
	unpin(teamId: string): void { this.pinned.delete(teamId); }

	/**
	 * Seal this branch's writer synchronously before asynchronous cleanup. On the still-current branch,
	 * append an interruption fact first; on the post-navigation fallback, never write to the new leaf.
	 */
	close(reason = "Host session runtime ended"): Promise<void> {
		return this.beginClose(reason, false);
	}

	/** Defensive path for a tree change observed only after Pi has already selected its new leaf. */
	closeAfterBranchChange(reason = "Session branch changed"): Promise<void> {
		return this.beginClose(reason, true);
	}

	private beginClose(reason: string, branchAlreadyChanged: boolean): Promise<void> {
		this.retiring = true;
		this.pinned.clear();
		if (branchAlreadyChanged) {
			this.runtime.retireJournalForHostTransition();
			this.journal.deactivate();
		} else if (!this.closing && this.journal.active) {
			const at = Date.now();
			const boundedReason = reason.trim().slice(0, 4096) || "Host session runtime ended";
			for (const team of this.runtime.listTeams()) {
				// Prepared Teams never started and ended Teams already have their terminal fact.
				if (team.lifecycle !== "active" && team.lifecycle !== "closing") continue;
				try {
					this.journal.write({ version: 2, kind: "interrupted", teamId: team.teamId, at, reason: boundedReason });
				} catch (error) {
					this.transitionDiagnostics.push({ code: "INTERRUPTION_JOURNAL_FAILED", teamId: team.teamId,
						message: error instanceof Error ? error.message : String(error) });
					// Cleanup must proceed, but the diagnostic makes clear that no durable marker was written.
				}
			}
			this.runtime.retireJournalForHostTransition();
			this.journal.deactivate();
		}
		if (!this.closing) {
			const closing = this.driver.close().finally(() => this.pinned.clear());
			this.closing = closing;
			void closing.catch(() => { if (this.closing === closing) this.closing = undefined; });
		}
		return this.closing;
	}
}
