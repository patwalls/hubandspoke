import { describe, it, expect } from "vitest";
import { createTestAccount, createTestProductionItem } from "@/test/factories";
import { fetchTargetCommonalityForFormat } from "./cross-post-candidates";
import { usualTargetKeys } from "@/lib/cross-post-usual";

// The post page's Cross-post tab asks for one format's targets
// (GET /api/production-items/[id]/cross-post-usual). The filtered query must
// count exactly what the queue's all-formats query counts for that format —
// and nothing from other formats — or "Select usual" would differ by screen.
describe("fetchTargetCommonalityForFormat", () => {
  it("returns only the asked format's targets, with the same usual shares", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const fmt = `vitest-usual-${suffix}`;
    const other = `vitest-usual-other-${suffix}`;
    const tiktok = await createTestAccount({ platform: "tiktok", handle: `vt_tt_${suffix}` });
    const x = await createTestAccount({ platform: "x", handle: `vt_x_${suffix}` });

    const crossPost = (sourceId: string, accountId: string, postType: string) =>
      createTestProductionItem({
        sourceType: "cross_post",
        repostedFromItemId: sourceId,
        accountId,
        postType,
        status: "Ready To Publish",
      });

    // Three sources of fmt: all to TikTok, one to X.
    for (let i = 0; i < 3; i++) {
      const src = await createTestProductionItem({ format: fmt });
      await crossPost(src.id, tiktok.id, "tiktok");
      if (i === 0) await crossPost(src.id, x.id, "x");
    }
    // Another format's source going to X — must not leak in.
    const otherSrc = await createTestProductionItem({ format: other });
    await crossPost(otherSrc.id, x.id, "x");

    const rows = await fetchTargetCommonalityForFormat(fmt);
    expect(rows).toHaveLength(2);
    const tt = rows.find((r) => r.accountId === tiktok.id)!;
    const xr = rows.find((r) => r.accountId === x.id)!;
    expect(tt).toMatchObject({ postType: "tiktok", count: 3, recentSources: 3, recentTotal: 3 });
    expect(xr).toMatchObject({ postType: "x", count: 1, recentSources: 1, recentTotal: 3 });
    // Ranked by count, so the usual rule picks TikTok only.
    expect(rows[0].accountId).toBe(tiktok.id);
    expect(usualTargetKeys(rows, [`${tiktok.id}:tiktok`, `${x.id}:x`])).toEqual([
      `${tiktok.id}:tiktok`,
    ]);

    expect(await fetchTargetCommonalityForFormat(`vitest-usual-none-${suffix}`)).toEqual([]);
  });
});
