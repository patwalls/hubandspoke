import { describe, expect, it } from "vitest";
import { summarizeAiSpend, type AiSpendRow } from "./ai-spend";

const row = (over: Partial<AiSpendRow>): AiSpendRow => ({
  day: "2026-11-17",
  provider: "anthropic",
  feature: "clip-idea-agent",
  model: "claude-haiku-5-5",
  calls: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  audioSeconds: 0,
  ...over,
});
const now = new Date("2026-11-17T12:00:00Z");

describe("summarizeAiSpend", () => {
  it("ranks features by cost and merges a feature's models", () => {
    const s = summarizeAiSpend(
      [
        row({ feature: "cheap", calls: 50, inputTokens: 1_000_000 }), // haiku 5.5: $0.10
        row({ feature: "dear", model: "claude-opus-5-5", calls: 2, outputTokens: 100_000 }), // $2
        row({ feature: "dear", model: "claude-sonnet-5-5", calls: 5, outputTokens: 100_000 }), // $1
      ],
      { days: 7, now },
    );
    expect(s.byFeature.map((f) => f.feature)).toEqual(["dear", "cheap"]);
    expect(s.byFeature[0].costUsd).toBeCloseTo(3, 6);
    expect(s.byFeature[0].calls).toBe(7);
    expect(s.byFeature[0].models).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(s.totalCostUsd).toBeCloseTo(3.1, 6);
    expect(s.totalCalls).toBe(57);
  });

  it("keeps the same feature name apart per provider", () => {
    const s = summarizeAiSpend(
      [
        row({ feature: "x", provider: "anthropic" }),
        row({ feature: "x", provider: "openai", model: "whisper-1", audioSeconds: 60 }),
      ],
      { days: 1, now },
    );
    expect(s.byFeature).toHaveLength(2);
    expect(s.byProvider.map((p) => p.provider).sort()).toEqual(["anthropic", "openai"]);
  });

  it("counts unpriced calls without inventing a cost, and names the model", () => {
    const s = summarizeAiSpend(
      [
        row({ feature: "enhance", provider: "openai", model: "gpt-image-2", calls: 3, inputTokens: 9000 }),
        row({ feature: "enhance", provider: "openai", model: "gpt-4o-mini", calls: 1, inputTokens: 1_000_000 }),
      ],
      { days: 1, now },
    );
    expect(s.byFeature[0].unpricedCalls).toBe(3);
    expect(s.byFeature[0].costUsd).toBeCloseTo(0.15, 6);
    expect(s.unpricedModels).toEqual(["gpt-image-2"]);
  });

  it("zero-fills every day of the window, oldest first", () => {
    const s = summarizeAiSpend(
      [row({ day: "2026-11-15", model: "claude-opus-5-5", inputTokens: 1_000_000 })],
      { days: 3, now },
    );
    expect(s.byDay).toEqual([
      { day: "2026-11-15", costUsd: 4, calls: 1 },
      { day: "2026-11-16", costUsd: 0, calls: 0 },
      { day: "2026-11-17", costUsd: 0, calls: 0 },
    ]);
  });
});
