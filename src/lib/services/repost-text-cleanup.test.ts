import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { stripDateOpenerWithLLM } from "./repost-text-cleanup";

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
              name: response.toolName ?? "return_body",
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

describe("stripDateOpenerWithLLM", () => {
  it("returns the cleaned body when the LLM removed the opener", async () => {
    const original =
      "8 years ago today:\n\nI woke up at 6AM and dragged myself to Starbucks on 17th and 8th.";
    const cleaned =
      "I woke up at 6AM and dragged myself to Starbucks on 17th and 8th.";
    const fake = fakeClient({ toolInput: { body: cleaned } });
    const result = await stripDateOpenerWithLLM(original, {
      client: fake.client,
    });
    expect(result).toBe(cleaned);
    expect(fake.calls).toBe(1);
  });

  it("returns the input unchanged when the LLM detected no opener", async () => {
    const original =
      "Today is the start of something new — here's what we're building.";
    const fake = fakeClient({ toolInput: { body: original } });
    const result = await stripDateOpenerWithLLM(original, {
      client: fake.client,
    });
    expect(result).toBe(original);
  });

  it("skips the LLM call entirely on null input", async () => {
    const fake = fakeClient({ toolInput: { body: "shouldn't be called" } });
    const result = await stripDateOpenerWithLLM(null, { client: fake.client });
    expect(result).toBeNull();
    expect(fake.calls).toBe(0);
  });

  it("skips the LLM call on whitespace-only input", async () => {
    const fake = fakeClient({ toolInput: { body: "shouldn't be called" } });
    const result = await stripDateOpenerWithLLM("   \n  ", {
      client: fake.client,
    });
    expect(result).toBe("   \n  ");
    expect(fake.calls).toBe(0);
  });

  it("skips the LLM call on very short input (can't contain an opener+body)", async () => {
    const fake = fakeClient({ toolInput: { body: "shouldn't be called" } });
    const result = await stripDateOpenerWithLLM("Hi.", {
      client: fake.client,
    });
    expect(result).toBe("Hi.");
    expect(fake.calls).toBe(0);
  });

  it("fails soft when the LLM throws — returns the original body", async () => {
    const original =
      "8 years ago today:\n\nI woke up at 6AM and dragged myself to a Starbucks.";
    const fake = fakeClient({ throws: new Error("boom") });
    const result = await stripDateOpenerWithLLM(original, {
      client: fake.client,
    });
    expect(result).toBe(original);
  });

  it("fails soft when the tool returns an empty body — returns the original", async () => {
    const original =
      "8 years ago today:\n\nI woke up at 6AM and dragged myself to a Starbucks.";
    const fake = fakeClient({ toolInput: { body: "   " } });
    const result = await stripDateOpenerWithLLM(original, {
      client: fake.client,
    });
    expect(result).toBe(original);
  });

  it("fails soft when no tool_use block is returned — returns the original", async () => {
    const original =
      "8 years ago today:\n\nI woke up at 6AM and dragged myself to a Starbucks.";
    const fake = fakeClient({
      contentOverride: [
        { type: "text", text: "I forgot to use the tool" } as unknown as Anthropic.ContentBlock,
      ],
    });
    const result = await stripDateOpenerWithLLM(original, {
      client: fake.client,
    });
    expect(result).toBe(original);
  });
});
