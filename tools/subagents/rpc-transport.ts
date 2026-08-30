import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RpcEvent, RpcTransport } from "./rpc-worker";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export class RpcCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcCommandError";
	}
}

export class RpcTransportError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RpcTransportError";
	}
}

export interface PiRpcProcessTransportOptions {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	onUiRequest?: (request: RpcEvent) => Promise<Record<string, unknown> | undefined>;
}

const STDERR_CAP = 50 * 1024;

export class PiRpcProcessTransport implements RpcTransport {
	private process: ChildProcessWithoutNullStreams | undefined;
	private readonly listeners = new Set<(event: RpcEvent) => void>();
	private readonly pending = new Map<string, PendingRequest>();
	private requestId = 0;
	private stderr = "";
	private stopping = false;

	constructor(private readonly options: PiRpcProcessTransportOptions) {}

	async start(): Promise<void> {
		if (this.process) throw new Error("Subagent RPC transport already started");
		this.stopping = false;
		const proc = spawn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env ?? process.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = proc;
		this.attachStdout(proc);
		proc.stderr.on("data", (chunk) => {
			this.stderr = `${this.stderr}${chunk.toString()}`.slice(-STDERR_CAP);
		});
		proc.once("error", (error) => {
			const failure = new Error(`Subagent RPC process error: ${error.message}`);
			this.rejectPending(failure);
			this.emitEvent({ type: "transport_error", error: failure.message });
		});
		proc.stdin.on("error", (error) => {
			if (!this.stopping) {
				const failure = new Error(`Subagent RPC stdin error: ${error.message}`);
				this.rejectPending(failure);
				this.emitEvent({ type: "transport_error", error: failure.message });
			}
		});
		proc.once("exit", (code, signal) => {
			if (this.process === proc) this.process = undefined;
			if (!this.stopping) {
				const failure = new Error(`Subagent RPC process exited (code=${code} signal=${signal}). ${this.stderr}`.trim());
				this.rejectPending(failure);
				this.emitEvent({ type: "transport_error", error: failure.message });
			}
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (proc.exitCode !== null) {
			throw new Error(`Subagent RPC process exited during startup (code=${proc.exitCode}). ${this.stderr}`.trim());
		}
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	request(command: Record<string, unknown>): Promise<unknown> {
		const proc = this.process;
		if (this.stopping || !proc || proc.exitCode !== null || proc.stdin.destroyed) {
			return Promise.reject(new RpcTransportError("Subagent RPC process is not running"));
		}
		const id = `rail-subagent-${++this.requestId}`;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	async stop(): Promise<void> {
		const proc = this.process;
		if (!proc) return;
		this.stopping = true;
		const stopped = new Error("Subagent RPC process stopped");
		this.rejectPending(stopped);
		this.emitEvent({ type: "transport_error", error: stopped.message });
		proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			if (proc.exitCode !== null) {
				resolve();
				return;
			}
			const timeout = setTimeout(() => {
				proc.kill("SIGKILL");
				resolve();
			}, 1500);
			proc.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		if (this.process === proc) this.process = undefined;
	}

	private attachStdout(proc: ChildProcessWithoutNullStreams): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const consume = () => {
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				this.handleLine(line);
			}
		};
		proc.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			consume();
		});
		proc.stdout.on("end", () => {
			buffer += decoder.end();
			consume();
			if (buffer) this.handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
		});
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let value: any;
		try {
			value = JSON.parse(line);
		} catch {
			return;
		}
		if (value?.type === "response" && typeof value.id === "string") {
			const pending = this.pending.get(value.id);
			if (!pending) return;
			this.pending.delete(value.id);
			if (value.success === false) pending.reject(new RpcCommandError(String(value.error ?? "Subagent RPC request failed")));
			else pending.resolve(value.data);
			return;
		}
		if (!value || typeof value.type !== "string") return;
		const event = value as RpcEvent;
		this.emitEvent(event);
		if (event.type === "extension_ui_request") void this.respondToUiRequest(event);
	}

	private async respondToUiRequest(event: RpcEvent): Promise<void> {
		const id = event["id"];
		if (typeof id !== "string") return;
		if (!this.options.onUiRequest) {
			this.writeRaw({ type: "extension_ui_response", id, cancelled: true });
			return;
		}
		try {
			const response = await this.options.onUiRequest(event);
			if (response) this.writeRaw({ type: "extension_ui_response", id, ...response });
		} catch {
			this.writeRaw({ type: "extension_ui_response", id, cancelled: true });
		}
	}

	private writeRaw(value: Record<string, unknown>): void {
		const proc = this.process;
		if (proc && proc.exitCode === null && !proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify(value)}\n`);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private emitEvent(event: RpcEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
