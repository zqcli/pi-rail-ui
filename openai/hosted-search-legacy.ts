import type { Api, FetchFunction, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { HostedSearchActivity, observeHostedSearchEvent } from "./hosted-search-activity";
import { PROVIDER_STREAM_EVENTS } from "./provider-stream-events";

const CAPTURE_APIS = new Set(["openai-responses", "azure-openai-responses"]);
const MAX_SSE_FRAME_LENGTH = 2_000_000;
type RegisteredProviderConfig = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getRegisteredProviderConfig"]>>;
type LegacyReaders = { stop: AbortController; tasks: Set<Promise<void>>; completedAt?: number };
type ProviderLease = {
	providerId: string;
	api: Api;
	previousConfig: RegisteredProviderConfig;
	wrapper: NonNullable<ProviderConfig["streamSimple"]>;
};

/** Only custom legacy streams lack a guaranteed provider_stream_event contract. */
export class LegacyHostedSearchCapture {
	private lease: ProviderLease | undefined;
	private context: ExtensionContext | undefined;
	private readonly readers = new WeakMap<HostedSearchActivity, LegacyReaders>();

	constructor(private readonly pi: ExtensionAPI, private readonly activityFor: (model: Model<Api>) => HostedSearchActivity | undefined) {}

	cancel(activity: HostedSearchActivity): void {
		this.readers.get(activity)?.stop.abort();
	}

	async finish(activity: HostedSearchActivity): Promise<void> {
		const readers = this.readers.get(activity);
		if (!readers) return;
		await Promise.all(readers.tasks);
		// Wire completion may race ahead of the public stream. Close the legacy
		// card only after Pi finishes, using the original completion timestamp.
		if (!readers.stop.signal.aborted && readers.completedAt !== undefined) activity.complete(readers.completedAt);
	}

	sync(ctx: ExtensionContext): void {
		this.context = ctx;
		const model = ctx.model;
		const registry = ctx.modelRegistry;
		let current = model ? registry.getRegisteredProviderConfig(model.provider) : undefined;
		if (model && this.lease?.providerId === model.provider && this.lease.api === model.api && current?.streamSimple === this.lease.wrapper) return;
		this.restore();
		current = model ? registry.getRegisteredProviderConfig(model.provider) : undefined;
		if (!model || !CAPTURE_APIS.has(model.api) || !current?.streamSimple || current.api !== model.api || registry.getRegisteredNativeProvider(model.provider)) return;
		if (Reflect.get(current.streamSimple, PROVIDER_STREAM_EVENTS) === true) return;
		const original = registry.getProvider(model.provider);
		if (!original) return;
		const wrapper: NonNullable<ProviderConfig["streamSimple"]> = (requestModel, context, options) => {
			const activity = this.activityFor(requestModel);
			if (!activity) return original.streamSimple(requestModel, context, options);
			const readers: LegacyReaders = this.readers.get(activity) ?? { stop: new AbortController(), tasks: new Set<Promise<void>>() };
			this.readers.set(activity, readers);
			const baseFetch = options?.fetch ?? globalThis.fetch;
			const fetch: FetchFunction = async (input, init) => {
				const response = await baseFetch(input, init);
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const contentType = response.headers.get("content-type");
				if (!/\/responses(?:[?#]|$)/u.test(url) || !response.body || (contentType && !contentType.toLowerCase().includes("text/event-stream"))) return response;
				if (readers.stop.signal.aborted) return response;
				let clone: Response;
				try { clone = response.clone(); } catch { return response; }
				if (!clone.body) return response;
				const signals = [readers.stop.signal, options?.signal, init?.signal ?? (input instanceof Request ? input.signal : undefined)];
				const signal = AbortSignal.any(signals.filter((value): value is AbortSignal => value != null));
				const observer = new HostedSearchSseObserver(activity, (at) => { readers.completedAt = at; });
				const task = observeResponseBody(clone, observer, signal).catch(() => undefined).finally(() => readers.tasks.delete(task));
				readers.tasks.add(task);
				return response;
			};
			return original.streamSimple(requestModel, context, { ...options, fetch });
		};
		this.pi.registerProvider(model.provider, { api: model.api, streamSimple: wrapper });
		if (registry.getRegisteredProviderConfig(model.provider)?.streamSimple === wrapper) {
			this.lease = { providerId: model.provider, api: model.api, previousConfig: current, wrapper };
		}
	}

	restore(): void {
		const lease = this.lease;
		this.lease = undefined;
		if (!lease || !this.context) return;
		const current = this.context.modelRegistry.getRegisteredProviderConfig(lease.providerId);
		if (current?.streamSimple !== lease.wrapper) return;
		const { streamSimple: _stream, api: currentApi, ...rest } = current;
		const restored: RegisteredProviderConfig = { ...lease.previousConfig, ...rest };
		if (currentApi !== lease.api && currentApi !== undefined) restored.api = currentApi;
		this.pi.unregisterProvider(lease.providerId);
		// Pi 1.5.2's registry model types allow explicit undefined samplingParams.
		this.pi.registerProvider(lease.providerId, restored as ProviderConfig);
	}

	shutdown(): void {
		this.restore();
		this.context = undefined;
	}
}

async function observeResponseBody(response: Response, observer: HostedSearchSseObserver, signal: AbortSignal): Promise<void> {
	const reader = response.body!.getReader();
	const cancel = () => { void reader.cancel().catch(() => undefined); };
	if (signal.aborted) { cancel(); reader.releaseLock(); return; }
	signal.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (signal.aborted) return;
			if (done) break;
			observer.push(value);
			if (observer.done) { cancel(); break; }
		}
		if (!signal.aborted) observer.end();
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

class HostedSearchSseObserver {
	private readonly decoder = new TextDecoder();
	private buffer = "";
	private discardingOversizedFrame = false;
	private doneValue = false;

	constructor(private readonly activity: HostedSearchActivity, private readonly onCompleted: (endedAt: number) => void) {}

	get done(): boolean { return this.doneValue; }

	push(chunk: Uint8Array | string): void {
		if (this.doneValue) return;
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		this.drain(false);
	}

	end(): void {
		if (this.doneValue) return;
		this.buffer += this.decoder.decode();
		this.drain(true);
	}

	private drain(flush: boolean): void {
		for (;;) {
			if (this.discardingOversizedFrame) {
				const discarded = /\r?\n\r?\n/u.exec(this.buffer);
				if (!discarded) {
					this.buffer = this.buffer.slice(-3);
					break;
				}
				this.buffer = this.buffer.slice(discarded.index + discarded[0].length);
				this.discardingOversizedFrame = false;
				continue;
			}
			const match = /\r?\n\r?\n/u.exec(this.buffer);
			if (!match) {
				if (this.buffer.length > MAX_SSE_FRAME_LENGTH) {
					this.buffer = this.buffer.slice(-3);
					this.discardingOversizedFrame = true;
				}
				break;
			}
			const frame = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			if (frame.length <= MAX_SSE_FRAME_LENGTH) this.handleFrame(frame);
			if (this.doneValue) {
				this.buffer = "";
				break;
			}
		}
		if (flush && !this.discardingOversizedFrame && this.buffer.trim()) {
			if (this.buffer.length <= MAX_SSE_FRAME_LENGTH) this.handleFrame(this.buffer);
			this.buffer = "";
		}
	}

	private handleFrame(frame: string): void {
		const data = frame
			.split(/\r?\n/u)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /u, ""))
			.join("\n");
		if (!data) return;
		if (data === "[DONE]") {
			this.doneValue = true;
			return;
		}
		try {
			observeHostedSearchEvent(this.activity, JSON.parse(data), this.onCompleted);
		} catch {
			// Capture is observational; malformed provider events must not affect the model stream.
		}
	}
}
