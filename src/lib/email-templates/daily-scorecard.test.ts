import { describe, expect, it } from "vitest";
import { aiSpikeLine, renderDailyScorecardEmail } from "./daily-scorecard";
import type { ScorecardData, ScorecardWindow } from "@/lib/services/scorecard";
import type { AiSpendSpike } from "@/lib/services/ai-spend";

const win = (start: string, end: string): ScorecardWindow => ({
  start: new Date(start),
  end: new Date(end),
  totalOriginals: 10,
  totalReposts: 0,
  totalCrossPosts: 0,
  totalRepurposed: 0,
  totalAccountsShipped: 1,
  totalAccounts: 2,
  byBrand: [],
});
const data: ScorecardData = {
  thisWeek: win("2026-11-10T00:00:00Z", "2026-11-17T00:00:00Z"),
  lastWeek: win("2026-11-03T00:00:00Z", "2026-11-10T00:00:00Z"),
};
const spike = (feature: string, costUsd: number, usualUsd = 1): AiSpendSpike => ({
  feature,
  provider: "anthropic",
  day: "2026-11-16",
  costUsd,
  calls: 10,
  usualUsd,
});

describe("daily scorecard AI-spend spike line", () => {
  it("is absent when nothing spiked (and when no spikes are passed)", () => {
    expect(aiSpikeLine([])).toBeNull();
    for (const r of [renderDailyScorecardEmail(data), renderDailyScorecardEmail(data, { aiSpikes: [] })]) {
      expect(r.text).not.toContain("AI spend");
      expect(r.html).not.toContain("AI spend");
    }
  });

  it("names each spiked feature with yesterday's cost and its usual day, in text and html", () => {
    const r = renderDailyScorecardEmail(data, { aiSpikes: [spike("clip-idea-agent", 12.5, 2)] });
    const line = "AI spend spiked yesterday: clip-idea-agent $12.50 (usually $2.00/day).";
    expect(r.text).toContain(line);
    expect(r.html).toContain(line);
  });

  it("caps the line at three features", () => {
    const line = aiSpikeLine([spike("a", 9), spike("b", 8), spike("c", 7), spike("d", 6), spike("e", 5)]);
    expect(line).toContain("a $9.00");
    expect(line).toContain("c $7.00");
    expect(line).not.toContain("d $6.00");
    expect(line).toMatch(/and 2 more\.$/);
  });
});
