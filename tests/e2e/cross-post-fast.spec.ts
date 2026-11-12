import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Cross-posting one source to several accounts in a row (the cross-post
// queue's usual shape) — the caption cleanup now starts before the route's
// other lookups and is remembered per caption. Both cross-posts must still land
// with the source's caption (no LLM key here, so the cleanup fails soft and the
// caption is copied verbatim; the model path is covered by
// src/lib/services/repost-text-cleanup.test.ts).
test("one source cross-posted to two accounts: both land with its caption", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const editorUserId = session?.user?.id;
    expect(editorUserId).toBeTruthy();

    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E fast cross-post ${stamp}`,
        platform: ["instagram_reel"],
        postType: "instagram_reel",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
        editorUserId,
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const sourceId = (await res.json()).id as string;

    const caption = `8 years ago today:\n\nI quit my job to build this. ${stamp}`;
    await sql`
      UPDATE production_items SET status = 'Published', enrichment_completed_at = now()
      WHERE id = ${sourceId}`;
    await sql`
      INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
      VALUES (${sourceId}, 1, true, ${sql.json({ caption })}, ${sql.json({ version: 1, fields: [] })}, 'user')`;

    const ids: string[] = [];
    for (const [platform, postType] of [
      ["tiktok", "tiktok"],
      ["x", "x"],
    ] as const) {
      const [account] = await sql`
        INSERT INTO accounts (brand_id, platform, handle)
        SELECT id, ${platform}, ${`e2e_${platform}_${stamp}`} FROM brands WHERE slug = 'starter-story'
        RETURNING id`;
      const cp = await page.request.post(`/api/production-items/${sourceId}/cross-post`, {
        data: { targetAccountId: account.id, targetPostType: postType, assign: true, manual: true },
      });
      expect(cp.status(), await cp.text()).toBe(201);
      ids.push((await cp.json()).id as string);
    }

    for (const id of ids) {
      const [draft] = await sql`
        SELECT content FROM content_drafts WHERE production_item_id = ${id} AND is_current`;
      // TikTok keeps it under `caption`, X under `tweet`.
      expect(JSON.stringify(draft.content)).toContain(`I quit my job to build this. ${stamp}`);
    }

    // A third try at the same account is still refused as a duplicate.
    const [dupAccount] = await sql`
      SELECT account_id FROM production_items WHERE id = ${ids[0]}`;
    const dup = await page.request.post(`/api/production-items/${sourceId}/cross-post`, {
      data: { targetAccountId: dupAccount.account_id, targetPostType: "tiktok", manual: true },
    });
    expect(dup.status()).toBe(409);

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${ids[0]}`);
    await expect(page.getByText(`I quit my job to build this. ${stamp}`).first()).toBeVisible({
      timeout: 15_000,
    });
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql.end();
  }
});
