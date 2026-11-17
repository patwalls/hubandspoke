import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  setLlmCallRecorder,
  isBilledMessagesUrl,
  meteredFetch,
  usageFromMessageBody,
  usageFromMessageStream,
  type LlmUsage,
} from "./metered";

const body = {
  model: "claude-haiku-4-5-20251001",
  usage: {
    input_tokens: 1200,
    output_tokens: 80,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: null,
  },
};

describe("usageFromMessageBody", () => {
  it("reads tokens incl. cache, treating null as 0", () => {
    expect(usageFromMessageBody(body)).toEqual({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
  });
  it("is null for an error body or anything without usage", () => {
    expect(usageFromMessageBody({ type: "error", error: {} })).toBeNull();
    expect(usageFromMessageBody(null)).toBeNull();
  });
});

describe("usageFromMessageStream", () => {
  it("takes input from message_start and the final output from the last message_delta", () => {
    const sse = [
      "event: message_start",
      `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-4-1", usage: { input_tokens: 50, output_tokens: 1, cache_creation_input_tokens: 400 } } })}`,
      "",
      "event: content_block_delta",
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })}`,
      "",
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 30 } })}`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 75 } })}`,
      "data: not json",
    ].join("\n");
    expect(usageFromMessageStream(sse)).toEqual({
      model: "claude-opus-4-1",
      inputTokens: 50,
      outputTokens: 75,
      cacheReadTokens: 0,
      cacheWriteTokens: 400,
    });
  });
  it("is null when the stream never started a message", () => {
    expect(usageFromMessageStream("event: error\ndata: {\"type\":\"error\"}\n")).toBeNull();
  });
});

describe("isBilledMessagesUrl", () => {
  it("bills /v1/messages only", () => {
    expect(isBilledMessagesUrl("https://api.anthropic.com/v1/messages")).toBe(true);
    expect(isBilledMessagesUrl("https://api.anthropic.com/v1/messages?beta=true")).toBe(true);
    expect(isBilledMessagesUrl("https://api.anthropic.com/v1/messages/count_tokens")).toBe(false);
    expect(isBilledMessagesUrl("https://api.anthropic.com/v1/models")).toBe(false);
  });
});

describe("meteredFetch", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("records the call under its feature and hands the caller an unread body", async () => {
    const calls: [string, string, LlmUsage][] = [];
    const f = meteredFetch("why-it-won", {
      fetchImpl: async () =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      record: async (...args) => {
        calls.push(args);
      },
    });
    const res = await f("https://api.anthropic.com/v1/messages", { method: "POST" });
    expect(await res.json()).toEqual(body);
    await flush();
    expect(calls).toEqual([["anthropic", "why-it-won", expect.objectContaining({ inputTokens: 1200 })]]);
  });

  it("records nothing for a failed call, and a recording failure never reaches the caller", async () => {
    const record = vi.fn(async () => {
      throw new Error("db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = meteredFetch("x", {
      fetchImpl: async () => new Response("{}", { status: 529 }),
      record,
    });
    expect((await failing("https://api.anthropic.com/v1/messages")).status).toBe(529);
    expect(record).not.toHaveBeenCalled();

    const ok = meteredFetch("x", {
      fetchImpl: async () => new Response(JSON.stringify(body)),
      record,
    });
    expect((await ok("https://api.anthropic.com/v1/messages")).status).toBe(200);
    await flush();
    expect(record).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the installed recorder", () => {
  afterEach(() => setLlmCallRecorder(null));
  const anthropic = async () => new Response(JSON.stringify(body));

  it("records nothing until a server process installs one, then uses it", async () => {
    const record = vi.fn(async () => {});
    const f = meteredFetch("x", { fetchImpl: anthropic });
    await f("https://api.anthropic.com/v1/messages");
    await new Promise((r) => setTimeout(r, 0));
    expect(record).not.toHaveBeenCalled();

    setLlmCallRecorder(record);
    await f("https://api.anthropic.com/v1/messages");
    await new Promise((r) => setTimeout(r, 0));
    expect(record).toHaveBeenCalledWith("anthropic", "x", expect.objectContaining({ outputTokens: 80 }));
  });
});

// Regression (PR #194's first CI run): client components import pure helpers
// from services that build a metered client, so metered.ts lands in browser
// bundles — any DB import here (even a lazy one) breaks `next build` with
// "Can't resolve 'tls'". The DB writer lives in record.ts.
describe("metered.ts stays browser-safe", () => {
  it("imports nothing from the DB layer", () => {
    const src = readFileSync(join(__dirname, "metered.ts"), "utf8");
    expect(src).not.toMatch(/["']@\/lib\/db|["']\.\/record|["']postgres["']/);
  });
});
