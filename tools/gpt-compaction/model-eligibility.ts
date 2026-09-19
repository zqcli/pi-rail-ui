import type { Api, Model } from "@earendil-works/pi-ai";
import { isGptModel } from "../../openai/model-eligibility";

/**
 * Remote compaction v2 speaks the plain `/responses` stream with a
 * `compaction_trigger` input item. Only the Responses-family APIs that Pi
 * implements can carry it.
 */
export const RESPONSES_COMPACTION_APIS = [
	"openai-responses",
	"openai-codex-responses",
] as const;
export type ResponsesCompactionApi = (typeof RESPONSES_COMPACTION_APIS)[number];

export type RemoteCompactionUnsupportedReason =
	| "missing-model"
	| "unsupported-api"
	| "not-gpt-model"
	| "missing-base-url";

export type RemoteCompactionSupport =
	| { supported: true }
	| { supported: false; reason: RemoteCompactionUnsupportedReason; detail: string };

export interface CompactionModelDescriptor {
	provider: string;
	api: string;
	id: string;
	baseUrl: string;
	name?: string;
}

export function isResponsesCompactionApi(api: string): api is ResponsesCompactionApi {
	return (RESPONSES_COMPACTION_APIS as readonly string[]).includes(api);
}

export function describeCompactionModel(model: Model<Api>): CompactionModelDescriptor {
	return {
		provider: model.provider,
		api: model.api,
		id: model.id,
		baseUrl: model.baseUrl,
		...(model.name ? { name: model.name } : {}),
	};
}

export function modelSupportsRemoteCompaction(model: Model<Api> | undefined): RemoteCompactionSupport {
	if (!model) {
		return { supported: false, reason: "missing-model", detail: "no active model" };
	}
	if (!isResponsesCompactionApi(model.api)) {
		return { supported: false, reason: "unsupported-api", detail: `${model.provider}/${model.id} uses ${model.api}` };
	}
	// GPT matching is provider-independent; non-GPT Responses models must stay
	// on Pi's native compaction.
	if (!isGptModel(model)) {
		return { supported: false, reason: "not-gpt-model", detail: `${model.provider}/${model.id} is not a GPT model` };
	}
	return { supported: true };
}

/** Runtime identity used for checkpoint compatibility checks. */
export interface CompactionIdentity {
	provider: string;
	api: string;
	model: string;
	baseUrl: string;
	/** Stable, non-secret credential/account scope hash. */
	authFingerprint?: string;
}

export function compactionIdentity(model: Model<Api>): CompactionIdentity {
	return {
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: normalizeBaseUrl(model.baseUrl),
	};
}

export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/u, "");
}

/**
 * Checkpoint replay is only safe on the exact endpoint/account/model that
 * produced it. baseUrl is compared as part of a full identity match, never on
 * its own: the same gateway can front different accounts, and the same model
 * can be served by a different gateway.
 */
export function identitiesMatch(left: CompactionIdentity, right: CompactionIdentity): boolean {
	return left.provider === right.provider
		&& left.api === right.api
		&& left.model === right.model
		&& normalizeBaseUrl(left.baseUrl) === normalizeBaseUrl(right.baseUrl)
		&& (left.authFingerprint === undefined && right.authFingerprint === undefined
			|| left.authFingerprint !== undefined
			&& right.authFingerprint !== undefined
			&& left.authFingerprint === right.authFingerprint);
}

/** Same model endpoint comparison used for ephemeral request-option caches. */
export function requestIdentitiesMatch(left: CompactionIdentity, right: CompactionIdentity): boolean {
	return left.provider === right.provider
		&& left.api === right.api
		&& left.model === right.model
		&& normalizeBaseUrl(left.baseUrl) === normalizeBaseUrl(right.baseUrl);
}
