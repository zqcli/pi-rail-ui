import type { AssistantMessage } from "@earendil-works/pi-ai";

export const HOSTED_SEARCH_ENTRY_TYPE = "rail-oai-hosted-search";
export const HOSTED_SEARCH_ENTRY_VERSION = 1;

const MAX_CALLS = 24;
const MAX_SOURCES = 32;
const MAX_TEXT_LENGTH = 1000;
const MAX_SSE_FRAME_LENGTH = 2_000_000;

export type HostedSearchPhase = "pending" | "running" | "completed" | "failed" | "cancelled";
export type HostedSearchActionType = "search" | "open_page" | "find_in_page" | "other";

export type HostedSearchCall = {
	id: string;
	status: string;
	type: HostedSearchActionType;
	query?: string | undefined;
	url?: string | undefined;
};

export type HostedSearchSource = {
	title?: string | undefined;
	url: string;
};

export type HostedSearchSnapshot = {
	version: 1;
	responseId?: string | undefined;
	assistantTimestamp?: number | undefined;
	provider: string;
	model: string;
	phase: HostedSearchPhase;
	startedAt: number;
	endedAt?: number | undefined;
	calls: HostedSearchCall[];
	sources: HostedSearchSource[];
	error?: string | undefined;
};

type ActivityListener = () => void;

export type HostedSearchMessage = Pick<AssistantMessage, "provider" | "model"> & {
	responseId?: string | undefined;
	timestamp?: number | undefined;
	stopReason?: string | undefined;
	errorMessage?: string | undefined;
};

