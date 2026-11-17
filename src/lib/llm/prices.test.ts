import { describe, expect, it } from "vitest";
import { estimateCostUsd, priceFor } from "./prices";

const usage = (model: string, over: Partial<Parameters<typeof estimateCostUsd>[0]> = {}) => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  audioSeconds: 0,
  ...over,
});

describe("priceFor", () => {
  it("prices a dated snapshot like its alias", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
    expect(priceFor("gpt-4o-mini-2024-07-18")).toEqual(priceFor("gpt-4o-mini"));
  });

  it("doesn't let a prefix borrow another model's price", () => {
    // gpt-4o-transcribe bills audio tokens at its own rates — not gpt-4o's.
    expect(priceFor("gpt-4o-transcribe")).toBeNull();
    expect(priceFor("gpt-4o-transcribe-diarize")).toBeNull();
  });

  it("returns null for a model nobody priced", () => {
    expect(priceFor("claude-opus-4-1")).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("bills each Claude token kind at its own rate", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, cache write = 1.25 × $4.
    const usd = estimateCostUsd(
      usage("claude-opus-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 400_000,
      }),
    );
    expect(usd).toBeCloseTo(4 + 2 + 0.4 + 2, 6);
  });

  it("defaults cache reads to a tenth of input when the row has no rate", () => {
    expect(estimateCostUsd(usage("claude-haiku-4-5", { cacheReadTokens: 1_000_000 }))).toBeCloseTo(0.1, 6);
  });

  it("bills whisper-1 by the minute of audio", () => {
    expect(estimateCostUsd(usage("whisper-1", { audioSeconds: 600 }))).toBeCloseTo(0.06, 6);
  });

  it("is null, not zero, for an unpriced model", () => {
    expect(estimateCostUsd(usage("gpt-image-2", { inputTokens: 5000 }))).toBeNull();
  });
});
