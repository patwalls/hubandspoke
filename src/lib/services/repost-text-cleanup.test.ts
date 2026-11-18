import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  clearDateOpenerMemo,
  removeOpenerLine,
  stripDateOpenerWithLLM,
} from "./repost-text-cleanup";

// Build a minimal stub of the Anthropic client whose `messages.create`
// returns the response shape we care about (a single `tool_use` block).
function fakeClient(response: {
  toolName?: string;
  toolInput?: unknown;
  throws?: Error;
  contentOverride?: Anthropic.ContentBlock[];
}): { client: Anthropic; calls: number } {
  let calls = 0;
  const client = {
    messages: {
      create: vi.fn(async () => {
        calls += 1;
        if (response.throws) throw response.throws;
        const content: Anthropic.ContentBlock[] =
          response.contentOverride ?? [
            {
              type: "tool_use",
              id: "tool_test",
              name: response.toolName ?? "return_opener",
              input: response.toolInput ?? {},
            } as unknown as Anthropic.ContentBlock,
          ];
        return { content } as unknown as Anthropic.Message;
      }),
    },
  } as unknown as Anthropic;
  return {
    client,
    get calls() {
      return calls;
    },
  } as { client: Anthropic; calls: number };
}

const OPENER_POST =
  "8 years ago today:\n\nI woke up at 6AM and dragged myself to Starbucks on 17th and 8th.";
const OPENER_CLEANED =
  "I woke up at 6AM and dragged myself to Starbucks on 17th and 8th.";

describe("removeOpenerLine", () => {
  it("removes the first line and the blank lines after it", () => {
    expect(removeOpenerLine(OPENER_POST, "8 years ago today:")).toBe(OPENER_CLEANED);
  });

  it("matches the opener with surrounding whitespace trimmed, keeps CRLF", () => {
    expect(
      removeOpenerLine("  8 years ago today: \r\n\r\nLine one\r\nLine two", "8 years ago today:"),
    ).toBe("Line one\r\nLine two");
  });

  it("changes nothing when the body does not start with that line", () => {
    const body = "Something else first.\n8 years ago today:\nmore";
    expect(removeOpenerLine(body, "8 years ago today:")).toBe(body);
  });

  it("changes nothing when the opener is only the start of the first line", () => {
    const body = "8 years ago today I learned the lesson of my career.\nMore.";
    expect(removeOpenerLine(body, "8 years ago today")).toBe(body);
  });

  it("never empties the body (opener with nothing after it)", () => {
    expect(removeOpenerLine("Last year:\n\n", "Last year:")).toBe("Last year:\n\n");
  });

  it("changes nothing for an empty opener", () => {
    expect(removeOpenerLine(OPENER_POST, "  ")).toBe(OPENER_POST);
  });
});