function cleanText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "").trim();
	if (!clean) return undefined;
	return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function cleanUrl(value: unknown): string | undefined {
	const text = cleanText(value);
	if (!text) return undefined;
	try {
		const url = new URL(text);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class HostedSearchActivity {
	private readonly callsById = new Map<string, HostedSearchCall>();
	private readonly sourcesByUrl = new Map<string, HostedSearchSource>();
	private readonly listeners = new Set<ActivityListener>();
	private readonly observerTasks = new Set<Promise<void>>();
	private responseIdValue: string | undefined;
	private assistantTimestampValue: number | undefined;
	private phaseValue: HostedSearchPhase;
	private endedAtValue: number | undefined;
	private errorValue: string | undefined;

	readonly provider: string;
	readonly model: string;
	readonly startedAt: number;

	constructor(input: {
		provider: string;
		model: string;
		startedAt?: number;
		phase?: HostedSearchPhase;
		responseId?: string | undefined;
		assistantTimestamp?: number | undefined;
	}) {
		this.provider = input.provider;
		this.model = input.model;
		this.startedAt = input.startedAt ?? Date.now();
		this.phaseValue = input.phase ?? "pending";
		this.responseIdValue = input.responseId;
		this.assistantTimestampValue = input.assistantTimestamp;
	}

	static restore(snapshot: HostedSearchSnapshot): HostedSearchActivity {
		const activity = new HostedSearchActivity({
			provider: snapshot.provider,
			model: snapshot.model,
			startedAt: snapshot.startedAt,
			phase: snapshot.phase,
			responseId: snapshot.responseId,
			assistantTimestamp: snapshot.assistantTimestamp,
		});
		activity.endedAtValue = snapshot.endedAt;
		for (const call of snapshot.calls.slice(0, MAX_CALLS)) activity.upsertCall(call.id, call.status, call);
		for (const source of snapshot.sources.slice(0, MAX_SOURCES)) activity.addSource(source.url, source.title, false);
		activity.phaseValue = snapshot.phase;
		activity.errorValue = cleanText(snapshot.error) ?? (snapshot.phase === "failed" ? activity.errorValue : undefined);
		return activity;
	}

	get responseId(): string | undefined { return this.responseIdValue; }
	get assistantTimestamp(): number | undefined { return this.assistantTimestampValue; }
	get phase(): HostedSearchPhase { return this.phaseValue; }
	get observed(): boolean { return this.callsById.size > 0; }
	get terminal(): boolean { return this.phaseValue === "completed" || this.phaseValue === "failed" || this.phaseValue === "cancelled"; }

	subscribe(listener: ActivityListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setResponseId(responseId: unknown): void {
		const value = cleanText(responseId, 256);
		if (!value || value === this.responseIdValue) return;
		this.responseIdValue = value;
		this.notify();
	}

	associateMessage(message: HostedSearchMessage): void {
		if (message.provider !== this.provider || message.model !== this.model) return;
		if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
			this.assistantTimestampValue = message.timestamp;
		}
		if (message.responseId) this.setResponseId(message.responseId);
		else this.notify();
	}

	upsertCall(id: unknown, status: unknown, action?: unknown): void {
		const callId = cleanText(id, 256);
		if (!callId) return;
		const existing = this.callsById.get(callId);
		if (!existing && this.callsById.size >= MAX_CALLS) return;
		const normalized = normalizeAction(action);
		const call: HostedSearchCall = {
			id: callId,
			status: cleanText(status, 64) ?? existing?.status ?? "in_progress",
			type: normalized.type ?? existing?.type ?? "other",
			query: normalized.query ?? existing?.query,
			url: normalized.url ?? existing?.url,
		};
		this.callsById.set(callId, call);
		if (call.url) this.addSource(call.url, undefined, false);
		for (const source of normalized.sources) this.addSource(source.url, source.title, false);
		if (call.status === "failed") {
			this.phaseValue = "failed";
			this.errorValue ??= "Search call failed";
		} else if (!this.terminal) {
			this.phaseValue = "running";
		}
		this.notify();
	}

	addSource(url: unknown, title?: unknown, notify = true): void {
		const normalizedUrl = cleanUrl(url);
		if (!normalizedUrl) return;
		const normalizedTitle = cleanText(title, 300);
		const existing = this.sourcesByUrl.get(normalizedUrl);
		if (!existing && this.sourcesByUrl.size >= MAX_SOURCES) return;
		this.sourcesByUrl.set(normalizedUrl, {
			url: normalizedUrl,
			title: normalizedTitle ?? existing?.title,
		});
		if (notify) this.notify();
	}

	complete(endedAt = Date.now()): void {
		if (!this.observed) return;
		if (!this.terminal) this.phaseValue = "completed";
		this.endedAtValue = endedAt;
		this.notify();
	}

	fail(error?: unknown, endedAt = Date.now()): void {
		if (!this.observed) return;
		this.phaseValue = "failed";
		this.errorValue = cleanText(error) ?? "Search failed";
		this.endedAtValue = endedAt;
		this.notify();
	}

	cancel(endedAt = Date.now()): void {
		if (!this.observed) return;
		this.phaseValue = "cancelled";
		this.endedAtValue = endedAt;
		this.notify();
	}

	finalizeFromMessage(message: HostedSearchMessage): void {
		if (!this.observed) return;
		if (message.responseId) this.setResponseId(message.responseId);
		if (message.stopReason === "aborted") this.cancel();
		else if (message.stopReason === "error") this.fail(message.errorMessage);
		else if (!this.terminal) this.complete();
	}

	observe(task: Promise<void>): void {
		const tracked = task.catch(() => undefined).finally(() => this.observerTasks.delete(tracked));
		this.observerTasks.add(tracked);
	}

	async waitForObservers(): Promise<void> {
		await Promise.all([...this.observerTasks]);
	}

	snapshot(): HostedSearchSnapshot {
		return {
			version: HOSTED_SEARCH_ENTRY_VERSION,
			responseId: this.responseIdValue,
			assistantTimestamp: this.assistantTimestampValue,
			provider: this.provider,
			model: this.model,
			phase: this.phaseValue,
			startedAt: this.startedAt,
			endedAt: this.endedAtValue,
			calls: [...this.callsById.values()],
			sources: [...this.sourcesByUrl.values()],
			error: this.errorValue,
		};
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

function normalizeAction(action: unknown): {
	type?: HostedSearchActionType | undefined;
	query?: string | undefined;
	url?: string | undefined;
	sources: HostedSearchSource[];
} {
	if (!isRecord(action)) return { sources: [] };
	const rawType = cleanText(action["type"], 64);
	const type: HostedSearchActionType = rawType === "search" || rawType === "open_page" || rawType === "find_in_page"
		? rawType
		: "other";
	const queries = Array.isArray(action["queries"])
		? action["queries"].filter((query): query is string => typeof query === "string").join(" · ")
		: "";
	const query = type === "search"
		? cleanText(queries) ?? cleanText(action["query"])
		: type === "find_in_page"
			? cleanText(action["pattern"])
			: undefined;
	const url = cleanUrl(action["url"]);
	const sources: HostedSearchSource[] = [];
	for (const source of Array.isArray(action["sources"]) ? action["sources"] : []) {
		if (!isRecord(source)) continue;
		const sourceUrl = cleanUrl(source["url"]);
		if (sourceUrl) sources.push({ url: sourceUrl, title: cleanText(source["title"], 300) });
	}
	return { type, query, url, sources };
}

function citationFrom(annotation: unknown): { url: unknown; title?: unknown } | undefined {
	if (!isRecord(annotation) || annotation["type"] !== "url_citation") return undefined;
	return { url: annotation["url"], title: annotation["title"] };
}

function annotationsFrom(value: unknown): Array<{ url: unknown; title?: unknown }> {
	if (!isRecord(value)) return [];
	const content = Array.isArray(value["content"]) ? value["content"] : [];
	const annotations: Array<{ url: unknown; title?: unknown }> = [];
	for (const part of content) {
		if (!isRecord(part) || !Array.isArray(part["annotations"])) continue;
		for (const annotation of part["annotations"]) {
			const citation = citationFrom(annotation);
			if (citation) annotations.push(citation);
		}
	}
	return annotations;
}

export class HostedSearchSseObserver {
	private readonly decoder = new TextDecoder();
	private buffer = "";
	private discardingOversizedFrame = false;
	private doneValue = false;

	constructor(private readonly activity: HostedSearchActivity) {}

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
			this.handleEvent(JSON.parse(data));
		} catch {
			// Capture is observational; malformed provider events must not affect the model stream.
		}
	}

	private handleEvent(value: unknown): void {
		if (!isRecord(value)) return;
		const type = value["type"];
		if (type === "response.created" && isRecord(value["response"])) {
			this.activity.setResponseId(value["response"]["id"]);
			return;
		}
		if (type === "response.web_search_call.in_progress" || type === "response.web_search_call.searching") {
			this.activity.upsertCall(value["item_id"], type.endsWith("searching") ? "searching" : "in_progress");
			return;
		}
		if (type === "response.web_search_call.completed") {
			this.activity.upsertCall(value["item_id"], "completed");
			return;
		}
		if (type === "response.output_item.added" || type === "response.output_item.done") {
			this.handleOutputItem(value["item"]);
			return;
		}
		if (type === "response.content_part.done" && isRecord(value["part"])) {
			for (const annotation of annotationsFrom({ content: [value["part"]] })) this.activity.addSource(annotation.url, annotation.title);
			return;
		}
		if (type === "response.output_text.annotation.added") {
			const citation = citationFrom(value["annotation"]);
			if (citation) this.activity.addSource(citation.url, citation.title);
			return;
		}
		if (type === "response.completed" && isRecord(value["response"])) {
			const response = value["response"];
			this.activity.setResponseId(response["id"]);
			for (const item of Array.isArray(response["output"]) ? response["output"] : []) this.handleOutputItem(item);
			this.activity.complete(typeof response["completed_at"] === "number" ? response["completed_at"] * 1000 : Date.now());
			return;
		}
		if (type === "response.failed" || type === "error") {
			const error = isRecord(value["response"]) ? value["response"]["error"] : value["message"] ?? value["error"];
			this.activity.fail(isRecord(error) ? error["message"] : error);
		}
	}

	private handleOutputItem(item: unknown): void {
		if (!isRecord(item)) return;
		if (item["type"] === "web_search_call") {
			this.activity.upsertCall(item["id"], item["status"], item["action"]);
			return;
		}
		for (const annotation of annotationsFrom(item)) this.activity.addSource(annotation.url, annotation.title);
	}
}

let activeActivity: HostedSearchActivity | undefined;
const indexedActivities = new Map<string, HostedSearchActivity>();

function responseKey(provider: string, model: string, responseId: string): string {
	return `${provider}\0${model}\0response:${responseId}`;
}

function timestampKey(provider: string, model: string, timestamp: number): string {
	return `${provider}\0${model}\0timestamp:${timestamp}`;
}

export function resetHostedSearchActivities(): void {
	activeActivity = undefined;
	indexedActivities.clear();
}

export function setActiveHostedSearchActivity(activity: HostedSearchActivity | undefined): void {
	activeActivity = activity;
}

export function indexHostedSearchActivity(activity: HostedSearchActivity): void {
	if (activity.responseId) {
		indexedActivities.set(responseKey(activity.provider, activity.model, activity.responseId), activity);
	}
	if (activity.assistantTimestamp !== undefined) {
		indexedActivities.set(timestampKey(activity.provider, activity.model, activity.assistantTimestamp), activity);
	}
}

export function hostedSearchActivityForMessage(message: HostedSearchMessage): HostedSearchActivity | undefined {
	if (activeActivity && activeActivity.provider === message.provider && activeActivity.model === message.model) {
		const sameResponse = Boolean(message.responseId && activeActivity.responseId === message.responseId);
		const sameTimestamp = message.timestamp !== undefined && activeActivity.assistantTimestamp === message.timestamp;
		if (sameResponse || sameTimestamp) return activeActivity;
	}
	return (message.responseId
		? indexedActivities.get(responseKey(message.provider, message.model, message.responseId))
		: undefined)
		?? (message.timestamp !== undefined
			? indexedActivities.get(timestampKey(message.provider, message.model, message.timestamp))
			: undefined);
}

export function restoreHostedSearchActivities(entries: readonly unknown[]): void {
	resetHostedSearchActivities();
	for (const entry of entries) {
		if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== HOSTED_SEARCH_ENTRY_TYPE) continue;
		const snapshot = parseHostedSearchSnapshot(entry["data"]);
		if (!snapshot) continue;
		const activity = HostedSearchActivity.restore(snapshot);
		indexHostedSearchActivity(activity);
	}
}

function parseHostedSearchSnapshot(value: unknown): HostedSearchSnapshot | undefined {
	if (!isRecord(value) || value["version"] !== HOSTED_SEARCH_ENTRY_VERSION) return undefined;
	const provider = cleanText(value["provider"], 256);
	const model = cleanText(value["model"], 256);
	const startedAt = value["startedAt"];
	const phase = value["phase"];
	if (!provider || !model || typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0) return undefined;
	if (phase !== "pending" && phase !== "running" && phase !== "completed" && phase !== "failed" && phase !== "cancelled") return undefined;
	if (!Array.isArray(value["calls"]) || !Array.isArray(value["sources"])) return undefined;

	const calls: HostedSearchCall[] = [];
	for (const raw of value["calls"].slice(0, MAX_CALLS)) {
		if (!isRecord(raw)) continue;
		const id = cleanText(raw["id"], 256);
		const status = cleanText(raw["status"], 64);
		const rawType = raw["type"];
		if (!id || !status) continue;
		const type: HostedSearchActionType = rawType === "search" || rawType === "open_page" || rawType === "find_in_page" ? rawType : "other";
		calls.push({ id, status, type, query: cleanText(raw["query"]), url: cleanUrl(raw["url"]) });
	}
	const sources: HostedSearchSource[] = [];
	for (const raw of value["sources"].slice(0, MAX_SOURCES)) {
		if (!isRecord(raw)) continue;
		const url = cleanUrl(raw["url"]);
		if (url) sources.push({ url, title: cleanText(raw["title"], 300) });
	}
	const responseId = cleanText(value["responseId"], 256);
	const assistantTimestamp = typeof value["assistantTimestamp"] === "number" && Number.isFinite(value["assistantTimestamp"])
		? value["assistantTimestamp"]
		: undefined;
	const endedAt = typeof value["endedAt"] === "number" && Number.isFinite(value["endedAt"])
		? value["endedAt"]
		: undefined;
	return {
		version: HOSTED_SEARCH_ENTRY_VERSION,
		responseId,
		assistantTimestamp,
		provider,
		model,
		phase,
		startedAt,
		endedAt,
		calls,
		sources,
		error: cleanText(value["error"]),
	};
}
