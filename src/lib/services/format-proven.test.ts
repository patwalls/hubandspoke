import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  buildProvenStatusMap,
  computeProvenStatusForBrand,
  PROVEN_MIN_ITEMS,
  PROVEN_OUTLIER_MULTIPLIER,
  PROVEN_VOLUME_HIT_MIN_HITS,
  PROVEN_VOLUME_HIT_MIN_ITEMS,
  summarizeProvenStatuses,
} from "./format-proven";
import {
  createTestFormat,
  createTestProductionItem,
} from "@/test/factories";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function daysAgoString(n: number): string {
  return daysAgo(n).toISOString().slice(0, 10);
}

describe("buildProvenStatusMap", () => {
  it("marks a format proven when it clears all four bars", () => {
    // Peer baseline: 10 x-posts with median 1000.
    const peer = Array.from({ length: 10 }, (_, i) => ({
      format: "Other",
      postType: "x",
      views: 1000,
      publishedDate: daysAgoString(30),
    }));
    // Target format: 5 posts at >= peer median + one hit at 3x.
    const target = [
      { format: "Hits", postType: "x", views: 5000, publishedDate: daysAgoString(10) },
      { format: "Hits", postType: "x", views: 1200, publishedDate: daysAgoString(40) },
      { format: "Hits", postType: "x", views: 1100, publishedDate: daysAgoString(60) },
      { format: "Hits", postType: "x", views: 1500, publishedDate: daysAgoString(80) },
      { format: "Hits", postType: "x", views: 1000, publishedDate: daysAgoString(20) },
    ];

    const map = buildProvenStatusMap([...peer, ...target]);
    const hits = map.get("Hits");
    expect(hits).toBeDefined();
    expect(hits!.isProven).toBe(true);
    expect(hits!.reason).toBe("proven");
    expect(hits!.itemCount).toBe(5);
    expect(hits!.hitCount).toBeGreaterThanOrEqual(1);
  });

  it("downgrades to testing when there are not enough items", () => {
    const peer = Array.from({ length: 8 }, () => ({
      format: "Other",
      postType: "x",
      views: 1000,
      publishedDate: daysAgoString(30),
    }));
    const target = [
      { format: "Sparse", postType: "x", views: 5000, publishedDate: daysAgoString(20) },
      { format: "Sparse", postType: "x", views: 4000, publishedDate: daysAgoString(40) },
    ];

    const map = buildProvenStatusMap([...peer, ...target]);
    expect(map.get("Sparse")?.reason).toBe("testing");
    expect(map.get("Sparse")?.itemCount).toBe(2);
    expect(PROVEN_MIN_ITEMS).toBeGreaterThan(2);
  });

  it("marks a high-volume clip format proven via the hits path, even when median is below peer", () => {
    // Real-world shape: 200 clip items, peer cohort is bigger and faster
    // so the format's median sits just below peer. But the format mints
    // outliers reliably — 8 hits at >= 3x peer median. This is the
    // "Repackage Section w/ Hook" case.
    const peer = Array.from({ length: 200 }, (_, i) => ({
      format: `OtherClip${i % 10}`,
      postType: "instagram_reel",
      views: 21_000 + (i % 5) * 200,
      publishedDate: daysAgoString(20 + (i % 30)),
    }));
    const clips: { format: string; postType: string; views: number; publishedDate: string }[] = [];
    for (let i = 0; i < 192; i++) {
      clips.push({
        format: "Repackage",
        postType: "instagram_reel",
        // 192 items at ~20k views (just below peer median) plus the hits.
        views: 19_500 + (i % 7) * 300,
        publishedDate: daysAgoString(5 + (i % 90)),
      });
    }
    for (let i = 0; i < 8; i++) {
      clips.push({
        format: "Repackage",
        postType: "instagram_reel",
        views: 500_000 + i * 50_000,
        publishedDate: daysAgoString(10 + i * 5),
      });
    }

    const map = buildProvenStatusMap([...peer, ...clips]);
    const repackage = map.get("Repackage");
    expect(repackage).toBeDefined();
    expect(repackage!.isProven).toBe(true);
    expect(repackage!.reason).toBe("proven");
    expect(repackage!.itemCount).toBeGreaterThanOrEqual(PROVEN_VOLUME_HIT_MIN_ITEMS);
    expect(repackage!.hitCount).toBeGreaterThanOrEqual(PROVEN_VOLUME_HIT_MIN_HITS);
    // Median is BELOW peer — proves we got there via the hits path, not
    // the consistency path.
    expect(repackage!.formatMedian).toBeLessThan(repackage!.peerMedian);
  });

  it("does NOT promote via the hits path when there are too few hits", () => {
    // 20 items, only 1 hit — clear noise, not signal. Without this guard
    // a single viral fluke would qualify a dead format.
    const peer = Array.from({ length: 20 }, () => ({
      format: "Other",
      postType: "x",
      views: 1000,
      publishedDate: daysAgoString(30),
    }));
    const fluke = Array.from({ length: 20 }, (_, i) => ({
      format: "OneHit",
      postType: "x",
      views: i === 0 ? 100_000 : 200,
      publishedDate: daysAgoString(10 + i * 3),
    }));

    const map = buildProvenStatusMap([...peer, ...fluke]);
    const oneHit = map.get("OneHit");
    expect(oneHit?.reason).toBe("testing");
    expect(oneHit?.hitCount).toBe(1);
    expect(PROVEN_VOLUME_HIT_MIN_HITS).toBeGreaterThan(1);
  });

  it("downgrades to testing when there is no real outlier", () => {
    const peer = Array.from({ length: 10 }, () => ({
      format: "Other",
      postType: "x",
      views: 1000,
      publishedDate: daysAgoString(30),
    }));
    // 5 items, all at or just above the peer median — never approaches 3x.
    const target = Array.from({ length: 5 }, (_, i) => ({
      format: "Flat",
      postType: "x",
      views: 1100 + i * 50,
      publishedDate: daysAgoString(20 + i * 10),
    }));

    const map = buildProvenStatusMap([...peer, ...target]);
    const flat = map.get("Flat");
    expect(flat?.reason).toBe("testing");
    expect(flat?.hitCount).toBe(0);
    expect(PROVEN_OUTLIER_MULTIPLIER).toBe(3);
  });

  it("marks a format stale when nothing published in the last 90 days", () => {
    const peer = Array.from({ length: 10 }, () => ({
      format: "Other",
      postType: "x",
      views: 1000,
      publishedDate: daysAgoString(30),
    }));
    // 5 items, all between 91 and 170 days old.
    const target = Array.from({ length: 5 }, (_, i) => ({
      format: "Stale",
      postType: "x",
      views: 4000,
      publishedDate: daysAgoString(95 + i * 10),
    }));

    const map = buildProvenStatusMap([...peer, ...target]);
    const stale = map.get("Stale");
    expect(stale?.reason).toBe("stale");
    expect(stale?.recentItemCount).toBe(0);
  });

  it("uses the format's dominant postType for the peer baseline", () => {
    // Two cohorts: shorts (median 500) and longform (median 50000). A
    // longform format with a median of 60000 should compare against the
    // longform baseline (60k > 50k peer) — not the global mixed median.
    const shorts = Array.from({ length: 10 }, (_, i) => ({
      format: `Short${i}`,
      postType: "youtube_shorts",
      views: 500,
      publishedDate: daysAgoString(20),
    }));
    const longformBaseline = Array.from({ length: 10 }, () => ({
      format: "OtherLong",
      postType: "youtube_long",
      views: 50000,
      publishedDate: daysAgoString(20),
    }));
    const target = Array.from({ length: 5 }, (_, i) => ({
      format: "LongHit",
      postType: "youtube_long",
      views: i === 0 ? 200000 : 60000,
      publishedDate: daysAgoString(10 + i * 5),
    }));

    const map = buildProvenStatusMap([...shorts, ...longformBaseline, ...target]);
    const long = map.get("LongHit");
    expect(long?.dominantPostType).toBe("youtube_long");
    expect(long?.peerMedian).toBe(50000);
    expect(long?.reason).toBe("proven");
  });

  it("summarizes counts across statuses", () => {
    const peer = Array.from({ length: 10 }, () => ({
      format: "Other",
      postType: "x",
      views: 1000,
      publishedDate: daysAgoString(30),
    }));
    const winner = Array.from({ length: 5 }, (_, i) => ({
      format: "Winner",
      postType: "x",
      views: i === 0 ? 5000 : 1200,
      publishedDate: daysAgoString(10 + i * 5),
    }));
    const flat = Array.from({ length: 5 }, (_, i) => ({
      format: "Flat",
      postType: "x",
      views: 1100,
      publishedDate: daysAgoString(10 + i * 5),
    }));
    const stale = Array.from({ length: 5 }, (_, i) => ({
      format: "Stale",
      postType: "x",
      views: 5000,
      publishedDate: daysAgoString(100 + i * 5),
    }));

    const map = buildProvenStatusMap([...peer, ...winner, ...flat, ...stale]);
    const summary = summarizeProvenStatuses(map.values());
    expect(summary.proven).toBe(1);
    // "Other" is testing too (low spread, no outlier even against itself).
    expect(summary.testing).toBeGreaterThanOrEqual(1);
    expect(summary.stale).toBe(1);
  });
});

