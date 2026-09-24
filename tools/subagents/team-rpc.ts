import { randomUUID } from "node:crypto";
import type { RpcEvent, RpcTransport } from "./rpc-worker";
import { TEAM_COMMAND, TEAM_ENTRY_TYPE, isTeamBinding, sameTeamBinding, type TeamCommand, type TeamWorkerChannel } from "./team-protocol";
import { TEAM_COMMAND_DESCRIPTION, TEAM_FRAME_BYTES, publicTeamReply, strictTeamRequest } from "./team-extension";

const DELIVERY_TIMEOUT_MS = 5000;

/** One dispatch-local private channel. Never uses the ordinary steer/follow-up queues. */
export class TeamRpcConnection {
	private readonly controller = new AbortController();
	private unsubscribe: (() => void) | undefined;
	private bindingPromise?: Promise<void>;
	private closing?: Promise<void>;
	private stopping?: Promise<void>;
	private bound = false;
	private attempted = false;
	private failure?: Error;
	private sequence = 0;
	private readonly acknowledgements = new Map<string, { resolve(): void; reject(error: Error): void }>();
	private readonly onAbort = () => this.fail(new Error("Team connection aborted"));

	constructor(private readonly transport: RpcTransport, private readonly channel: TeamWorkerChannel, private readonly signal?: AbortSignal) {}

	bind(): Promise<void> {
		return this.bindingPromise ??= this.bindOnce();
	}

	private async bindOnce(): Promise<void> {
		try {
			if (this.closing || this.signal?.aborted || !isTeamBinding(this.channel.binding)) throw new Error("Invalid or aborted team binding");
			this.unsubscribe = this.transport.onEvent((event) => this.onEvent(event));
			this.signal?.addEventListener("abort", this.onAbort, { once: true });
			this.attempted = true;
			await this.command({ version: 1, operation: "bind", commandId: randomUUID(), binding: this.channel.binding });
			this.bound = true;
		} catch (error) {
			this.fail(error);
			await this.stopping;
			throw this.failure;
		}
	}

	close(): Promise<void> {
		return this.closing ??= this.closeOnce();
	}

	private async closeOnce(): Promise<void> {
		try {
			if (this.bindingPromise) await this.bindingPromise;
			if (this.failure) throw this.failure;
			if (this.bound) await this.command({ version: 1, operation: "unbind", commandId: randomUUID(), binding: this.channel.binding });
		} catch (error) {
			this.fail(error);
			throw this.failure;
		} finally {
			this.bound = false;
			this.controller.abort();
			this.dispose();
			for (const pending of this.acknowledgements.values()) pending.reject(new Error("Team connection closed"));
			this.acknowledgements.clear();
			// transport_error is emitted when stop starts, not when the process exits.
			// The worker awaits close before returning to its lease-owning host.
			await this.stopping;
		}
	}

