import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// The cross-post picker offers "Select usual (N)": one click checks the
// accounts this source's format went to in most of its recent cross-posts.
// Three earlier sources of the format all went to TikTok + X and one also to
// Threads, so the usual is TikTok + X (Threads, 1 of 3, is not).
async function createSource(page: Page, title: string, editorUserId: string): Promise<string> {
  const res = await page.request.post("/api/production-items", {
    data: {
      title,
      platform: ["instagram_reel"],
      postType: "instagram_reel",
      publishedDate: new Date().toISOString().slice(0, 10),
      brand: "starter-story",
      editorUserId,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).id as string;
}

test("Select usual checks the accounts the format usually goes to", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const format = `E2E Usual ${stamp}`;
    const session = await (await page.request.get("/api/auth/session")).json();
    const editorUserId = session?.user?.id as string;
    expect(editorUserId).toBeTruthy();

    const account = async (platform: string) => {
      const [row] = await sql`
        INSERT INTO accounts (brand_id, platform, handle)
        SELECT id, ${platform}, ${`e2e_${platform}_${stamp}`} FROM brands WHERE slug = 'starter-story'
        RETURNING id`;
      return row.id as string;
    };
    const ig = await account("instagram");
    const tiktok = await account("tiktok");
    const x = await account("x");
    const threads = await account("threads");

    // Three earlier sources (published 40 days ago — out of the queue's
    // window) and their cross-posts (made now — inside the usual window).
    for (let i = 0; i < 3; i++) {
      const id = await createSource(page, `E2E usual earlier ${i} ${stamp}`, editorUserId);
      await sql`
        UPDATE production_items
        SET status = 'Published', format = ${format}, account_id = ${ig}, views = 10,
            published_at = now() - interval '40 days', enrichment_completed_at = now()
        WHERE id = ${id}`;
      const targets: Array<[string, string]> = [[tiktok, "tiktok"], [x, "x"]];
      if (i === 0) targets.push([threads, "threads"]);
      for (const [targetAccountId, targetPostType] of targets) {
        const cp = await page.request.post(`/api/production-items/${id}/cross-post`, {
          data: { targetAccountId, targetPostType, assign: true, manual: true },
        });
        expect(cp.status(), await cp.text()).toBe(201);
      }
    }

    // Today's source, doing well, in the same format.
    const title = `E2E usual today ${stamp}`;
    const sourceId = await createSource(page, title, editorUserId);
    await sql`
      UPDATE production_items
      SET status = 'Published', format = ${format}, account_id = ${ig}, views = 5000,
          published_at = now() - interval '2 hours', enrichment_completed_at = now()
      WHERE id = ${sourceId}`;

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto("/starter-story/queue/cross-post");
    await page.getByRole("button", { name: title }).click();

    const usual = page.getByRole("button", { name: "Select usual (2)" });
    await expect(usual).toBeVisible({ timeout: 15_000 });
    // The moment worth seeing: the dialog as it opens, the button beside Select all.
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    await usual.click();

    await expect(page.getByRole("checkbox", { name: new RegExp(`e2e_tiktok_${stamp}`) })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: new RegExp(`e2e_x_${stamp}`) })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: new RegExp(`e2e_threads_${stamp}`) })).not.toBeChecked();
    // Once the usual set is checked the button steps aside.
    await expect(usual).toBeHidden();
  } finally {
    await sql.end();
  }
});
