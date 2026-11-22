import { test, expect, type Download } from "@playwright/test";
import postgres from "postgres";

// Publishing a carousel natively means getting every slide onto your machine
// in post order. The post page's carousel used to offer only a per-slide
// download on hover; it now has "All N", which saves each slide as its own
// numbered file (slide-01, slide-02, …).

test("a carousel downloads every slide, numbered in post order", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E carousel ${stamp}`,
        platform: ["instagram_post"],
        postType: "instagram_post",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    // Same-origin images stand in for the S3 slides (no S3 in e2e).
    const slides = ["matg", "my-first-million", "science-of-scaling"].map((b) => ({
      imageUrl: `/brands/${b}.jpg`,
    }));
    await sql`UPDATE production_items SET status = 'Ready To Publish', enrichment_completed_at = now() WHERE id = ${id}`;
    await sql`
      INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
      VALUES (${id}, 1, true, ${sql.json({ caption: `Three slides ${stamp}`, slides })}, ${sql.json({ version: 1, fields: [] })}, 'user')`;

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${id}`);

    const all = page.getByRole("button", { name: "Download all 3 slides" });
    await expect(all).toBeAttached({ timeout: 15_000 });
    // Page at rest: the button is hidden until the carousel is hovered.
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT.replace(/\.png$/, "-rest.png") });
    await page.locator(`img[src="/brands/matg.jpg"]`).hover();
    await expect(all).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    const downloads: Download[] = [];
    page.on("download", (d) => downloads.push(d));
    await all.click();
    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(3);
    expect(downloads.map((d) => d.suggestedFilename())).toEqual([
      "slide-01.jpeg",
      "slide-02.jpeg",
      "slide-03.jpeg",
    ]);
    await expect.poll(async () => {
      const [r] = await sql`SELECT count(*)::int AS n FROM usage_events WHERE screen = 'media:download-all'`;
      return r.n as number;
    }).toBeGreaterThan(0);
  } finally {
    await sql.end();
  }
});
