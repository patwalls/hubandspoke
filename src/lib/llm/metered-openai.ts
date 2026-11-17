/**
 * OpenAI half of metered.ts: `meteredOpenAI("<feature>")` is `new OpenAI()`
 * whose every billed call (transcriptions, image edits/generations, chat,
 * responses) records one `llm_calls` row under `provider = "openai"`.
 *
 * OpenAI bills these calls differently, so the row says what was billed:
 * - token models (gpt-4o-transcribe*, gpt-image-*, chat/responses) → input /
 *   output tokens (cached input → cacheReadTokens);
 * - whisper-1 → `audioSeconds` (usage `{ type: "duration", seconds }`, or the
 *   verbose_json `duration` when usage is missing).
 *
 * Transcription and image responses don't name their model, so it is read
 * from the request (multipart `model` field or JSON body). Same guarantees as
 * the Anthropic side: the caller gets the untouched response, recording reads
 * a clone, never throws, and is a no-op until a server process installs the
 * writer. Like metered.ts this module must stay free of DB imports.
 */
import OpenAI from "openai";
import { installedRecorder, type LlmUsage, type RecordFn } from "./metered";

const BILLED_PATHS = [
  "/v1/audio/transcriptions",
  "/v1/audio/translations",
  "/v1/images/edits",
  "/v1/images/generations",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/embeddings",
];

/** The OpenAI endpoints that bill per call. */
export function isBilledOpenAIUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return BILLED_PATHS.some((p) => path.endsWith(p));
  } catch {
    return false;
  }
}

/** The `model` a request asked for — multipart form field or JSON body. */
export function modelFromRequestBody(body: unknown): string | null {
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const m = body.get("model");
    return typeof m === "string" ? m : null;
  }
  if (typeof body === "string") {
    try {
      const m = (JSON.parse(body) as { model?: unknown }).model;
      return typeof m === "string" ? m : null;
    } catch {
      return null;
    }
  }
  return null;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

type OpenAIUsage = {
  type?: string;
  seconds?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
};

/**
 * Usage from an OpenAI JSON response; null when it has nothing billable to
 * record (no usage and no duration). `requestModel` fills in for responses
 * that don't name their model.
 */
export function usageFromOpenAIBody(body: unknown, requestModel: string | null): LlmUsage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { model?: unknown; usage?: OpenAIUsage; duration?: unknown };
  const model = typeof b.model === "string" ? b.model : requestModel ?? "unknown";
  const u = b.usage;
  if (u?.type === "duration" || (!u && typeof b.duration === "number")) {
    const seconds = u?.type === "duration" ? n(u.seconds) : n(b.duration);
    return { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, audioSeconds: seconds };
  }
  if (!u) return null;
  return {
    model,
    // Chat Completions says prompt/completion; everything newer says input/output.
    inputTokens: n(u.input_tokens ?? u.prompt_tokens),
    outputTokens: n(u.output_tokens ?? u.completion_tokens),
    cacheReadTokens: n(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: 0,
  };
}

/** A `fetch` that records the usage of every billed OpenAI JSON response. Exported for tests. */
export function meteredOpenAIFetch(
  feature: string,
  opts: { record?: RecordFn; fetchImpl?: typeof fetch } = {},
): typeof fetch {
  return async (input, init) => {
    const res = await (opts.fetchImpl ?? globalThis.fetch)(input, init);
    const record = opts.record ?? installedRecorder();
    if (!record) return res;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!res.ok || !isBilledOpenAIUrl(url)) return res;
    // text / srt / vtt transcripts carry no usage block — nothing to read.
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
    const requestModel = modelFromRequestBody(init?.body);
    const copy = res.clone();
    void (async () => {
      const usage = usageFromOpenAIBody(await copy.json(), requestModel);
      if (usage) await record("openai", feature, usage);
    })().catch((err) => {
      console.warn(`[llm-metered] could not record ${feature}: ${err instanceof Error ? err.message : err}`);
    });
    return res;
  };
}

/** `new OpenAI()`, but every billed call is recorded under `feature` in `llm_calls`. */
export function meteredOpenAI(feature: string): OpenAI {
  return new OpenAI({ fetch: meteredOpenAIFetch(feature) });
}
