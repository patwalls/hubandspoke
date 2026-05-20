import { describe, expect, it } from "vitest";
import {
  buildWhySpoke,
  computePairHistoryMultiplier,
  type SpokePriorAttempt,
} from "./spoke-candidates";

const NOW = Date.UTC(2026, 4, 19); // 2026-05-19, matches dev clock for repeatability
const DAY = 86_400_000;

function attempt(opts: Partial<SpokePriorAttempt>): SpokePriorAttempt {
  return {
    productionItemId: "pi-" + Math.random().toString(36).slice(2),
    status: null,
    publishedAt: null,
    views: null,
    killedAt: null,
    ...opts,
  };
}

describe("computePairHistoryMultiplier", () => {
  it("returns 1.0 when there is no prior history", () => {
    expect(computePairHistoryMultiplier([], 1000, NOW)).toBe(1.0);
  });

  it("penalizes recently killed pairs to 0.4×", () => {
    const priors = [
      attempt({
        status: "Killed",
        killedAt: new Date(NOW - 10 * DAY).toISOString(),
      }),
    ];
    expect(computePairHistoryMultiplier(priors, 1000, NOW)).toBe(0.4);
  });

  it("does not penalize kills older than the 60d window", () => {
    const priors = [
      attempt({
        status: "Killed",
        killedAt: new Date(NOW - 90 * DAY).toISOString(),
      }),
    ];
    expect(computePairHistoryMultiplier(priors, 1000, NOW)).toBe(1.0);
  });

  it("boosts when the most recent Published attempt beat the format baseline", () => {
    const priors = [
      attempt({
        status: "Published",
        publishedAt: new Date(NOW - 45 * DAY).toISOString(),
        views: 5000,
      }),
    ];
    // 5000 / 1000 = 5.0, clamped to ceiling 2.5
    expect(computePairHistoryMultiplier(priors, 1000, NOW)).toBe(2.5);
  });

  it("dampens when the most recent Published attempt underperformed", () => {
    const priors = [
      attempt({
        status: "Published",
        publishedAt: new Date(NOW - 45 * DAY).toISOString(),
        views: 200,
      }),
    ];
    // 200 / 1000 = 0.2, clamped to floor 0.5
    expect(computePairHistoryMultiplier(priors, 1000, NOW)).toBe(0.5);
  });

  it("uses the MOST RECENT published attempt when several exist", () => {
    const priors = [
      attempt({
        status: "Published",
        publishedAt: new Date(NOW - 200 * DAY).toISOString(),
        views: 10_000, // old crushing hit
      }),
      attempt({
        status: "Published",
        publishedAt: new Date(NOW - 30 * DAY).toISOString(),
        views: 500, // recent flop
      }),
    ];
    // Should pick the recent flop (500/1000 = 0.5)
    expect(computePairHistoryMultiplier(priors, 1000, NOW)).toBe(0.5);
  });

  it("returns 1.0 when formatP60 is zero (avoids divide-by-zero)", () => {
    const priors = [
      attempt({
        status: "Published",
        publishedAt: new Date(NOW - 30 * DAY).toISOString(),
        views: 10_000,
      }),
    ];
    expect(computePairHistoryMultiplier(priors, 0, NOW)).toBe(1.0);
  });

  it("ignores Published rows with null views (treats as no signal)", () => {
    const priors = [
      attempt({
        status: "Published",
        publishedAt: new Date(NOW - 30 * DAY).toISOString(),
        views: null,
      }),
    ];
    expect(computePairHistoryMultiplier(priors, 1000, NOW)).toBe(1.0);
  });

  it("recent kill takes priority over old published hit", () => {
    const priors = [
      attempt({
        status: "Published",
        publishedAt: new Date(NOW - 200 * DAY).toISOString(),
        views: 10_000,
      }),
      attempt({
        status: "Killed",
        killedAt: new Date(NOW - 5 * DAY).toISOString(),
      }),
    ];
    expect(computePairHistoryMultiplier(priors, 1000, NOW)).toBe(0.4);
  });
});

describe("buildWhySpoke", () => {
  const baseOpts = {
    pillarStrength: 1.0,
    formatFit: 1.0,
    freshnessFactor: 1.0,
    pairHistoryMultiplier: 1.0,
    formatLiftRatio: 1.0,
    pairSourceLift: 1.0,
    ageDays: 10,
    priors: [] as SpokePriorAttempt[],
  };

  it("leads with pair-history boost when prior shipped pair crushed", () => {
    const result = buildWhySpoke({
      ...baseOpts,
      pairHistoryMultiplier: 2.0,
      priors: [
        attempt({
          status: "Published",
          publishedAt: new Date(NOW - 30 * DAY).toISOString(),
          views: 5000,
        }),
      ],
    });
    expect(result).toMatch(/Already shipped/i);
    expect(result).toMatch(/Do more/i);
  });

  it("leads with pillar strength when the pillar is crushing", () => {
    const result = buildWhySpoke({ ...baseOpts, pillarStrength: 3.0 });
    expect(result).toMatch(/Pillar is 3\.0×/);
  });

  it("leads with format heat when format is well above brand baseline", () => {
    const result = buildWhySpoke({
      ...baseOpts,
      formatFit: 2.0,
      formatLiftRatio: 2.0,
    });
    expect(result).toMatch(/Format is hot/);
  });

  it("calls out older pillars when freshness floor kicked in", () => {
    const result = buildWhySpoke({
      ...baseOpts,
      freshnessFactor: 0.3,
      ageDays: 365,
    });
    expect(result).toMatch(/Older pillar/);
  });

  it("falls through to the all-around blurb when nothing stands out", () => {
    const result = buildWhySpoke(baseOpts);
    expect(result).toMatch(/Solid all-around/);
  });
});
