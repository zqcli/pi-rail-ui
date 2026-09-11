import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const modelUsage = {
  input: 199,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function streamLocalResponse(model, _context, options) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "offline local provider response" }],
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage: modelUsage,
    stopReason: options?.signal?.aborted ? "aborted" : "stop",
    ...(options?.signal?.aborted ? { errorMessage: "aborted" } : {}),
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
  return stream;
}

export default function (pi) {
  pi.registerProvider("rail-stage1-local", {
    name: "Rail stage 1 local provider",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "rail-stage1-local-key",
    api: "openai-completions",
    streamSimple: streamLocalResponse,
    models: [{
      id: "offline-model",
      name: "Rail stage 1 offline model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100,
      maxTokens: 32,
    }],
  });

  pi.on("session_before_compact", async (event) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      compaction: {
        summary: "STAGE1 PRIVATE COMPACTION SUMMARY",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  pi.registerCommand("manual-only", {
    description: "Start manual compaction without an agent run",
    handler: async (_args, ctx) => {
      await new Promise((resolve, reject) => {
        ctx.compact({
          customInstructions: "stage 1 manual smoke",
          onComplete: resolve,
          onError: reject,
        });
      });
    },
  });
}