	private dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.signal?.removeEventListener("abort", this.onAbort);
	}

	private fail(error: unknown): void {
		if (this.failure) return;
		this.failure = error instanceof Error ? error : new Error("Team connection failed");
		this.controller.abort(this.failure);
		for (const pending of this.acknowledgements.values()) pending.reject(this.failure);
		this.acknowledgements.clear();
		this.dispose();
		// A lost/unknown delivery cannot safely reuse the child. Stopping also wakes native gates
		// when the child cannot receive an unbind (including a broken transport).
		if (this.attempted) this.stopping ??= Promise.resolve().then(() => this.transport.stop()).catch(() => undefined);
	}

	private bounded<T>(work: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const signal = this.controller.signal;
			const abort = () => done(this.failure ?? new Error("Team connection closed"));
			const timer = setTimeout(() => done(new Error("Team application ACK timed out")), DELIVERY_TIMEOUT_MS);
			const done = (error?: Error, value?: T) => {
				clearTimeout(timer); signal.removeEventListener("abort", abort);
				if (error) reject(error); else resolve(value as T);
			};
			work.then((value) => done(undefined, value), (error) => done(error instanceof Error ? error : new Error("Team transport failed")));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
	}

	private async command(frame: TeamCommand): Promise<void> {
		if (this.failure) throw this.failure;
		// Native Pi allows runtime registerCommand and resolves duplicate suffixes on
		// each invocation. A bind-time cache would allow a later conflict to fall back
		// to ordinary prompt text, so discovery remains per delivery.
		const result = await this.bounded(this.transport.request({ type: "get_commands" })) as { commands?: Array<{ name?: string; source?: string; description?: string }> } | undefined;
		const matches = result?.commands?.filter((c) => c.name === TEAM_COMMAND || c.name?.startsWith(`${TEAM_COMMAND}:`));
		if (matches?.length !== 1 || matches[0]?.name !== TEAM_COMMAND || matches[0]?.source !== "extension" || matches[0]?.description !== TEAM_COMMAND_DESCRIPTION) throw new Error("Missing, conflicting or incompatible team command");
		if (frame.operation === "reply" && (this.closing || this.controller.signal.aborted)) return;
		const text = JSON.stringify(frame);
		if (Buffer.byteLength(text) > TEAM_FRAME_BYTES) throw new Error("Team frame too large");
		const ack = new Promise<void>((resolve, reject) => this.acknowledgements.set(frame.commandId, { resolve, reject }));
		try {
			// Install the ACK waiter before prompt; appendEntry can arrive before command success.
			await this.bounded(Promise.all([ack, this.transport.request({ type: "prompt", message: `/${TEAM_COMMAND} ${text}` })]));
		} finally { this.acknowledgements.delete(frame.commandId); }
	}

	private onEvent(event: RpcEvent): void {
		if (event["type"] === "transport_error") { this.fail(new Error("Team transport lost")); return; }
		if (event["type"] === "extension_error" && String(event["extensionPath"]).endsWith("team-extension.ts")) { this.fail(new Error("Team extension failed")); return; }
		if (event["type"] !== "entry_appended") return;
		const entry = event["entry"] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (entry?.type !== "custom" || entry.customType !== TEAM_ENTRY_TYPE) return;
		try {
			const data = entry.data as Record<string, unknown>;
			if (!data || typeof data !== "object" || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data)) > TEAM_FRAME_BYTES) throw new Error("Invalid team wire frame");
			const allowed = data["kind"] === "ack" ? ["version", "kind", "commandId", "binding", "ok", "error"] : ["version", "kind", "binding", "request"];
			if (!Object.keys(data).every((key) => allowed.includes(key))) throw new Error("Unknown team wire fields");
			if (data["version"] !== 1 || !isTeamBinding(data["binding"]) || !sameTeamBinding(data["binding"], this.channel.binding)) throw new Error("Invalid team wire binding");
			if (data["kind"] === "ack") {
				if (typeof data["commandId"] !== "string" || typeof data["ok"] !== "boolean") throw new Error("Invalid team ACK");
				const waiter = this.acknowledgements.get(data["commandId"]);
				if (!waiter) throw new Error("Unknown team ACK");
				if (!data["ok"]) throw new Error("Team command application rejected");
				waiter.resolve();
			} else if (data["kind"] === "request") {
				if (this.closing || !strictTeamRequest(data["request"])) throw new Error("Invalid team request");
				const request = data["request"];
				// Strictly increasing dispatch-local sequence rejects replay without an
				// ever-growing ID set or an artificial lifetime request limit.
				if (request.sequence !== this.sequence + 1) throw new Error("Invalid team request sequence");
				this.sequence = request.sequence;
				// Never await a dependency wait inside the transport event callback.
				void Promise.resolve().then(() => {
					if (this.closing || this.controller.signal.aborted) return undefined;
					return this.channel.onRequest(request, this.controller.signal);
				}).then(async (reply) => {
					if (this.closing || this.controller.signal.aborted) return;
					const publicReply = publicTeamReply(reply);
					if (publicReply.from !== undefined && (publicReply.from !== "@hub" || publicReply.to !== this.channel.binding.memberId)) throw new Error("Mismatched team reply routing");
					if (publicReply.requestId !== undefined && publicReply.requestId !== request.requestId) throw new Error("Mismatched team reply request id");
					await this.command({ version: 1, operation: "reply", commandId: randomUUID(), binding: this.channel.binding, requestId: request.requestId, reply: publicReply });
				}).catch((error) => {
					if (!this.closing && !this.controller.signal.aborted) this.fail(error);
				});
			} else throw new Error("Invalid team wire event");
		} catch (error) { this.fail(error); }
	}
}
