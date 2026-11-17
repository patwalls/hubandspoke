/**
 * Metered model clients: every call records which feature made it, the model
 * and its tokens in `llm_calls`, so "what did AI cost, and which feature" is a
 * query instead of a dig through billing emails.
 *
 * Use `meteredAnthropic("<feature>")` wherever you would write
 * `new Anthropic()`. It is a plain Anthropic client with a custom `fetch`
 * that, after each Messages API response, reads the `usage` block — from the
 * JSON body, or from the `message_start` / `message_delta` events of a stream —
 * and writes one row. The caller's response is untouched: we read a clone.
 *
 * Recording never throws and never blocks the caller: a failed insert is
 * logged and dropped. Nothing is recorded until a server process installs the
 * writer (`installLlmCallRecorder()` in ./record.ts). Dollars are NOT stored; they are computed at read time
 * from a price table so a price change never rewrites history.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Usage from a non-streaming Messages API JSON body; null when it has none. */
export function usageFromMessageBody(body: unknown): LlmUsage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { model?: unknown; usage?: RawUsage };
  if (!b.usage || typeof b.model !== "string") return null;
  return {
    model: b.model,
    inputTokens: n(b.usage.input_tokens),
    outputTokens: n(b.usage.output_tokens),
    cacheReadTokens: n(b.usage.cache_read_input_tokens),
    cacheWriteTokens: n(b.usage.cache_creation_input_tokens),
  };
}

/**
 * Usage from a Messages API SSE stream. `message_start` carries the model and
 * the input side; each `message_delta` carries the running output total (and,
 * on newer API versions, may restate input/cache counts) — the last one wins.
 */
export function usageFromMessageStream(sse: string): LlmUsage | null {
  let usage: LlmUsage | null = null;
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let evt: { type?: string; message?: unknown; usage?: RawUsage };
    try {
      evt = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (evt.type === "message_start") {
      usage = usageFromMessageBody(evt.message);
    } else if (evt.type === "message_delta" && usage && evt.usage) {
      const u = evt.usage;
      usage.outputTokens = n(u.output_tokens) || usage.outputTokens;
      if (u.input_tokens != null) usage.inputTokens = n(u.input_tokens);
      if (u.cache_read_input_tokens != null) usage.cacheReadTokens = n(u.cache_read_input_tokens);
      if (u.cache_creation_input_tokens != null) usage.cacheWriteTokens = n(u.cache_creation_input_tokens);
    }
  }
  return usage;
}

/** Only the Messages endpoint bills tokens (`/v1/messages`, not `/count_tokens`). */
export function isBilledMessagesUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/v1/messages");
  } catch {
    return false;
  }
}

export type RecordFn = (provider: string, feature: string, usage: LlmUsage) => Promise<void>;

// The DB writer lives in ./record.ts (server-only) and is installed at boot by
// src/instrumentation.ts (web) and src/jobs/worker.ts (worker). This module
// must stay free of DB imports: client components import pure helpers from
// services that build a metered client, so it ends up in browser bundles.
// Kept on globalThis because Next bundles instrumentation separately from
// routes — a module-level variable would not be shared between them.
const RECORDER_KEY = Symbol.for("hubandspoke.llmCallRecorder");
type WithRecorder = typeof globalThis & { [RECORDER_KEY]?: RecordFn };

export function setLlmCallRecorder(fn: RecordFn | null): void {
  (globalThis as WithRecorder)[RECORDER_KEY] = fn ?? undefined;
}

function installedRecorder(): RecordFn | undefined {
  return (globalThis as WithRecorder)[RECORDER_KEY];
}

/** A `fetch` that records the usage of every billed Messages response. Exported for tests. */
export function meteredFetch(
  feature: string,
  opts: { record?: RecordFn; fetchImpl?: typeof fetch } = {},
): typeof fetch {
  return async (input, init) => {
    const res = await (opts.fetchImpl ?? globalThis.fetch)(input, init);
    const record = opts.record ?? installedRecorder();
    if (!record) return res; // no recorder installed (scripts, tests, browser)
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!res.ok || !isBilledMessagesUrl(url)) return res;
    const copy = res.clone();
    const isStream = (res.headers.get("content-type") ?? "").includes("text/event-stream");
    void (async () => {
      const usage = isStream
        ? usageFromMessageStream(await copy.text())
        : usageFromMessageBody(await copy.json());
      if (usage) await record("anthropic", feature, usage);
    })().catch((err) => {
      console.warn(`[llm-metered] could not record ${feature}: ${err instanceof Error ? err.message : err}`);
    });
    return res;
  };
}

/** `new Anthropic()`, but every call is recorded under `feature` in `llm_calls`. */
export function meteredAnthropic(feature: string): Anthropic {
  return new Anthropic({ fetch: meteredFetch(feature) });
}
