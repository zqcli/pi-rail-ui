import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const record = (value) => appendFileSync(join(process.cwd(), "retry-events.jsonl"), `${JSON.stringify(value)}\n`);
const markerPath = () => join(process.cwd(), "append-marker.txt");
const completed = "APPEND_RESULT: completed side effect";

function streamLocal(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const requestsPath = join(process.cwd(), "provider-requests.jsonl");
  const previousRequests = existsSync(requestsPath) ? readFileSync(requestsPath, "utf8").trim().split("\n").length : 0;
  const toolResults = context.messages.filter((message) => message.role === "toolResult");
  const hasResult = toolResults.some((message) => message.toolName === "retry_append" && message.content.some((part) => part.type === "text" && part.text === completed));
  appendFileSync(requestsPath, `${JSON.stringify({ hasResult, contextWindow: model.contextWindow, messages: context.messages })}\n`);
  const message = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16, cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 } },
    stopReason: "pending", timestamp: Date.now(),
  };
  if (options?.signal?.aborted) {
    message.stopReason = "aborted";
    message.errorMessage = "aborted";
  } else if (previousRequests === 0) {
    message.stopReason = "toolUse";
    message.content = [{ type: "toolCall", id: "append-once", name: "retry_append", arguments: {} }];
  } else if (!hasResult) {
    message.stopReason = "error";
    message.errorMessage = "400 recorded tool result missing from continuation";
  } else if (previousRequests === 1) {
    message.stopReason = "error";
    message.errorMessage = "503 temporary local provider failure";
  } else {
    message.stopReason = "stop";
    message.content = [{ type: "text", text: "continued with recorded tool result" }];
  }
  stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
  if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
  else stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
  return stream;
}

export default function (pi) {
  pi.registerProvider("rail-retry-local", {
    name: "Rail retry local provider", baseUrl: "http://127.0.0.1:9/v1", apiKey: "local-test-only",
    api: "openai-completions", streamSimple: streamLocal,
    models: [{ id: "offline-retry", name: "Offline retry", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  });
  pi.registerTool({
    name: "retry_append", label: "Append once", description: "Append a marker once and return its recorded result", parameters: Type.Object({}),
    async execute() {
      appendFileSync(markerPath(), "completed\n");
      record({ type: "side_effect" });
      return { content: [{ type: "text", text: completed }], details: {} };
    },
  });
  pi.on("session_start", (_event, ctx) => record({ type: "session_start", session: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId() }));
  pi.on("before_agent_start", (event) => record({ type: "prompt", prompt: event.prompt }));
  for (const type of ["agent_start", "agent_end", "agent_settled"]) pi.on(type, () => record({ type }));
}