describe("computeProvenStatusForBrand (integration)", () => {
  it("isolates brand: items from other brands do not affect the peer median", async () => {
    const brand = `vitest-${randomUUID().slice(0, 8)}`;
    const format = await createTestFormat({ brand });

    // 5 items in this brand, all at 5000 views, one at 50000 (outlier).
    for (let i = 0; i < 5; i++) {
      await createTestProductionItem({
        brand,
        format: format.name,
        status: "Published",
        postType: "x",
        accountId: null,
        publishedAt: daysAgo(10 + i * 5),
        views: i === 0 ? 50000 : 5000,
      });
    }
    // Items in a different brand at 1M views — should be invisible.
    const otherBrand = `vitest-other-${randomUUID().slice(0, 8)}`;
    await createTestProductionItem({
      brand: otherBrand,
      format: "Unrelated",
      status: "Published",
      postType: "x",
      accountId: null,
      publishedAt: daysAgo(10),
      views: 1_000_000,
    });

    const map = await computeProvenStatusForBrand(brand);
    const status = map.get(format.name);
    expect(status).toBeDefined();
    // The 50k vs 5k peer makes this a clean outlier; brand isolation means
    // the 1M cross-brand item never bumped the peer median.
    expect(status!.peerMedian).toBe(5000);
    expect(status!.isProven).toBe(true);
  });

  it("requires publishedDate to be set (filters out unpublished rows)", async () => {
    const brand = `vitest-${randomUUID().slice(0, 8)}`;
    const format = await createTestFormat({ brand });
    // Status=Published but publishedAt=null → publishedDate column is null.
    for (let i = 0; i < 5; i++) {
      await createTestProductionItem({
        brand,
        format: format.name,
        status: "Published",
        postType: "x",
        accountId: null,
        publishedAt: null,
        views: 10000,
      });
    }
    const map = await computeProvenStatusForBrand(brand);
    expect(map.has(format.name)).toBe(false);
  });
});
