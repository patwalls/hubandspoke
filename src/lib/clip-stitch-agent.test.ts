import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildStitchUserMessage, suggestSupportingQuotes } from "./clip-stitch-agent";

const section = { startSec: 125, endSec: 170, topic: "Cold email", summary: null, anchorQuote: "we emailed every agency" };

function fakeClient(impl: () => Promise<unknown>): Anthropic {
  return { messages: { create: impl } } as unknown as Anthropic;
}

describe("buildStitchUserMessage", () => {
  it("names the section window so the model can stay outside it", () => {
    const msg = buildStitchUserMessage({ title: "Pillar", section, transcriptMarkdown: "[00:01] hello" });
    expect(msg).toContain("[02:05]–[02:50] (125s–170s)");
    expect(msg).toContain("Topic: Cold email");
    expect(msg).not.toContain("Summary:");
    expect(msg).toContain("[00:01] hello");
  });
});

describe("suggestSupportingQuotes", () => {
  it("returns the tool's quotes untouched (located by the caller)", async () => {
    const quotes = [{ quote: "a b c d e f", role: "setup", why: "w" }];
    const r = await suggestSupportingQuotes({
      title: null,
      section,
      transcriptMarkdown: "",
      client: fakeClient(async () => ({
        content: [{ type: "tool_use", name: "suggest_supporting_quotes", input: { supportingQuotes: quotes } }],
      })),
    });
    expect(r).toEqual({ ok: true, quotes });
  });

  it("fails soft on an API error and on a missing tool call", async () => {
    const err = await suggestSupportingQuotes({
      title: null, section, transcriptMarkdown: "",
      client: fakeClient(async () => { throw new Error("overloaded"); }),
    });
    expect(err).toEqual({ ok: false, failure: { reason: "llm-error", message: "overloaded" } });
    const none = await suggestSupportingQuotes({
      title: null, section, transcriptMarkdown: "",
      client: fakeClient(async () => ({ content: [{ type: "text", text: "hi" }] })),
    });
    expect(none).toEqual({ ok: false, failure: { reason: "no-tool-call" } });
  });
});
