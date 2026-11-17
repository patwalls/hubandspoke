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
 * logged and dropped. Dollars are NOT stored; they are computed at read time
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

async function recordLlmCall(provider: string, feature: string, usage: LlmUsage): Promise<void> {
  // Imported lazily so modules that build a client (and their unit tests)
  // don't open a DB connection just by being imported.
  const [{ db }, { llmCalls }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/db/schema"),
  ]);
  await db.insert(llmCalls).values({ provider, feature, ...usage });
}

type RecordFn = (provider: string, feature: string, usage: LlmUsage) => Promise<void>;

/** A `fetch` that records the usage of every billed Messages response. Exported for tests. */
export function meteredFetch(
  feature: string,
  opts: { record?: RecordFn; fetchImpl?: typeof fetch } = {},
): typeof fetch {
  const record = opts.record ?? recordLlmCall;
  return async (input, init) => {
    const res = await (opts.fetchImpl ?? globalThis.fetch)(input, init);
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
