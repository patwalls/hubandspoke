import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { setLlmCallRecorder, type LlmUsage } from "./metered";
import {
  isBilledOpenAIUrl,
  meteredOpenAIFetch,
  modelFromRequestBody,
  usageFromOpenAIBody,
} from "./metered-openai";

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("usageFromOpenAIBody", () => {
  it("whisper-1 is billed by duration: records audio seconds, model from the request", () => {
    const body = { text: "hi", duration: 61.5, usage: { type: "duration", seconds: 62 } };
    expect(usageFromOpenAIBody(body, "whisper-1")).toEqual({
      model: "whisper-1",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      audioSeconds: 62,
    });
  });

  it("falls back to verbose_json's duration when usage is missing", () => {
    expect(usageFromOpenAIBody({ text: "hi", duration: 12.25 }, "whisper-1")?.audioSeconds).toBe(12.25);
  });

  it("token-billed transcription and image calls record input/output tokens", () => {
    const diarized = { segments: [], usage: { type: "tokens", input_tokens: 900, output_tokens: 120, total_tokens: 1020 } };
    expect(usageFromOpenAIBody(diarized, "gpt-4o-transcribe-diarize")).toMatchObject({
      model: "gpt-4o-transcribe-diarize",
      inputTokens: 900,
      outputTokens: 120,
    });
    const image = { data: [{}], usage: { input_tokens: 400, output_tokens: 6000, input_tokens_details: { image_tokens: 380 } } };
    expect(usageFromOpenAIBody(image, "gpt-image-2")).toMatchObject({ inputTokens: 400, outputTokens: 6000 });
  });

  it("reads Chat Completions' prompt/completion names and cached input; the response's model wins", () => {
    const chat = {
      model: "gpt-4o-mini-2024-07-18",
      usage: { prompt_tokens: 300, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 256 } },
    };
    expect(usageFromOpenAIBody(chat, "gpt-4o-mini")).toEqual({
      model: "gpt-4o-mini-2024-07-18",
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 256,
      cacheWriteTokens: 0,
    });
  });

  it("is null when there is nothing billable to read", () => {
    expect(usageFromOpenAIBody({ text: "hi" }, "gpt-4o-transcribe")).toBeNull();
    expect(usageFromOpenAIBody(null, "x")).toBeNull();
  });
});

describe("modelFromRequestBody", () => {
  it("reads the multipart field the SDK sends for audio and image uploads", () => {
    const form = new FormData();
    form.set("model", "whisper-1");
    expect(modelFromRequestBody(form)).toBe("whisper-1");
  });
  it("reads a JSON body, and is null for anything else", () => {
    expect(modelFromRequestBody(JSON.stringify({ model: "gpt-4o" }))).toBe("gpt-4o");
    expect(modelFromRequestBody("not json")).toBeNull();
    expect(modelFromRequestBody(undefined)).toBeNull();
  });
});

describe("isBilledOpenAIUrl", () => {
  it("bills the endpoints that cost money, not listings or file reads", () => {
    expect(isBilledOpenAIUrl("https://api.openai.com/v1/audio/transcriptions")).toBe(true);
    expect(isBilledOpenAIUrl("https://api.openai.com/v1/images/edits")).toBe(true);
    expect(isBilledOpenAIUrl("https://api.openai.com/v1/chat/completions")).toBe(true);
    expect(isBilledOpenAIUrl("https://api.openai.com/v1/models")).toBe(false);
    expect(isBilledOpenAIUrl("https://api.openai.com/v1/files/abc/content")).toBe(false);
  });
});

describe("meteredOpenAIFetch", () => {
  afterEach(() => setLlmCallRecorder(null));

  it("records under provider openai with the request's model and hands the caller an unread body", async () => {
    const calls: [string, string, LlmUsage][] = [];
    const body = { text: "hello", duration: 30 };
    const form = new FormData();
    form.set("model", "whisper-1");
    const f = meteredOpenAIFetch("jobs/whisper-pipeline", {
      fetchImpl: async () => json(body),
      record: async (...args) => {
        calls.push(args);
      },
    });
    const res = await f("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: form });
    expect(await res.json()).toEqual(body);
    await flush();
    expect(calls).toEqual([
      ["openai", "jobs/whisper-pipeline", expect.objectContaining({ model: "whisper-1", audioSeconds: 30 })],
    ]);
  });

  it("skips failed calls and plain-text transcripts; a recording failure never reaches the caller", async () => {
    const record = vi.fn(async () => {
      throw new Error("db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = "https://api.openai.com/v1/audio/transcriptions";
    const failed = meteredOpenAIFetch("x", { fetchImpl: async () => new Response("{}", { status: 500 }), record });
    expect((await failed(url)).status).toBe(500);
    const text = meteredOpenAIFetch("x", {
      fetchImpl: async () => new Response("just text", { headers: { "content-type": "text/plain" } }),
      record,
    });
    expect(await (await text(url)).text()).toBe("just text");
    await flush();
    expect(record).not.toHaveBeenCalled();

    const ok = meteredOpenAIFetch("x", { fetchImpl: async () => json({ duration: 5 }), record });
    expect((await ok(url)).status).toBe(200);
    await flush();
    expect(record).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses the recorder installed at boot when none is passed", async () => {
    const record = vi.fn(async () => {});
    setLlmCallRecorder(record);
    const f = meteredOpenAIFetch("x", { fetchImpl: async () => json({ duration: 5 }) });
    await f("https://api.openai.com/v1/audio/transcriptions");
    await flush();
    expect(record).toHaveBeenCalledWith("openai", "x", expect.objectContaining({ audioSeconds: 5 }));
  });
});

// Same browser-bundle rule as metered.ts (PR #194's first CI run).
describe("metered-openai.ts stays browser-safe", () => {
  it("imports nothing from the DB layer", () => {
    const src = readFileSync(join(__dirname, "metered-openai.ts"), "utf8");
    expect(src).not.toMatch(/["']@\/lib\/db|["']\.\/record|["']postgres["']/);
  });
});

// A bare client is a call nobody can see on the AI-spend page. Both SDKs are
// built only through the metered constructors.
describe("every model client in src is metered", () => {
  const SRC = join(__dirname, "..", "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === "node_modules" ? [] : files(p);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
    });

  it("has no bare new Anthropic() or new OpenAI() outside src/lib/llm", () => {
    const bare = files(SRC)
      .filter((p) => !p.includes(join("src", "lib", "llm")))
      // `new Anthropic()` in backticks is a doc comment, not a call.
      .filter((p) => /(?<!`)new (Anthropic|OpenAI)\s*\(/.test(readFileSync(p, "utf8")))
      .map((p) => relative(SRC, p));
    expect(bare).toEqual([]);
  });
});
