import { resolve } from "node:path";
import type { RailModelRef } from "./models";
import { railModelReference } from "./models";
import { TeamMemberOpenError, type BrokeredTeamMemberHandle, type SessionBroker, type SubagentUsage } from "./session-broker";
import type { RpcEvent } from "./rpc-worker";
import { assistantText, RunResultCollector } from "./run-result";
import type { ChildRequestFrame, PrivateReply, TeamResult } from "./team-protocol";
import { sameBinding, sameScope } from "./team-codec";
import { TeamRuntime, type ActivationCompletionReason, type NativeCompletion, type RuntimeActivation, type TeamRuntimeExecutor } from "./team-runtime";
import { TeamActivationFailure } from "./team-rpc-v2";
import { SubagentTranscript, type SubagentTranscriptSnapshot } from "./transcript";

export interface OpenTeamMemberRequest {
	teamId: string;
	memberId: string;
	model: RailModelRef;
	cwd?: string;
	fastMode?: boolean;
	contextWindow?: number;
}

export interface TeamActivationRun {
	activation: RuntimeActivation;
	completion: NativeCompletion;
	completionReason: ActivationCompletionReason;
	sessionId: string;
}

interface ManagedMember {
	binding: RuntimeActivation["binding"];
	handle: BrokeredTeamMemberHandle;
	contextWindow?: number;
}

/** Display-only native activity of one member across all of its activations. */
export interface TeamMemberActivity {
	transcript: SubagentTranscriptSnapshot;
	/** Latest assistant text. */
	output: string;
	/** Usage of the in-flight activation that Runtime has not folded into the member yet. */
	liveUsage?: SubagentUsage;
	isCompacting?: boolean;
	/** Time spent in native activations, including the current one. */
	durationMs: number;
}

interface ActivityRecord {
	transcript: SubagentTranscript;
	run?: RunResultCollector;
	startedAt?: number;
	activeMs: number;
	output: string;
}

