import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { computeProvenStatusForBrand } from "./format-proven";
import {
  createTestFormat,
  createTestProductionItem,
} from "@/test/factories";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

describe("computeProvenStatusForBrand", () => {
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
