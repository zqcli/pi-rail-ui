import type {
	Api,
	Context,
	FetchFunction,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
	HostedSearchActivity,
	HostedSearchSseObserver,
	indexHostedSearchActivity,
	setActiveHostedSearchActivity,
	type HostedSearchSnapshot,
} from "./hosted-search-activity";

// Codex Responses defaults to WebSocket transport in Pi 0.84.4, so a fetch-only observer
// must not claim capture support for it.
const CAPTURE_APIS = new Set(["openai-responses", "azure-openai-responses"]);

type SearchAssistantMessage = {
	provider: string;
	model: string;
	responseId?: string | undefined;
	timestamp?: number | undefined;
	stopReason?: string | undefined;
	errorMessage?: string | undefined;
};

type ProviderLease = {
	providerId: string;
	api: Api;
	previousConfig: ProviderConfig | undefined;
	wrapper: NonNullable<ProviderConfig["streamSimple"]>;
};

type CaptureCallbacks = {
	isEnabled(model: Model<Api>): boolean;
	onActivityChanged(activity: HostedSearchActivity, ctx: ExtensionContext): void;
};

function requestUrl(input: Parameters<FetchFunction>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function requestSignal(input: Parameters<FetchFunction>[0], init?: RequestInit): AbortSignal | undefined {
	if (init?.signal) return init.signal;
	return input instanceof Request ? input.signal : undefined;
}

async function observeResponseBody(
	response: Response,
	activity: HostedSearchActivity,
	signal?: AbortSignal | undefined,
): Promise<void> {
	let clone: Response;
	try {
		clone = response.clone();
	} catch {
		return;
	}
	if (!clone.body) return;
	const observer = new HostedSearchSseObserver(activity);
	const reader = clone.body.getReader();
	const cancelReader = () => { void reader.cancel().catch(() => undefined); };
	if (signal?.aborted) {
		cancelReader();
		reader.releaseLock();
		return;
	}
	signal?.addEventListener("abort", cancelReader, { once: true });
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			observer.push(value);
			if (observer.done) {
				cancelReader();
				break;
			}
		}
		observer.end();
	} finally {
		signal?.removeEventListener("abort", cancelReader);
		reader.releaseLock();
	}
}

export function createHostedSearchObservedFetch(
	baseFetch: FetchFunction,
	activity: HostedSearchActivity,
): FetchFunction {
	return async (input, init) => {
		const response = await baseFetch(input, init);
		if (!/\/responses(?:[?#]|$)/u.test(requestUrl(input)) || !response.body) return response;
		const contentType = response.headers.get("content-type");
		if (contentType && !contentType.toLowerCase().includes("text/event-stream")) return response;
		activity.observe(observeResponseBody(response, activity, requestSignal(input, init)));
		return response;
	};
}

export class HostedSearchProviderCapture {
	private lease: ProviderLease | undefined;
	private turnActive = false;
	private turnActivity: HostedSearchActivity | undefined;
	private turnUnsubscribe: (() => void) | undefined;
	private sessionContext: ExtensionContext | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly callbacks: CaptureCallbacks,
	) {}

	startTurn(): void {
		this.turnUnsubscribe?.();
		this.turnUnsubscribe = undefined;
		this.turnActive = true;
		this.turnActivity = undefined;
		setActiveHostedSearchActivity(undefined);
	}

	associateMessage(message: SearchAssistantMessage): void {
		this.turnActivity?.associateMessage(message);
	}

	async finishTurn(message: SearchAssistantMessage): Promise<HostedSearchSnapshot | undefined> {
		this.turnActive = false;
		const activity = this.turnActivity;
		if (!activity) return undefined;
		activity.associateMessage(message);
		await activity.waitForObservers();
		activity.finalizeFromMessage(message);
		if (activity.observed) indexHostedSearchActivity(activity);
		this.turnUnsubscribe?.();
		this.turnUnsubscribe = undefined;
		this.turnActivity = undefined;
		setActiveHostedSearchActivity(undefined);
		return activity.observed ? activity.snapshot() : undefined;
	}

	sync(ctx: ExtensionContext, enabled: boolean): boolean {
		this.sessionContext = ctx;
		const model = ctx.model;
		const registeredConfig = model
			? ctx.modelRegistry.getRegisteredProviderConfig(model.provider)
			: undefined;
		if (
			enabled
			&& model
			&& CAPTURE_APIS.has(model.api)
			&& this.lease?.providerId === model.provider
			&& this.lease.api === model.api
			&& registeredConfig?.api === model.api
			&& registeredConfig?.streamSimple === this.lease.wrapper
		) {
			return true;
		}

		this.restore();
		if (!enabled || !model || !CAPTURE_APIS.has(model.api)) return false;
		if (ctx.modelRegistry.getRegisteredNativeProvider(model.provider)) return false;

		const originalProvider = ctx.modelRegistry.getProvider(model.provider);
		if (!originalProvider) return false;
		const previousConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
		const wrapper = (
			requestModel: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		) => {
			let nextOptions = options;
			if (this.turnActive && this.callbacks.isEnabled(requestModel)) {
				const activity = this.turnActivity ?? new HostedSearchActivity({
					provider: requestModel.provider,
					model: requestModel.id,
				});
				if (!this.turnActivity) {
					this.turnActivity = activity;
					setActiveHostedSearchActivity(activity);
					this.turnUnsubscribe = activity.subscribe(() => {
						const activeContext = this.sessionContext;
						if (activeContext) this.callbacks.onActivityChanged(activity, activeContext);
					});
				}
				const baseFetch = options?.fetch ?? globalThis.fetch;
				nextOptions = { ...options, fetch: createHostedSearchObservedFetch(baseFetch, activity) };
			}
			return originalProvider.streamSimple(requestModel, context, nextOptions);
		};

		this.pi.registerProvider(model.provider, { api: model.api, streamSimple: wrapper });
		const token = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
		if (!token || token.streamSimple !== wrapper) return false;
		this.lease = {
			providerId: model.provider,
			api: model.api,
			previousConfig,
			wrapper,
		};
		return true;
	}

	restore(): void {
		const lease = this.lease;
		this.lease = undefined;
		if (!lease || !this.sessionContext) return;
		const registry = this.sessionContext.modelRegistry;
		const current = registry.getRegisteredProviderConfig(lease.providerId);
		if (!current || current.streamSimple !== lease.wrapper) return;
		const {
			streamSimple: _currentStream,
			api: currentApi,
			...rest
		} = current;
		const restored: ProviderConfig = { ...rest };
		if (currentApi !== lease.api && currentApi !== undefined) restored.api = currentApi;
		else if (lease.previousConfig?.api !== undefined) restored.api = lease.previousConfig.api;
		if (lease.previousConfig?.streamSimple) restored.streamSimple = lease.previousConfig.streamSimple;
		this.pi.unregisterProvider(lease.providerId);
		if (Object.keys(restored).length > 0) this.pi.registerProvider(lease.providerId, restored);
	}

	shutdown(): void {
		this.turnUnsubscribe?.();
		this.turnUnsubscribe = undefined;
		this.turnActive = false;
		this.turnActivity = undefined;
		setActiveHostedSearchActivity(undefined);
		this.restore();
		this.sessionContext = undefined;
	}
}