describe("stripDateOpenerWithLLM", () => {
  beforeEach(() => clearDateOpenerMemo());

  it("removes the opener the model named", async () => {
    const fake = fakeClient({ toolInput: { opener: "8 years ago today:" } });
    const result = await stripDateOpenerWithLLM(OPENER_POST, { client: fake.client });
    expect(result).toBe(OPENER_CLEANED);
    expect(fake.calls).toBe(1);
  });

  it("returns the input unchanged when the model found no opener", async () => {
    const original =
      "Today is the start of something new — here's what we're building.";
    const fake = fakeClient({ toolInput: { opener: "" } });
    expect(await stripDateOpenerWithLLM(original, { client: fake.client })).toBe(original);
  });

  it("ignores a model answer that is not the body's first line (no rewriting)", async () => {
    const fake = fakeClient({ toolInput: { opener: "I woke up at 6AM" } });
    expect(await stripDateOpenerWithLLM(OPENER_POST, { client: fake.client })).toBe(
      OPENER_POST,
    );
  });

  it("asks once per body: the next cross-post of the same caption skips the call", async () => {
    const fake = fakeClient({ toolInput: { opener: "8 years ago today:" } });
    await stripDateOpenerWithLLM(OPENER_POST, { client: fake.client });
    const again = await stripDateOpenerWithLLM(OPENER_POST, { client: fake.client });
    expect(again).toBe(OPENER_CLEANED);
    expect(fake.calls).toBe(1);
  });

  it("does not remember a failure — the next call asks again", async () => {
    const failing = fakeClient({ throws: new Error("boom") });
    expect(await stripDateOpenerWithLLM(OPENER_POST, { client: failing.client })).toBe(
      OPENER_POST,
    );
    const ok = fakeClient({ toolInput: { opener: "8 years ago today:" } });
    expect(await stripDateOpenerWithLLM(OPENER_POST, { client: ok.client })).toBe(
      OPENER_CLEANED,
    );
    expect(ok.calls).toBe(1);
  });

  it("skips the LLM call entirely on null input", async () => {
    const fake = fakeClient({ toolInput: { opener: "x" } });
    expect(await stripDateOpenerWithLLM(null, { client: fake.client })).toBeNull();
    expect(fake.calls).toBe(0);
  });

  it("skips the LLM call on whitespace-only input", async () => {
    const fake = fakeClient({ toolInput: { opener: "x" } });
    expect(await stripDateOpenerWithLLM("   \n  ", { client: fake.client })).toBe("   \n  ");
    expect(fake.calls).toBe(0);
  });

  it("skips the LLM call on very short input (can't contain an opener+body)", async () => {
    const fake = fakeClient({ toolInput: { opener: "x" } });
    expect(await stripDateOpenerWithLLM("Hi.", { client: fake.client })).toBe("Hi.");
    expect(fake.calls).toBe(0);
  });

  it("fails soft when the tool input has no opener string", async () => {
    const fake = fakeClient({ toolInput: { body: "old shape" } });
    expect(await stripDateOpenerWithLLM(OPENER_POST, { client: fake.client })).toBe(
      OPENER_POST,
    );
  });

  it("fails soft when no tool_use block is returned — returns the original", async () => {
    const fake = fakeClient({
      contentOverride: [
        { type: "text", text: "I forgot to use the tool" } as unknown as Anthropic.ContentBlock,
      ],
    });
    expect(await stripDateOpenerWithLLM(OPENER_POST, { client: fake.client })).toBe(
      OPENER_POST,
    );
  });

  // The cross-post click waits on this call (POST /cross-post p50 ≈ 1.3 s,
  // p95 in the 14 s bucket, 2026-11-18). These keep it bounded.
  it("skips the LLM when the caption has no line break (no standalone opener line can exist)", async () => {
    const fake = fakeClient({ toolInput: { opener: "x" } });
    const oneLine = "8 years ago today I learned the most important lesson of my career.";
    expect(await stripDateOpenerWithLLM(oneLine, { client: fake.client })).toBe(oneLine);
    expect(fake.calls).toBe(0);
  });

  it("parallel cross-posts of one caption share a single model call", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const create = vi.fn(async () => {
      await gate;
      return {
        content: [
          {
            type: "tool_use",
            id: "t",
            name: "return_opener",
            input: { opener: "8 years ago today:" },
          },
        ],
      } as unknown as Anthropic.Message;
    });
    const client = { messages: { create } } as unknown as Anthropic;
    const all = Promise.all(
      [1, 2, 3, 4].map(() => stripDateOpenerWithLLM(OPENER_POST, { client })),
    );
    release();
    expect(await all).toEqual([OPENER_CLEANED, OPENER_CLEANED, OPENER_CLEANED, OPENER_CLEANED]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("bounds the call: a short timeout and no retries, so a slow model never holds the click", async () => {
    const fake = fakeClient({ toolInput: { opener: "" } });
    await stripDateOpenerWithLLM(OPENER_POST, { client: fake.client });
    const create = fake.client.messages.create as unknown as ReturnType<typeof vi.fn>;
    const reqOpts = create.mock.calls[0][1] as { timeout?: number; maxRetries?: number };
    expect(reqOpts.maxRetries).toBe(0);
    expect(reqOpts.timeout).toBeLessThanOrEqual(4_000);
  });
});
