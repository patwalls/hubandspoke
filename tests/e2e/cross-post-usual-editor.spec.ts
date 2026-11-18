import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// A cross-post target whose last five cross-posts were all handed to one
// editor (the Shorts editor) goes straight to them: the picker's row says
// "→ <first name>", and that target's new item is assigned to them while the
// other targets get the "Assign to" pick. Flag `crossPostUsualEditor`
// (e2e@local.test is on its allowlist).
function dismissWhatsNew(page: Page) {
  const popup = page.getByRole("dialog", { name: "What's new" });
  return page.addLocatorHandler(popup, async () => {
    await popup.getByRole("button", { name: "Got it" }).click();
  });
}

test("a target whose cross-posts always go to one editor is assigned to them", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  const tag = `E2E usual-editor ${stamp}`;
  try {
    const session = await (await page.request.get("/api/auth/session")).json();
    const meId = session?.user?.id as string;
    const meName = (session?.user?.name as string | undefined) ?? "";
    expect(meId).toBeTruthy();

    const [shorts] = await sql`
      INSERT INTO users (email, name) VALUES (${`e2e-shorts-${stamp}@local.test`}, ${`Shortsy Editor${stamp}`})
      RETURNING id`;
    const account = async (platform: string) => {
      const [row] = await sql`
        INSERT INTO accounts (brand_id, platform, handle)
        SELECT id, ${platform}, ${`e2e_${platform}_${stamp}`} FROM brands WHERE slug = 'starter-story'
        RETURNING id`;
      return row.id as string;
    };
    const ig = await account("instagram");
    const youtube = await account("youtube");
    await account("tiktok");

    // History: five Shorts cross-posts, each made by me and handed to the
    // Shorts editor. TikTok has no habit.
    for (let i = 0; i < 5; i++) {
      const [cp] = await sql`
        INSERT INTO production_items (title, brand, account_id, post_type, source_type, status, editor_user_id, created_at)
        VALUES (${`${tag} earlier ${i}`}, 'starter-story', ${youtube}, 'youtube_shorts', 'cross_post', 'Published',
                ${shorts.id}, now() - make_interval(hours => ${i + 1}))
        RETURNING id`;
      await sql`
        INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
        VALUES (${cp.id}, ${meId}, 'item_created', ${sql.json({ type: "item_created", source: "api:cross-post" })},
                now() - make_interval(hours => ${i + 1}))`;
    }

    // Today's source, with media on hand so its Cross-post tab is enabled.
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `${tag} today`,
        platform: ["instagram_reel"],
        postType: "instagram_reel",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
        editorUserId: meId,
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const sourceId = (await res.json()).id as string;
    await sql`
      UPDATE production_items
      SET status = 'Published', account_id = ${ig}, views = 5000,
          published_at = now() - interval '2 hours', enrichment_completed_at = now(),
          descript_composition_id = ${`e2e-${stamp}`}
      WHERE id = ${sourceId}`;

    await dismissWhatsNew(page);
    await page.goto(`/starter-story/content/${sourceId}?tab=cross-post`);

    const shortsRow = page.getByRole("checkbox", { name: new RegExp(`e2e_youtube_${stamp}.*Short`) });
    await expect(shortsRow).toBeVisible({ timeout: 20_000 });
    const note = page.getByTestId("cross-post-usual-editor");
    await expect(note).toHaveCount(1);
    await expect(note).toHaveText("→ Shortsy");

    await shortsRow.check();
    await page.getByRole("checkbox", { name: new RegExp(`e2e_tiktok_${stamp}`) }).check();
    const assignTo = page.getByText("Assign to", { exact: true }).locator("..");
    await assignTo.getByLabel("Assignee").click();
    const esc = (meName || "E2E").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.getByRole("option", { name: new RegExp(esc) }).first().click();
    // Picking the Shorts editor in "Assign to" would make the note redundant;
    // picking anyone else keeps it.
    await expect(note).toHaveText("→ Shortsy");
    if (process.env.E2E_SHOT) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    }
    await page.getByRole("button", { name: "Cross-post 2 selected" }).click();

    await expect
      .poll(async () => {
        const rows = await sql`
          SELECT a.platform, p.editor_user_id FROM production_items p JOIN accounts a ON a.id = p.account_id
           WHERE p.reposted_from_item_id = ${sourceId} AND p.source_type = 'cross_post'`;
        return Object.fromEntries(rows.map((r) => [r.platform, r.editor_user_id]));
      }, { timeout: 20_000 })
      .toEqual({ youtube: shorts.id, tiktok: meId });
  } finally {
    await sql`DELETE FROM production_items WHERE reposted_from_item_id IN (SELECT id FROM production_items WHERE title LIKE ${`${tag}%`})`;
    await sql`DELETE FROM production_items WHERE title LIKE ${`${tag}%`}`;
    await sql`DELETE FROM accounts WHERE handle LIKE ${`e2e_%_${stamp}`}`;
    await sql`DELETE FROM users WHERE email = ${`e2e-shorts-${stamp}@local.test`}`;
    await sql.end();
  }
});
