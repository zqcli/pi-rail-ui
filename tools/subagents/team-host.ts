import type { SessionBroker } from "./session-broker";
import { restoreTeamHistory, type TeamHistory } from "./team-history";
import { TeamJournalGeneration, type TeamJournalSink } from "./team-journal";
import { TeamMemberDriver } from "./team-member-driver";
import { TeamRuntime, type TeamRuntimeOptions } from "./team-runtime";
import type { ResolvedTeamMemberPolicy } from "./tool";

type BranchEntry = { type: string; customType?: string; data?: unknown };

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
	private readonly transitionDiagnostics: TeamHostDiagnostic[] = [];
	private retiring = false;
	private closing: Promise<void> | undefined;

	constructor(broker: SessionBroker, sink: TeamJournalSink, branch: readonly BranchEntry[], options: Omit<TeamRuntimeOptions, "journal"> = {}) {
		this.journal = new TeamJournalGeneration(sink);
		this.runtime = new TeamRuntime({ ...options, journal: this.journal });
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
