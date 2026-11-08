import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LIMIT = 2 * 1024 * 1024;

/** Row shaped like a real report row: unique ids, one of a few accounts. */
function reportRow(i: number) {
  const id = createHash("sha256").update(String(i)).digest("hex");
  return {
    id,
    brand: "starter-story",
    status: "Idea",
    format: "Repackage Section w/ Hook",
    platform: ["instagram"],
    title: `Clip ${id.slice(0, 40)} about how founders found their first customers`,
    sourceClipIdeaId: id.slice(8),
    pillarContentItemId: id.slice(16),
    createdAt: new Date("2026-11-08T12:00:00Z"),
    account: {
      id: `account-${i % 8}`,
      platform: "instagram",
      handle: `handle-${i % 8}`,
      displayName: "Starter Story",
      avatarUrl: `https://cdn.example.com/avatars/${i % 8}.jpg`,
      brandSlug: "starter-story",
      brandLabel: "Starter Story",
    },
    filler: "x".repeat(1800),
  };
}

const { store, computes } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  computes: { count: 0 },
}));

// Next's rule from incremental-cache/index.js: an entry whose serialized form
// is over 2 MB is logged and dropped, and the fresh value is returned anyway.
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>, keyParts: string[]) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([keyParts, args]);
      const hit = store.get(key);
      if (hit !== undefined) return JSON.parse(hit);
      const value = await fn(...args);
      const body = JSON.stringify(value);
      const entry = JSON.stringify({ kind: "FETCH", data: { body, status: 200 } });
      if (entry.length <= 2 * 1024 * 1024) store.set(key, body);
      return JSON.parse(body);
    },
}));

vi.mock("@/lib/db/queries", () => ({
  getProductionPipeline: vi.fn(async () => {
    computes.count++;
    return Array.from({ length: 1200 }, (_, i) => reportRow(i));
  }),
  getContentReport: vi.fn(async () => {
    computes.count++;
    return { items: Array.from({ length: 1200 }, (_, i) => reportRow(i)) };
  }),
}));
vi.mock("@/lib/services/view-predictor", () => ({
  buildViewPredictorContext: vi.fn(async () => ({})),
  predictViews: vi.fn(() => null),
}));
vi.mock("@/lib/services/clip-odds", () => ({
  loadFormatOdds: vi.fn(async () => new Map()),
}));

import { compressedCache } from "./compressed-cache";
import { getContentReportCached } from "@/lib/db/queries-cached";
import { getProductionReportCached } from "@/lib/services/production-report";

beforeEach(() => {
  store.clear();
  computes.count = 0;
});

describe("reports over Next's 2 MB cache entry limit", () => {
  it("the production report is computed once for repeat requests", async () => {
    const first = await getProductionReportCached("starter-story", false);
    expect(JSON.stringify(first).length).toBeGreaterThan(LIMIT);

    await getProductionReportCached("starter-story", false);

    expect(computes.count).toBe(1);
  });

  it("the content report is computed once for repeat requests", async () => {
    const params = { brand: "all" } as Parameters<typeof getContentReportCached>[0];
    const first = await getContentReportCached(params);
    expect(JSON.stringify(first).length).toBeGreaterThan(LIMIT);

    await getContentReportCached(params);

    expect(computes.count).toBe(1);
  });
});

describe("compressedCache", () => {
  it("returns what a cached value looks like: a JSON round-trip", async () => {
    const at = new Date("2026-11-08T12:00:00Z");
    const read = compressedCache(async () => ({ at, name: "café ✨" }), ["t"], {});

    const value = (await read()) as unknown as { at: string; name: string };

    expect(value).toEqual({ at: at.toISOString(), name: "café ✨" });
  });

  it("keeps separate entries per argument", async () => {
    const fn = vi.fn(async (brand: string) => ({ brand }));
    const read = compressedCache(fn, ["t"], {});

    await read("a");
    await read("b");
    await read("a");

    expect(await read("b")).toEqual({ brand: "b" });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
