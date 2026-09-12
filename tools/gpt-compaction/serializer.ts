import { createHash } from "node:crypto";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";

/**
 * Local Responses-family serializer for synthetic compaction requests.
 *
 * Pi does not export its Responses converter, and the converter is model- and
 * provider-aware (developer vs system role, tool-call id normalization, phase
 * signatures). This mirrors the parts that matter for a same-model compaction
 * request: text, images, assistant phase signatures, reasoning signatures, tool
 * calls/results, and synthetic results for unpaired calls.
 *
 * Callers must pass Pi's own `convertToLlm()` output so custom message roles,
 * bash executions, and compaction/branch summaries are already flattened into
 * provider-visible messages.
 */

export const SYNTHETIC_TOOL_RESULT_TEXT = "No result provided";
const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

export type ResponsesInputContentItem =
	| { type: "input_text"; text: string }
	| { type: "input_image"; detail: "auto"; image_url: string };

export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeUserContent(content: UserMessage["content"]): Array<TextContent | ImageContent> {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function downgradeImages(content: Array<TextContent | ImageContent>, placeholder: string): Array<TextContent | ImageContent> {
	const result: Array<TextContent | ImageContent> = [];
	let previousWasPlaceholder = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
			previousWasPlaceholder = true;
			continue;
		}
		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}
	return result;
}

function serializeUserContentItem(item: TextContent | ImageContent, model: Model<Api>): ResponsesInputContentItem[] {
	if (item.type === "text") return [{ type: "input_text", text: sanitizeSurrogates(item.text) }];
	if (!model.input.includes("image")) return [];
	return [{
		type: "input_image",
		detail: "auto",
		image_url: `data:${item.mimeType};base64,${item.data}`,
	}];
}

function parseTextSignature(signature: string | undefined): { id?: string; phase?: "commentary" | "final_answer" } | undefined {
	if (!signature) return undefined;
	if (!signature.startsWith("{")) return { id: signature };
	try {
		const parsed = JSON.parse(signature) as unknown;
		if (!isRecord(parsed) || parsed["v"] !== 1 || typeof parsed["id"] !== "string") return undefined;
		const phase = parsed["phase"] === "commentary" || parsed["phase"] === "final_answer" ? parsed["phase"] : undefined;
		return { id: parsed["id"], ...(phase ? { phase } : {}) };
	} catch {
		return undefined;
	}
}

function normalizeAssistantMessageId(id: string | undefined, messageIndex: number): string {
	if (!id) return `msg_${messageIndex}`;
	if (id.length <= 64) return id;
	return `msg_${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;
}

function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall";
}

/**
 * Normalize the message list the same way Pi's Responses path does: drop
 * failed/aborted assistant messages, drop unsigned thinking, and append
 * synthetic tool results for calls that never produced one so the wire format
 * always keeps call/result pairing.
 */
export function transformMessagesForResponses(messages: readonly Message[], model: Model<Api>): Message[] {
	const transformed: Message[] = [];
	let pendingToolCalls = new Map<string, ToolCall>();

	const flushPending = () => {
		for (const toolCall of pendingToolCalls.values()) {
			transformed.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }],
				isError: true,
				timestamp: Date.now(),
			});
		}
		pendingToolCalls = new Map();
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			flushPending();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const content: AssistantMessage["content"] = [];
			for (const block of message.content) {
				if (block.type !== "thinking" || block.thinkingSignature) content.push(block);
			}
			transformed.push({ ...message, content });
			const toolCalls = content.filter(isToolCall);
			pendingToolCalls = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
			continue;
		}

		if (message.role === "toolResult") {
			if (!pendingToolCalls.has(message.toolCallId)) continue;
			const downgraded = model.input.includes("image")
				? message
				: { ...message, content: downgradeImages(message.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER) };
			transformed.push(downgraded);
			pendingToolCalls.delete(message.toolCallId);
			continue;
		}

		flushPending();
		if (message.role === "user" && !model.input.includes("image") && Array.isArray(message.content)) {
			transformed.push({ ...message, content: downgradeImages(message.content, NON_VISION_USER_IMAGE_PLACEHOLDER) });
			continue;
		}
		transformed.push(message);
	}

	flushPending();
	return transformed;
}

function serializeAssistantItems(message: AssistantMessage, messageIndex: number): unknown[] {
	const items: unknown[] = [];
	for (const block of message.content) {
		if (block.type === "thinking") {
			if (!block.thinkingSignature) continue;
			try {
				const parsed = JSON.parse(block.thinkingSignature) as unknown;
				if (isRecord(parsed)) items.push(parsed);
			} catch {
				// Ignore unparseable reasoning signatures; they are provider-internal.
			}
			continue;
		}
		if (block.type === "text") {
			const signature = parseTextSignature(block.textSignature);
			items.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
				status: "completed",
				id: normalizeAssistantMessageId(signature?.id, messageIndex),
				...(signature?.phase ? { phase: signature.phase } : {}),
			});
			continue;
		}
		const [callId, rawItemId] = block.id.split("|");
		items.push({
			type: "function_call",
			...(rawItemId ? { id: rawItemId } : {}),
			call_id: callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
		});
	}
	return items;
}

function serializeToolResultItem(message: ToolResultMessage, model: Model<Api>): unknown {
	const [callId] = message.toolCallId.split("|");
	const text = message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => sanitizeSurrogates(item.text))
		.join("\n");
	const hasImages = message.content.some((item) => item.type === "image");
	if (hasImages && model.input.includes("image")) {
		const output: ResponsesInputContentItem[] = [];
		if (text) output.push({ type: "input_text", text });
		for (const item of message.content) {
			if (item.type !== "image") continue;
			output.push({ type: "input_image", detail: "auto", image_url: `data:${item.mimeType};base64,${item.data}` });
		}
		return { type: "function_call_output", call_id: callId, output };
	}
	return { type: "function_call_output", call_id: callId, output: text || "(see attached image)" };
}

/**
 * Serialize conversation messages into Responses input items. System
 * instructions are passed separately as the request's top-level `instructions`
 * field, matching Codex's compaction input shape.
 */
export function serializeMessagesToResponsesInput(model: Model<Api>, messages: readonly Message[]): unknown[] {
	const input: unknown[] = [];
	let messageIndex = 0;
	for (const message of transformMessagesForResponses(messages, model)) {
		if (message.role === "user") {
			const content = normalizeUserContent(message.content)
				.flatMap((item) => serializeUserContentItem(item, model));
			if (content.length > 0) input.push({ role: "user", content });
			messageIndex += 1;
			continue;
		}
		if (message.role === "assistant") {
			input.push(...serializeAssistantItems(message, messageIndex));
			messageIndex += 1;
			continue;
		}
		if (message.role === "toolResult") {
			input.push(serializeToolResultItem(message, model));
			messageIndex += 1;
		}
	}
	return input;
}
