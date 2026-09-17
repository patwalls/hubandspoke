import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { detectFillerWords } from "./detect-fillers";
import type { EditorWord } from "@/lib/clip-editor/words";

// Transcript indexes deliberately sparse + offset: the model sees positions
// 1..n and the service must map them back to EditorWord.index.
const words: EditorWord[] = ["so", "um", "this", "works"].map((text, i) => ({
  index: 500 + i * 3, text, startSec: i, endSec: i + 0.5,
}));

function clientReturning(content: unknown[]): Anthropic {
  return { messages: { create: vi.fn().mockResolvedValue({ content }) } } as unknown as Anthropic;
}

describe("detectFillerWords", () => {
  it("maps 1-based positions back to transcript word indexes", async () => {
    const client = clientReturning([
      { type: "tool_use", name: "report_fillers", input: { fillerWordNumbers: [2, 1] } },
    ]);
    const result = await detectFillerWords({ words, client });
    expect(result).toEqual({ ok: true, fillerIndexes: [500, 503] });
    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toContain("2: um");
    expect(call.tool_choice).toEqual({ type: "tool", name: "report_fillers" });
  });

  it("drops out-of-range, duplicate and non-integer positions instead of trusting them", async () => {
    const client = clientReturning([
      { type: "tool_use", name: "report_fillers", input: { fillerWordNumbers: [2, 2, 0, 99, 1.5, "3", -1] } },
    ]);
    expect(await detectFillerWords({ words, client })).toEqual({ ok: true, fillerIndexes: [503] });
  });

  it("treats an empty list as success, not failure", async () => {
    const client = clientReturning([
      { type: "tool_use", name: "report_fillers", input: { fillerWordNumbers: [] } },
    ]);
    expect(await detectFillerWords({ words, client })).toEqual({ ok: true, fillerIndexes: [] });
  });

  it("fails soft when the model answers in text or the call throws", async () => {
    expect(await detectFillerWords({ words, client: clientReturning([{ type: "text", text: "none" }]) }))
      .toEqual({ ok: false, failure: { reason: "llm-no-tool-call" } });
    const throwing = { messages: { create: vi.fn().mockRejectedValue(new Error("boom")) } } as unknown as Anthropic;
    const failed = await detectFillerWords({ words, client: throwing });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.failure).toMatchObject({ reason: "llm-error", message: "boom" });
  });

  it("does not call the model with nothing to classify", async () => {
    const client = clientReturning([]);
    expect(await detectFillerWords({ words: [], client })).toEqual({ ok: false, failure: { reason: "no-words" } });
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});
