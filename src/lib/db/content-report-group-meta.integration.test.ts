import { describe, it, expect } from "vitest";
import { getContentReport } from "@/lib/db/queries";
import { createTestAccount, createTestProductionItem } from "@/test/factories";

/**
 * The cross-brand /all dashboard's "Group by → Brand" mode buckets the primary
 * table's rows by `primaryRowMeta[row].brandSlug` / `.brandLabel`. Those two
 * fields are the contract that feature depends on — a refactor that dropped
 * them from `getContentReport` would silently break brand grouping (every row
 * would fall into the "misc" bucket). This proves the meta carries them.
 */
describe("getContentReport primaryRowMeta brand fields", () => {
  const baseParams = {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    viewType: "weekly" as const,
    platform: "all",
    platformKey: "all",
    accountId: "all",
    postType: "all",
    format: "all",
    source: "all",
    origin: "all",
  };

  it("stamps brandSlug/brandLabel on the account's row so /all can group by brand", async () => {
    // A disposable account on starter-story with a published item on it. The
    // primary row is keyed by (account, post_type); its meta must carry the
    // brand so the cross-brand view can bucket it.
    const account = await createTestAccount({
      brand: "starter-story",
      platform: "x",
      handle: `vitest-brandmeta-${Math.random().toString(36).slice(2, 8)}`,
    });
    await createTestProductionItem({
      brand: "starter-story",
      accountId: account.id,
      postType: "x",
      publishedDate: "2026-03-15",
      publishedAt: new Date("2026-03-15T12:00:00Z"),
    });

    const report = await getContentReport({ ...baseParams, brand: "all" });

    const rowMeta = report.primaryRowMeta ?? {};
    const mine = Object.values(rowMeta).find(
      (m) => m.accountId === account.id,
    );
    expect(mine, "expected a primaryRowMeta entry for the test account").toBeTruthy();
    expect(mine!.brandSlug).toBe("starter-story");
    expect(mine!.brandLabel).toBeTruthy();
  });
});
