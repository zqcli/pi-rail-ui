import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderStreamEvent } from "@earendil-works/pi-coding-agent";
import {
	HostedSearchActivity,
	indexHostedSearchActivity,
	observeHostedSearchEvent,
	setActiveHostedSearchActivity,
	type HostedSearchMessage,
	type HostedSearchSnapshot,
} from "./hosted-search-activity";

import { LegacyHostedSearchCapture } from "./hosted-search-legacy";

type CaptureCallbacks = {
	isEnabled(model: Model<Api>): boolean;
	onActivityChanged(activity: HostedSearchActivity, ctx: ExtensionContext): void;
};

/** Uses Pi's public events, with a scoped adapter for older custom provider streams. */
export class HostedSearchProviderCapture {
	private turnActivity: HostedSearchActivity | undefined;
	private turnApi: Api | undefined;
	private turnUnsubscribe: (() => void) | undefined;

	private readonly legacy: LegacyHostedSearchCapture;

	constructor(pi: ExtensionAPI, private readonly callbacks: CaptureCallbacks) {
		this.legacy = new LegacyHostedSearchCapture(pi, (model) => {
			const activity = this.turnActivity;
			return activity && activity.provider === model.provider && activity.model === model.id && this.turnApi === model.api
				? activity : undefined;
		});
	}

	startTurn(ctx: ExtensionContext): void {
		this.clearTurn();
		const model = ctx.model;
		if (!model || !this.callbacks.isEnabled(model)) { this.legacy.shutdown(); return; }
		const activity = new HostedSearchActivity({ provider: model.provider, model: model.id });
		this.turnActivity = activity;
		this.turnApi = model.api;
		setActiveHostedSearchActivity(activity);
		this.turnUnsubscribe = activity.subscribe(() => this.callbacks.onActivityChanged(activity, ctx));
		this.legacy.sync(ctx);
	}

	observe(event: ProviderStreamEvent): void {
		const activity = this.turnActivity;
		if (!activity || event.provider !== activity.provider || event.model !== activity.model || event.api !== this.turnApi) return;
		if (this.legacy.acceptPublicEvent(activity)) observeHostedSearchEvent(activity, event.data);
	}

	associateMessage(message: HostedSearchMessage): void {
		this.turnActivity?.associateMessage(message);
	}

	async finishTurn(message: HostedSearchMessage): Promise<HostedSearchSnapshot | undefined> {
		const activity = this.turnActivity;
		if (!activity || message.provider !== activity.provider || message.model !== activity.model) return undefined;
		activity.associateMessage(message);
		// Public events are awaited by Pi. Only custom legacy fetch observers can
		// still be reading the response copy when the assistant finishes.
		await this.legacy.finish(activity);
		activity.finalizeFromMessage(message);
		if (activity.observed) indexHostedSearchActivity(activity);
		this.clearTurn();
		return activity.observed ? activity.snapshot() : undefined;
	}

	shutdown(): void {
		this.clearTurn();
		this.legacy.shutdown();
	}

	private clearTurn(): void {
		this.turnUnsubscribe?.();
		this.turnUnsubscribe = undefined;
		this.turnActivity = undefined;
		this.turnApi = undefined;
		setActiveHostedSearchActivity(undefined);
	}
}
