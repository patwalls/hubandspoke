import { describe, expect, it } from "vitest";
import { findAiSpendSpikes, summarizeAiSpend, type AiSpendRow } from "./ai-spend";

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

describe("findAiSpendSpikes", () => {
  // Haiku 5.5 output: 1M tokens = $0.50 (see prices.test.ts) — use opus for round dollars:
  // claude-opus-5-5 output 100k tokens = $2 (per the summarize test above).
  const day = (d: string, usd: number, over: Partial<AiSpendRow> = {}) =>
    row({ day: d, model: "claude-opus-5-5", outputTokens: (usd / 2) * 100_000, ...over });
  const days = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `2026-11-${String(from + i).padStart(2, "0")}`);
  const now17 = new Date("2026-11-17T13:00:00Z"); // yesterday = 11-16; baseline 11-02..11-15

  it("flags a feature whose yesterday is ≥3× its usual day and ≥ $2", () => {
    const rows = [...days(2, 15).map((d) => day(d, 2)), day("2026-11-16", 8, { calls: 40 })];
    const s = findAiSpendSpikes(rows, { now: now17 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ feature: "clip-idea-agent", day: "2026-11-16", calls: 40 });
    expect(s[0].costUsd).toBeCloseTo(8, 6);
    expect(s[0].usualUsd).toBeCloseTo(2, 6);
  });

  it("stays quiet under 3× or under the $2 floor", () => {
    const under3x = [...days(2, 15).map((d) => day(d, 2)), day("2026-11-16", 5.9)];
    expect(findAiSpendSpikes(under3x, { now: now17 })).toEqual([]);
    const tiny = [...days(2, 15).map((d) => day(d, 0.1)), day("2026-11-16", 1.9)];
    expect(findAiSpendSpikes(tiny, { now: now17 })).toEqual([]);
  });

  it("zero-fills quiet days, so a mostly-idle feature's usual is $0", () => {
    const rows = [
      ...days(2, 15).map((d) => day(d, 1, { feature: "other" })), // metering ran all along
      day("2026-11-05", 3), // the feature itself ran once
      day("2026-11-16", 4),
    ];
    const s = findAiSpendSpikes(rows, { now: now17 });
    expect(s.map((x) => x.feature)).toEqual(["clip-idea-agent"]);
    expect(s[0].usualUsd).toBe(0);
  });

  it("says nothing until metering has a week of history", () => {
    // Metering began 11-11: 5 baseline days (11-11..11-15) < 7.
    const rows = [...days(11, 15).map((d) => day(d, 0.5)), day("2026-11-16", 50)];
    expect(findAiSpendSpikes(rows, { now: now17 })).toEqual([]);
    expect(findAiSpendSpikes([], { now: now17 })).toEqual([]);
  });

  it("ignores today's partial day and orders spikes costliest first", () => {
    const rows = [
      ...days(2, 15).map((d) => day(d, 1)),
      ...days(2, 15).map((d) => day(d, 1, { feature: "b" })),
      day("2026-11-16", 6),
      day("2026-11-16", 20, { feature: "b" }),
      day("2026-11-17", 500, { feature: "c" }), // today: not judged
    ];
    expect(findAiSpendSpikes(rows, { now: now17 }).map((x) => x.feature)).toEqual(["b", "clip-idea-agent"]);
  });
});
