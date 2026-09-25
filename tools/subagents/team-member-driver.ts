import { resolve } from "node:path";
import type { RailModelRef } from "./models";
import { railModelReference } from "./models";
import type { BrokeredTeamMemberHandle, SessionBroker } from "./session-broker";
import type { ChildRequestFrame, PrivateReply } from "./team-protocol";
import { sameBinding, sameScope } from "./team-codec";
import { TeamRuntime, type NativeCompletion, type RuntimeActivation } from "./team-runtime";
import { TeamActivationFailure } from "./team-rpc-v2";

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
	sessionId: string;
}

interface ManagedMember {
	binding: RuntimeActivation["binding"];
	handle: BrokeredTeamMemberHandle;
	contextWindow?: number;
}

function key(teamId: string, memberId: string): string {
	return `${teamId}\0${memberId}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Drives Runtime-reserved activations through Broker-owned, single-writer native sessions. */
export class TeamMemberDriver {
	private readonly members = new Map<string, ManagedMember>();
	private readonly runningMembers = new Set<string>();

	constructor(private readonly runtime: TeamRuntime, private readonly broker: SessionBroker) {}

	async openMember(request: OpenTeamMemberRequest): Promise<BrokeredTeamMemberHandle> {
		const binding = this.runtime.bindingForDriver(request.teamId, request.memberId);
		const planned = this.runtime.getTeam(request.teamId).members.find((member) => member.id === request.memberId);
		if (!planned) throw new Error(`Unknown Team member ${request.memberId}`);
		if (planned.policy.model && planned.policy.model !== railModelReference(request.model)) {
			throw new Error(`Team member ${request.memberId} model does not match its prepared policy`);
		}
		const cwd = request.cwd ?? planned.policy.cwd;
		if (planned.policy.cwd && cwd && resolve(planned.policy.cwd) !== resolve(cwd)) {
			throw new Error(`Team member ${request.memberId} cwd does not match its prepared policy`);
		}
		if (planned.policy.fastMode !== undefined && request.fastMode !== undefined && planned.policy.fastMode !== request.fastMode) {
			throw new Error(`Team member ${request.memberId} fastMode does not match its prepared policy`);
		}
		if (planned.policy.contextWindow !== undefined && request.contextWindow !== undefined && planned.policy.contextWindow !== request.contextWindow) {
			throw new Error(`Team member ${request.memberId} contextWindow does not match its prepared policy`);
		}
		const fastMode = request.fastMode ?? planned.policy.fastMode;
		const contextWindow = request.contextWindow ?? planned.policy.contextWindow;
		const id = key(request.teamId, request.memberId);
		if (this.members.has(id)) throw new Error(`Team member ${request.memberId} already has a native lifetime`);
		const handle = await this.broker.openTeamMember({
			binding,
			model: request.model,
			...(cwd ? { cwd } : {}),
			...(fastMode !== undefined ? { fastMode } : {}),
			...(contextWindow !== undefined ? { contextWindow } : {}),
		});
		this.members.set(id, { binding, handle, ...(contextWindow !== undefined ? { contextWindow } : {}) });
		return handle;
	}

	/** Native resources must all be bound before Runtime admits any activation. */
	launch(teamId: string) {
		const team = this.runtime.getTeam(teamId);
		if (team.lifecycle !== "prepared") throw new Error(`Cannot launch Team in ${team.lifecycle}`);
		const missing = team.members.filter((member) => !this.members.has(key(teamId, member.id))).map((member) => member.id);
		if (missing.length) throw new Error(`Team members need Broker-owned native lifetimes before launch: ${missing.join(", ")}`);
		return this.runtime.launch(teamId);
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
		const id = key(activation.binding.teamId, activation.binding.memberId);
		const member = this.members.get(id);
		if (!member) throw new Error(`No Broker-owned native lifetime for Team member ${activation.binding.memberId}`);
		if (!sameBinding(member.binding, activation.binding)) throw new Error("Runtime activation binding changed during a member lifetime");
		if (this.runningMembers.has(id)) throw new Error(`Team member ${activation.binding.memberId} already has an activation in flight`);
		this.runningMembers.add(id);
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
					if (!result.ok) settlementError = new Error(result.error.message);
					else nativeAccepted = true;
				},
				options.signal,
			);
			if (!native) throw new Error("Team member send returned without a real native agent_settled boundary");
			if (settlementError) {
				this.runtime.activationLost(activation.binding, activation.scope.activationId,
					{ code: "PROTOCOL_FAILURE", message: settlementError.message }, true);
				lostProcessed = true;
				throw settlementError;
			}
			cleanupAttempted = true;
			const cleanup = this.runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
			if (!cleanup.ok) throw new Error(cleanup.error.message);
			return { activation, completion: native, sessionId: member.handle.sessionId };
		} catch (error) {
			if (!native && !lostProcessed) {
				const released = error instanceof TeamActivationFailure && error.resourceReleased;
				this.runtime.activationLost(activation.binding, activation.scope.activationId, {
					code: "NATIVE_OUTCOME_UNKNOWN", message: errorMessage(error), outcomeUnknown: true,
				}, released);
				lostProcessed = true;
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
			this.runningMembers.delete(id);
		}
	}

	async closeMember(teamId: string, memberId: string): Promise<void> {
		const id = key(teamId, memberId);
		const member = this.members.get(id);
		if (!member) return;
		if (this.runningMembers.has(id)) throw new Error(`Cannot close Team member ${memberId} while an activation is running`);
		await member.handle.close();
		this.members.delete(id);
	}

	async close(): Promise<void> {
		const failures: unknown[] = [];
		for (const [id, member] of [...this.members.entries()]) {
			try {
				await member.handle.close();
				this.members.delete(id);
			} catch (error) {
				// Keep the handle and Runtime association so uncertain exit never frees ownership.
				failures.push(error);
			}
		}
		if (failures.length) throw new AggregateError(failures, "One or more Team member exits are unconfirmed");
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
			case "tool_gate":
				return { kind: "gate", decision: this.runtime.gate(member.binding, activation.scope, frame.request.action) };
			case "boundary":
				return { kind: "ack" };
		}
	}

}