import { test, expect } from "@playwright/test";
import postgres from "postgres";

// A post whose caption tells people to comment another post's keyword
// (copied along with an older caption) used to go out that way unless
// someone spotted it by eye. The post page now says so in one line above
// the draft and fixes it in one click. The short-link service is external
// (no credentials in e2e), so only its calls are faked here.

test("the post page flags a caption quoting another keyword and fixes it in one click", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E caption check ${stamp}`,
        platform: ["instagram_reel"],
        postType: "instagram_reel",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    const caption = `Built an app in a week ${stamp}.\n\n👇 Comment or DM me “SIDEHUSTLE” and I'll send you the full episode.`;
    await sql`UPDATE production_items SET status = 'Review', short_link_slug = 'firstsale', enrichment_completed_at = now() WHERE id = ${id}`;
    await sql`
      INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
      VALUES (${id}, 1, true, ${sql.json({ caption })}, ${sql.json({ version: 1, fields: [] })}, 'user')`;

    const link = (slug: string) => ({
      slug, destinationUrl: "https://starterstory.com/x", clicksCount: 0, lastClickedAt: null, tag: "dm",
      archived: false, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", inUseCount: 0,
    });
    await page.route("**/api/short-links?**", (r) => r.fulfill({ json: { shortLinks: [link("sidehustle"), link("firstsale")] } }));
    await page.route("**/api/short-links/firstsale", (r) => r.fulfill({ json: link("firstsale") }));

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${id}`);

    const check = page.getByTestId("caption-keyword-check");
    await expect(check).toContainText("Caption says “SIDEHUSTLE”, but this post’s DM keyword is FIRSTSALE.", { timeout: 15_000 });
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: false });

    await check.getByRole("button", { name: "Use FIRSTSALE" }).click();
    await expect(page.getByText("Caption now says FIRSTSALE")).toBeVisible({ timeout: 10_000 });
    await expect(check).toHaveCount(0);
    await expect.poll(async () => {
      const [d] = await sql`SELECT content FROM content_drafts WHERE production_item_id = ${id} AND is_current`;
      return d?.content?.caption as string;
    }).toContain("Comment or DM me “FIRSTSALE” and I'll send you the full episode.");
  } finally {
    await sql.end();
  }
});
