import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Ticking the first cross-post target warms the source (enrichment / media
// archive) in the background, once per candidate, so the "Cross-post N"
// click doesn't wait on it. A ready source makes the warm-up a no-op.
test("first target tick warms the source once", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
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
    await account("tiktok");
    await account("x");

    const title = `E2E prepare ${stamp}`;
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
    const sourceId = (await res.json()).id as string;
    await sql`
      UPDATE production_items
      SET status = 'Published', account_id = ${ig}, views = 5000,
          media_s3_key = ${`e2e/${stamp}.mp4`},
          published_at = now() - interval '2 hours', enrichment_completed_at = now()
      WHERE id = ${sourceId}`;

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    const prepareCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/cross-post-prepare")) prepareCalls.push(r.url());
    });

    await page.goto("/starter-story/queue/cross-post");
    await page.getByRole("button", { name: title }).click();

    const tiktok = page.getByRole("checkbox", { name: new RegExp(`e2e_tiktok_${stamp}`) });
    await expect(tiktok).toBeVisible({ timeout: 15_000 });
    // Opening the dialog alone spends nothing.
    expect(prepareCalls).toHaveLength(0);

    const warm = page.waitForResponse((r) => r.url().includes(`/${sourceId}/cross-post-prepare`));
    await tiktok.check();
    const warmRes = await warm;
    expect(warmRes.status()).toBe(200);
    expect(await warmRes.json()).toEqual({ ok: true, enriched: false });

    await page.getByRole("checkbox", { name: new RegExp(`e2e_x_${stamp}`) }).check();
    await page.waitForTimeout(300);
    expect(prepareCalls).toHaveLength(1);

    if (process.env.E2E_SHOT) {
      await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    }
  } finally {
    await sql.end();
  }
});
