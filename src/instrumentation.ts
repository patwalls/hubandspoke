import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    // Every Anthropic call made by a route records its tokens (llm_calls).
    const { installLlmCallRecorder } = await import("./lib/llm/record");
    installLlmCallRecorder();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