function key(teamId: string, memberId: string): string {
	return `${teamId}\0${memberId}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A startup/admission failure; the prepared Team was stopped before any provider ran. */
export class TeamLaunchError extends Error {
	constructor(message: string, readonly cleanup: TeamResult | undefined, readonly cleanupError: unknown, cause?: unknown) {
		super(message, { cause });
		this.name = "TeamLaunchError";
	}
}

/** Drives Runtime-reserved activations through Broker-owned, single-writer native sessions. */
export class TeamMemberDriver {
	private readonly members = new Map<string, ManagedMember>();
	private readonly runningMembers = new Set<string>();
	private readonly activationRuns = new Map<string, Promise<TeamActivationRun>>();
	private readonly activationControllers = new Map<string, { activationId: string; controller: AbortController }>();
	private readonly pendingStops = new Map<string, { activationId: string; reason: ActivationCompletionReason }>();
	private readonly settledLifetimes = new Set<string>();
	private closeBatchAttempts: Set<string> | undefined;
	private readonly launched = new Map<string, Promise<TeamResult>>();
	private readonly preparedStops = new Map<string, Promise<TeamResult>>();
	private readonly opening = new Map<string, Promise<unknown>>();
	private readonly failedOpenings = new Map<string, TeamMemberOpenError>();
	private readonly activity = new Map<string, ActivityRecord>();
	private readonly activityListeners = new Set<(teamId: string) => void>();

	constructor(private readonly runtime: TeamRuntime, private readonly broker: SessionBroker) {}

	/** Display observation of native member activity; listeners must only read. */
	onActivity(listener: (teamId: string) => void): () => void {
		this.activityListeners.add(listener);
		return () => { this.activityListeners.delete(listener); };
	}

	/** Kept after a member closes so a finished Team still shows what each member did. */
	memberActivity(teamId: string, memberId: string): TeamMemberActivity | undefined {
		const activity = this.activity.get(key(teamId, memberId));
		if (!activity) return undefined;
		const live = activity.run?.result("");
		return {
			transcript: activity.transcript.snapshot(),
			output: live?.output || activity.output,
			...(live ? { liveUsage: live.usage } : {}),
			...(live?.isCompacting ? { isCompacting: true } : {}),
			durationMs: activity.activeMs + (activity.startedAt !== undefined ? Date.now() - activity.startedAt : 0),
		};
	}

	private recordActivity(teamId: string, activity: ActivityRecord, event: RpcEvent): void {
		// The activation trigger prompt is protocol plumbing, not member activity.
		const userMessage = (event.type === "message_start" || event.type === "message_end")
			&& (event.message as { role?: unknown } | undefined)?.role === "user";
		if (!userMessage) activity.transcript.ingest(event);
		activity.run?.ingest(event);
		this.notifyActivity(teamId);
	}

	/** Freeze the settled activation; Runtime has folded (or recorded as lost) its usage by now. */
	private finishActivity(teamId: string, id: string): void {
		const activity = this.activity.get(id);
		if (!activity?.run) return;
		const output = activity.run.result("").output;
		if (output) activity.output = output;
		activity.activeMs += Date.now() - activity.startedAt!;
		delete activity.run;
		delete activity.startedAt;
		this.notifyActivity(teamId);
	}

	/** Drop bookkeeping of Teams the Runtime has evicted; it keeps only a bounded number of ended Teams. */
	private forgetEvictedTeams(): void {
		const known = new Set(this.runtime.listTeams().map((team) => team.teamId));
		const teamOf = (id: string) => id.slice(0, id.indexOf("\0"));
		for (const map of [this.activity, this.failedOpenings]) {
			for (const id of map.keys()) if (!known.has(teamOf(id))) map.delete(id);
		}
		for (const teams of [this.launched, this.preparedStops, this.settledLifetimes]) {
			for (const teamId of teams.keys()) if (!known.has(teamId)) teams.delete(teamId);
		}
	}

	private notifyActivity(teamId: string): void {
		for (const listener of [...this.activityListeners]) {
			try { listener(teamId); } catch { /* A display observer never affects the member. */ }
		}
	}

	async openMember(request: OpenTeamMemberRequest): Promise<BrokeredTeamMemberHandle> {
		const planned = this.runtime.getTeam(request.teamId).members.find((member) => member.id === request.memberId);
		if (!planned) throw new Error(`Unknown Team member ${request.memberId}`);
		if (planned.policy.model && planned.policy.model !== railModelReference(request.model)) {
			throw new Error(`Team member ${request.memberId} model does not match its prepared policy`);
		}
		const cwd = request.cwd ?? planned.policy.cwd;
		if (planned.policy.cwd && cwd && resolve(planned.policy.cwd) !== resolve(cwd)) {
			throw new Error(`Team member ${request.memberId} cwd does not match its prepared policy`);
		}
		if (request.fastMode !== undefined && planned.policy.fastMode !== request.fastMode) {
			throw new Error(`Team member ${request.memberId} fastMode does not match its prepared policy`);
		}
		if (request.contextWindow !== undefined && planned.policy.contextWindow !== request.contextWindow) {
			throw new Error(`Team member ${request.memberId} contextWindow does not match its prepared policy`);
		}
		const fastMode = planned.policy.fastMode;
		const contextWindow = planned.policy.contextWindow;
		const id = key(request.teamId, request.memberId);
		if (this.members.has(id)) throw new Error(`Team member ${request.memberId} already has a native lifetime`);
		// The claim fails once the Team is no longer prepared, so a cancelled Team never gains a new lifetime.
		const binding = this.runtime.claimNativeLifetime(request.teamId, request.memberId);
		this.forgetEvictedTeams();
		const activity: ActivityRecord = { transcript: new SubagentTranscript(""), activeMs: 0, output: "" };
		this.activity.set(id, activity);
		const opened = this.broker.openTeamMember({
			binding,
			model: request.model,
			...(cwd ? { cwd } : {}),
			...(fastMode !== undefined ? { fastMode } : {}),
			...(contextWindow !== undefined ? { contextWindow } : {}),
			onActivity: (event) => this.recordActivity(request.teamId, activity, event),
		});
		this.opening.set(id, opened);
		try {
			const handle = await opened;
			this.members.set(id, { binding, handle, ...(contextWindow !== undefined ? { contextWindow } : {}) });
			return handle;
		} catch (error) {
			if (error instanceof TeamMemberOpenError) this.failedOpenings.set(id, error);
			throw error;
		} finally {
			this.opening.delete(id);
		}
	}

	/**
	 * Open every member lifetime (each bind verifies the child's Team v2 capability), then launch.
	 * If any open fails no provider is started: the prepared Team is stopped and every lifetime that
	 * was opened is closed; an unconfirmed exit keeps its Broker ownership. The lifetime is wrapped so
	 * callers can observe launch admission separately from Team completion.
	 */
	async openAndLaunch(teamId: string, requests: readonly OpenTeamMemberRequest[]): Promise<{ lifetime: Promise<TeamResult> }> {
		const opened = await Promise.allSettled(requests.map((request) => this.openMember(request)));
		const failures = opened.flatMap((result, index) => result.status === "rejected" ? [{ memberId: requests[index]!.memberId, error: result.reason }] : []);
		// A host stop during startup already owns the prepared Team's cleanup; never launch past it.
		let message = failures.length ? `Team launch stopped before any provider ran; member startup failed (${failures.map(({ memberId, error }) => `${memberId}: ${errorMessage(error)}`).join("; ")})`
			: this.preparedStops.has(teamId) ? "Team launch was stopped by the host before any provider ran" : undefined;
		let admissionError: unknown = failures.length === 1 ? failures[0]!.error
			: failures.length ? new AggregateError(failures.map(({ error }) => error), "Team member startup failed") : undefined;
		if (!message) {
			try { return { lifetime: this.launch(teamId) }; }
			catch (error) {
				admissionError = error;
				message = `Team launch admission failed before any provider ran: ${errorMessage(error)}`;
			}
		}
		// Opening all handles is not admission: journal/scope checks can still reject launch.
		// Consume this failed attempt and clean up every claimed lifetime, never implicitly retry it.
		let cleanup: TeamResult | undefined;
		let cleanupError: unknown;
		const failureReason = message;
		try { cleanup = await this.stopLifetime(teamId, () => this.runtime.failStartup(teamId, failureReason)); }
		catch (error) { cleanupError = error; }
		throw new TeamLaunchError(message, cleanup, cleanupError, admissionError);
	}

	/** Native resources must all be bound before Runtime admits any activation. */
	launch(teamId: string): Promise<TeamResult> {
		const existing = this.launched.get(teamId);
		if (existing) return existing;
		const team = this.runtime.getTeam(teamId);
		if (team.lifecycle !== "prepared") throw new Error(`Cannot launch Team in ${team.lifecycle}`);
		const missing = team.members.filter((member) => !this.members.has(key(teamId, member.id))).map((member) => member.id);
		if (missing.length) throw new Error(`Team members need Broker-owned native lifetimes before launch: ${missing.join(", ")}`);
		const detach = this.runtime.attachExecutor(teamId, this.executor());
		try {
			this.runtime.launch(teamId);
		} catch (error) {
			try { detach(); }
			catch (detachError) {
				throw new AggregateError([error, detachError], "Team launch failed and Runtime executor rollback also failed", { cause: error });
			}
			throw error;
		}
		return this.trackLifetime(this.launched, teamId, detach);
	}

	private trackLifetime(lifetimes: Map<string, Promise<TeamResult>>, teamId: string, detach: () => void): Promise<TeamResult> {
		const lifetime = this.runtime.waitForCompletion(teamId).then((result) => {
			this.settledLifetimes.add(teamId);
			if (result.members.every((member) => member.resourceState === "released")) detach();
			return result;
		});
		lifetimes.set(teamId, lifetime);
		return lifetime;
	}

	private executor(): TeamRuntimeExecutor {
		return {
			runActivation: (activation) => this.trackActivation(activation),
			stopActivation: (binding, activationId, reason) => this.stopActivation(binding, activationId, reason),
			terminateActivation: (binding, activationId, error) => this.terminateActivation(binding, activationId, error.message),
			closeMember: async (binding) => {
				const id = key(binding.teamId, binding.memberId);
				// A prepared-cancel may race an in-flight open; its outcome decides whether a handle exists.
				await this.opening.get(id)?.catch(() => undefined);
				const member = this.members.get(id);
				if (!member) {
					const failure = this.failedOpenings.get(id);
					if (failure?.resourceReleased) {
						this.failedOpenings.delete(id);
						return { ok: false, resourceReleased: true, error: { code: "STARTUP_FAILURE", message: failure.message } };
					}
					return { ok: false, error: { code: "CLEANUP_FAILED", message: failure?.cleanupError !== undefined
						? errorMessage(failure.cleanupError) : `No confirmed native exit for ${binding.memberId}`, outcomeUnknown: true } };
				}
				if (this.runningMembers.has(id)) return { ok: false, error: { code: "CLEANUP_FAILED", message: `${binding.memberId} still has a native activation in flight`, outcomeUnknown: true } };
				try {
					this.closeBatchAttempts?.add(id);
					const closed = await member.handle.close();
					this.members.delete(id);
					// Exit confirmed, but a failed private unbind is never reported as a clean close.
					return closed.protocolError === undefined ? { ok: true }
						: { ok: false, resourceReleased: true, error: { code: "PROTOCOL_FAILURE", message: closed.protocolError } };
				} catch (error) {
					return { ok: false, error: { code: "CLEANUP_FAILED", message: errorMessage(error), outcomeUnknown: true } };
				}
			},
		};
	}

	/**
	 * Lifecycle routers (stop/delete/shutdown) use this instead of waiting for a Manager turn. A prepared
	 * Team is cancelled without launching any provider; only native lifetimes actually claimed are closed.
	 */
	stopTeam(teamId: string, reason: string, mode: "cancel" | "interrupt" = "cancel"): Promise<TeamResult> {
		return this.stopLifetime(teamId, () => mode === "cancel" ? this.runtime.cancelTeam(teamId, reason) : this.runtime.interruptTeam(teamId, reason));
	}

	/** Share only resource cleanup/waiting; the caller supplies the correctly classified terminal decision. */
	private stopLifetime(teamId: string, stop: () => void): Promise<TeamResult> {
		const lifetime = this.launched.get(teamId);
		if (lifetime) {
			if (!this.settledLifetimes.has(teamId)) stop();
			return lifetime;
		}
		const preparedStop = this.preparedStops.get(teamId);
		if (preparedStop) return preparedStop;
		const completed = this.runtime.getTeamResult(teamId);
		if (completed && completed.members.every((member) => member.resourceState === "released")) return Promise.resolve(completed);
		const lifecycle = this.runtime.getTeam(teamId).lifecycle;
		const detach = lifecycle === "prepared"
			? this.runtime.attachExecutor(teamId, this.executor())
			: this.runtime.attachCleanupExecutor(teamId, this.executor());
		try {
			stop();
		} catch (error) {
			detach();
			throw error;
		}
		return this.trackLifetime(this.preparedStops, teamId, detach);
	}

	/** Diagnostic: member lifetimes of one Team this driver still holds, is opening, or is running. */
	liveLifetimes(teamId: string): string[] {
		const prefix = key(teamId, "");
		return [...new Set([...this.members.keys(), ...this.opening.keys(), ...this.runningMembers])]
			.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)).sort();
	}

	/** Runtime alone selects the next activation; this driver only performs the native effect. */
	async runNext(teamId: string, options: { signal?: AbortSignal } = {}): Promise<TeamActivationRun | undefined> {
		if (options.signal?.aborted) return undefined;
		const currentTeam = this.runtime.getTeam(teamId);
		const missing = currentTeam.members.filter((member) => member.lifecycle === "open"
			&& !this.members.has(key(teamId, member.id))).map((member) => member.id);
		if (missing.length) throw new Error(`Team members lack Broker-owned native lifetimes: ${missing.join(", ")}`);
		const activation = this.runtime.takeNextActivation(teamId);
		if (!activation) return undefined;
		return this.trackActivation(activation, options);
	}

	private trackActivation(activation: RuntimeActivation, options: { signal?: AbortSignal } = {}): Promise<TeamActivationRun> {
		const id = key(activation.binding.teamId, activation.binding.memberId);
		const run = this.executeActivation(activation, options);
		this.activationRuns.set(id, run);
		void run.finally(() => { if (this.activationRuns.get(id) === run) this.activationRuns.delete(id); }).catch(() => undefined);
		return run;
	}

	private async executeActivation(activation: RuntimeActivation, options: { signal?: AbortSignal } = {}): Promise<TeamActivationRun> {
		const id = key(activation.binding.teamId, activation.binding.memberId);
		const member = this.members.get(id);
		if (!member) throw new Error(`No Broker-owned native lifetime for Team member ${activation.binding.memberId}`);
		if (!sameBinding(member.binding, activation.binding)) throw new Error("Runtime activation binding changed during a member lifetime");
		if (this.runningMembers.has(id)) throw new Error(`Team member ${activation.binding.memberId} already has an activation in flight`);
		this.runningMembers.add(id);
		const activity = this.activity.get(id);
		if (activity) {
			activity.run = new RunResultCollector("", assistantText);
			activity.startedAt = Date.now();
		}
		const controller = new AbortController();
		this.activationControllers.set(id, { activationId: activation.scope.activationId, controller });
		const pendingStop = this.pendingStops.get(id);
		if (pendingStop?.activationId === activation.scope.activationId) {
			this.pendingStops.delete(id);
			controller.abort(pendingStop.reason);
		}
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		let native: NativeCompletion | undefined;
		let nativeAccepted = false;
		let settlementError: Error | undefined;
		let lostProcessed = false;
		let cleanupAttempted = false;
		try {
			await member.handle.runActivation(
				activation,
				(frame, intentId) => this.onPrivateRequest(member, activation, frame, intentId),
				(completion) => {
					if (native) throw new Error("Native activation emitted more than one settled completion");
					native = completion;
					const result = this.runtime.nativeSettled(activation.binding, activation.scope.activationId, completion);
					this.finishActivity(activation.binding.teamId, id);
					if (!result.ok) settlementError = new Error(result.error.message);
					else nativeAccepted = true;
				},
				signal,
			);
			if (!native) throw new Error("Team member send returned without a real native agent_settled boundary");
			if (settlementError) {
				this.runtime.activationLost(activation.binding, activation.scope.activationId,
					{ code: "PROTOCOL_FAILURE", message: settlementError.message }, true, native.usage);
				lostProcessed = true;
				throw settlementError;
			}
			cleanupAttempted = true;
			const cleanup = this.runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
			if (!cleanup.ok) throw new Error(cleanup.error.message);
			return { activation, completion: native, completionReason: this.runtime.activationCompletionReason(activation.binding, activation.scope.activationId) ?? "normal",
				sessionId: member.handle.sessionId };
		} catch (error) {
			this.finishActivity(activation.binding.teamId, id);
			if (!native && !lostProcessed) {
				const released = error instanceof TeamActivationFailure && error.resourceReleased;
				this.runtime.activationLost(activation.binding, activation.scope.activationId, {
					code: "NATIVE_OUTCOME_UNKNOWN", message: errorMessage(error), outcomeUnknown: true,
				}, released, error instanceof TeamActivationFailure ? error.usage : undefined);
				lostProcessed = true;
				// Runtime now records a confirmed exit; release the Broker owner to match (history is kept).
				if (released) await this.releaseExitedMember(id, member);
			} else if (native && nativeAccepted && !cleanupAttempted) {
				cleanupAttempted = true;
				const cleanup = this.runtime.cleanupFinished(activation.binding, activation.scope.activationId, {
					ok: false,
					error: { code: "CLEANUP_FAILED", message: errorMessage(error), outcomeUnknown: true },
				});
				if (!cleanup.ok && !settlementError) settlementError = new Error(cleanup.error.message);
			}
			throw settlementError ?? error;
		} finally {
			this.finishActivity(activation.binding.teamId, id);
			this.runningMembers.delete(id);
			if (this.activationControllers.get(id)?.activationId === activation.scope.activationId) this.activationControllers.delete(id);
		}
	}

	private stopActivation(binding: RuntimeActivation["binding"], activationId: string, reason: ActivationCompletionReason): void {
		const id = key(binding.teamId, binding.memberId);
		const active = this.activationControllers.get(id);
		if (active?.activationId === activationId) {
			active.controller.abort(reason);
			return;
		}
		this.pendingStops.set(id, { activationId, reason });
	}

	private terminateActivation(binding: RuntimeActivation["binding"], activationId: string, reason: string): void {
		const id = key(binding.teamId, binding.memberId);
		// Only the still-running send is terminated; a finished one has already reported its own evidence.
		if (this.activationControllers.get(id)?.activationId !== activationId) return;
		this.members.get(id)?.handle.terminate(new Error(reason));
	}

	/** A confirmed-exit fault: the handle close only releases ownership; unknown exits keep it for a later retry. */
	private async releaseExitedMember(id: string, member: ManagedMember): Promise<void> {
		try {
			await member.handle.close();
			if (this.members.get(id) === member) this.members.delete(id);
		} catch { /* Exit is not confirmed by the Broker; keep the handle and ownership. */ }
	}

	/** Stop one host-selected Broker member while preserving every unrelated Team member/root. */
	async stopMember(teamId: string, memberId: string, reason: string): Promise<void> {
		const binding = this.runtime.hostStopMember(teamId, memberId, reason);
		const id = key(teamId, memberId);
		await this.opening.get(id)?.catch(() => undefined);
		await this.waitForMemberIdle(teamId, memberId);
		await this.activationRuns.get(id)?.catch(() => undefined);
		const state = this.runtime.getTeam(teamId).members.find((candidate) => candidate.id === memberId);
		if (state?.resourceState === "released") return;
		const member = this.members.get(id);
		if (!member) throw new Error(`Team member ${memberId} has no driver handle to confirm its exit`);
		try {
			const closed = await member.handle.close();
			this.members.delete(id);
			const reply = this.runtime.memberStopExit(binding, closed.protocolError === undefined ? { ok: true } : {
				ok: false, resourceReleased: true, error: { code: "PROTOCOL_FAILURE", message: closed.protocolError },
			});
			if (!reply.ok && closed.protocolError === undefined) throw new Error(reply.error.message);
		} catch (error) {
			if (this.members.get(id) === member) {
				try { this.runtime.memberStopExit(binding, { ok: false, error: { code: "CLEANUP_FAILED", message: errorMessage(error), outcomeUnknown: true } }); }
				catch (reportError) { throw new AggregateError([error, reportError], `Team member ${memberId} stop and cleanup reporting both failed`); }
			}
			throw error;
		}
	}

	private waitForMemberIdle(teamId: string, memberId: string): Promise<void> {
		const isIdle = (): boolean => this.runtime.getTeam(teamId).members.find((member) => member.id === memberId)?.activity === "idle";
		if (isIdle()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const unsubscribe = this.runtime.onChange((changed) => {
				if (changed !== teamId || !isIdle()) return;
				unsubscribe();
				if (timer) clearTimeout(timer);
				resolve();
			});
			timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Team member ${memberId} activation did not settle after host stop`));
			}, 20_000);
		});
	}

	async closeMember(teamId: string, memberId: string): Promise<void> {
		const id = key(teamId, memberId);
		const member = this.members.get(id);
		if (!member) return;
		if (this.runningMembers.has(id)) throw new Error(`Cannot close Team member ${memberId} while an activation is running`);
		const closed = await member.handle.close();
		this.members.delete(id);
		this.reconcileRuntimeExit(member.binding);
		if (closed.protocolError !== undefined) throw new Error(`Team member ${memberId} exited, but its private unbind failed: ${closed.protocolError}`);
	}

	async close(): Promise<void> {
		const failures: unknown[] = [];
		const closeBatchAttempts = new Set<string>();
		this.closeBatchAttempts = closeBatchAttempts;
		// Host lifecycle end: every unfinished Team (prepared or live) is interrupted, not user-cancelled,
		// and its member exits are awaited before remaining handles are closed.
		const stops = new Map<string, Promise<TeamResult>>([...this.preparedStops, ...this.launched]);
		for (const team of this.runtime.listTeams()) {
			const managedLifetime = this.launched.has(team.teamId);
			if (team.lifecycle !== "prepared" && !(managedLifetime && (team.lifecycle === "active" || team.lifecycle === "closing"))) continue;
			try { stops.set(team.teamId, this.stopTeam(team.teamId, "Host session runtime ended", "interrupt")); }
			catch (error) { failures.push(error); }
		}
		for (const [teamId, lifetime] of stops) {
			try {
				const result = await lifetime;
				for (const member of result.members) if (member.resourceState !== "released") {
					const id = key(teamId, member.id);
					if (closeBatchAttempts.has(id)) failures.push(new Error(`Team member ${member.id} exit is unconfirmed (${member.resourceState})`));
				}
			} catch (error) { failures.push(error); }
		}
		for (const [id, member] of [...this.members.entries()]) {
			if (closeBatchAttempts.has(id)) continue;
			try {
				closeBatchAttempts.add(id);
				const closed = await member.handle.close();
				this.members.delete(id);
				this.reconcileRuntimeExit(member.binding);
				// Released either way; an unclean unbind is still reported unless Runtime already recorded the fault.
				if (closed.protocolError !== undefined && !this.runtimeRecordsFault(member.binding)) {
					failures.push(new Error(`Team member ${member.binding.memberId} exited, but its private unbind failed: ${closed.protocolError}`));
				}
			} catch (error) {
				// Keep the handle and Runtime association so uncertain exit never frees ownership.
				failures.push(error);
			}
		}
		if (this.closeBatchAttempts === closeBatchAttempts) this.closeBatchAttempts = undefined;
		if (failures.length) throw new AggregateError(failures, "One or more Team member exits are unconfirmed");
	}

	/** An explicit close retry confirmed an exit Runtime still records as unknown: report that fact only. */
	private reconcileRuntimeExit(binding: RuntimeActivation["binding"]): void {
		let unknownExit = false;
		try {
			const member = this.runtime.getTeam(binding.teamId).members.find((item) => item.id === binding.memberId);
			unknownExit = member?.lifecycle === "faulted" && member.resourceState === "cleanup_failed";
		} catch { return; }
		if (!unknownExit) return;
		const reply = this.runtime.memberExitConfirmed(binding);
		if (!reply.ok) throw new Error(reply.error.message);
	}

	private runtimeRecordsFault(binding: RuntimeActivation["binding"]): boolean {
		try {
			return this.runtime.getTeam(binding.teamId).members.find((item) => item.id === binding.memberId)?.lifecycle === "faulted";
		} catch { return false; }
	}

	private async onPrivateRequest(member: ManagedMember, activation: RuntimeActivation, frame: ChildRequestFrame, intentId?: string): Promise<PrivateReply> {
		if (!sameBinding(frame.binding, member.binding) || !sameScope(frame.activation, activation.scope)) throw new Error("Private Team request has a stale binding or activation scope");
		switch (frame.request.action) {
			case "input_ready": {
				const reply = this.runtime.inputReady(member.binding, activation.scope.activationId, frame.request.deliveryId);
				return reply.ok ? { kind: "ack" } : { kind: "gate", decision: {
					allow: false, reason: "delivery_pending", message: reply.error.message,
				} };
			}
			case "business": {
				const reply = this.runtime.handleAction(member.binding, activation.scope, frame.sequence, frame.rpcRequestId,
					frame.request.args, intentId ?? frame.rpcRequestId);
				return { kind: "business", reply };
			}
			case "provider_gate":
				return { kind: "gate", decision: await this.runtime.waitAtProviderGate(member.binding, activation.scope) };
			case "tool_gate":
				return { kind: "gate", decision: this.runtime.gate(member.binding, activation.scope, frame.request.action,
					frame.request.toolCallId, frame.request.toolName, frame.request.endIntent) };
			case "tool_result": {
				const reply = this.runtime.toolResult(member.binding, activation.scope, frame.request.toolCallId, frame.request.toolName);
				return reply.ok ? { kind: "ack" } : { kind: "gate", decision: {
					allow: false, reason: "activation_ending", message: reply.error.message,
				} };
			}
			case "boundary":
				return { kind: "ack" };
		}
	}

}