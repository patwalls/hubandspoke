import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Cross-posting a clip used to fill the new post's caption with the clip's
// notes (the "Source: … / Timestamp: … / Angle: … / Why: …" block a clip keeps
// in content_body) instead of the caption written on the clip. Editors deleted
// and retyped it on every TikTok cross-post.
test("a clip's cross-post starts with the clip's caption, not its notes", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const editorUserId = session?.user?.id;
    expect(editorUserId).toBeTruthy();

    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E clip ${stamp}`,
        platform: ["instagram_reel"],
        postType: "instagram_reel",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
        editorUserId,
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const clipId = (await res.json()).id as string;

    const notes = [
      "Source: How to Earn Respect in Sales",
      "Timestamp: 02:46–03:15 (29s)",
      "",
      "Angle: Always-on availability reads as low status",
      "",
      "Why: Strong contrarian opener",
    ].join("\n");
    const caption = `Being relatable goes a long way in sales. ${stamp}`;
    await sql`
      UPDATE production_items SET status = 'Published', content_body = ${notes},
        enrichment_completed_at = now()
      WHERE id = ${clipId}`;
    await sql`
      INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
      VALUES (${clipId}, 1, true, ${sql.json({ caption })}, ${sql.json({ version: 1, fields: [] })}, 'user')`;
    const [account] = await sql`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'tiktok', ${`e2e_tt_${stamp}`} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;

    const cp = await page.request.post(`/api/production-items/${clipId}/cross-post`, {
      data: { targetAccountId: account.id, targetPostType: "tiktok", manual: true },
    });
    expect(cp.ok(), await cp.text()).toBeTruthy();
    const crossPostId = (await cp.json()).id as string;

    const [draft] = await sql`
      SELECT content FROM content_drafts WHERE production_item_id = ${crossPostId} AND is_current`;
    expect(draft.content.caption).toBe(caption);

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${crossPostId}`);
    await expect(page.getByText(caption).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Timestamp: 02:46")).toHaveCount(0);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
  } finally {
    await sql.end();
  }
});
