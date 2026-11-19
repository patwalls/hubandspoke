import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// Picking a DM keyword on the post page used to leave the caption saying the
// old one ("Comment or DM me “SIDEHUSTLE” …", often copied over from the post
// this one was cross-posted from), and people retyped it by hand on every
// post. Now the caption follows the keyword. The short-link service is
// external (no credentials in e2e), so only its calls are faked here; the
// keyword save on the item and the caption save are the app's own.

async function attachAndCheck(page: Page, opts: { cta: (other: string) => string; before: string; after: string; shot?: boolean }) {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E keyword ${stamp}`,
        platform: ["instagram_reel"],
        postType: "instagram_reel",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    const caption = `Built an app in a week ${stamp}.\n\n👇 ${opts.cta("SIDEHUSTLE")}`;
    await sql`UPDATE production_items SET status = 'Ready To Publish', enrichment_completed_at = now() WHERE id = ${id}`;
    await sql`
      INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
      VALUES (${id}, 1, true, ${sql.json({ caption })}, ${sql.json({ version: 1, fields: [] })}, 'user')`;

    const link = (slug: string) => ({
      slug, destinationUrl: "https://starterstory.com/x", clicksCount: 0, lastClickedAt: null, tag: "dm",
      archived: false, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", inUseCount: 0,
    });
    await page.route("**/api/short-links?**", (r) => r.fulfill({ json: { shortLinks: [link("sidehustle"), link("firstsale")] } }));
    await page.route(`**/api/production-items/${id}/suggested-dm-destination`, (r) => r.fulfill({ status: 404, json: { error: "none" } }));
    await page.route(`**/api/production-items/${id}/dm-keyword`, (r) => r.fulfill({ json: { ok: true } }));

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${id}`);
    await expect(page.getByText(opts.before, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    await page.getByTitle("ManyChat DM keyword for this post's auto-reply flow").click();
    await page.getByRole("button", { name: "+ Attach DM keyword" }).click();
    const dialog = page.getByRole("dialog", { name: "Attach DM keyword" });
    await dialog.getByRole("row", { name: /firstsale/ }).click();
    const edit = page.getByRole("dialog", { name: /DM keyword: firstsale/ });
    await edit.getByPlaceholder("https://starterstory.com/…").fill("https://starterstory.com/firstsale");
    await edit.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Caption now says FIRSTSALE")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("“FIRSTSALE”", { exact: false }).first()).toBeVisible();
    await expect.poll(async () => {
      const [d] = await sql`SELECT content FROM content_drafts WHERE production_item_id = ${id} AND is_current`;
      return d?.content?.caption as string;
    }).toContain(opts.after);
    const [item] = await sql`SELECT short_link_slug FROM production_items WHERE id = ${id}`;
    expect(item.short_link_slug).toBe("firstsale");
    if (opts.shot && process.env.E2E_SHOT) {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.screenshot({ path: process.env.E2E_SHOT, fullPage: false });
    }
  } finally {
    await sql.end();
  }
}

test("attaching a DM keyword on the post page rewrites the caption's keyword", async ({ page }) => {
  await attachAndCheck(page, {
    cta: () => "Comment or DM me “SIDEHUSTLE” and I'll send you the full episode.",
    before: "SIDEHUSTLE",
    after: "Comment or DM me “FIRSTSALE” and I'll send you the full episode.",
  });
});

// The draft writer no longer copies another post's keyword into a caption
// when the post has none yet: it writes the “KEYWORD” placeholder, and
// attaching a keyword fills it in (here even with another pool keyword
// quoted further down the caption).
test("attaching a DM keyword fills the draft's “KEYWORD” placeholder", async ({ page }) => {
  await attachAndCheck(page, {
    cta: (other) => `Comment “KEYWORD” and I'll DM you the playbook. (Last week's was “${other}”.)`,
    before: "“KEYWORD”",
    after: "Comment “FIRSTSALE” and I'll DM you the playbook. (Last week's was “SIDEHUSTLE”.)",
    shot: true,
  });
});
