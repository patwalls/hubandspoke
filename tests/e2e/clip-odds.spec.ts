import { test, expect } from "@playwright/test";
import postgres from "postgres";

// clip-odds M2–M3: a video's Clip Ideas list shows EVERY format's newest
// batch (it used to show only the last format generated), best odds first —
// the format whose recent clips beat the account's usual most often — with an
// "N/M beat usual" line per idea, and the clip dialog says why. Seeded on a
// throwaway platform name so the account's "usual" is exactly ours.
test.setTimeout(150_000);

test("a video's clip ideas list every format, best odds first, with the why", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Odds ${Date.now()}`;
  const platform = `${tag} Reel`;
  const winner = `${tag} Winner`;
  const loser = `${tag} Loser`;
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  try {
    // The account's usual post on this platform: 100 views.
    for (let ago = 10; ago <= 90; ago += 10) {
      await sql`INSERT INTO production_items (title, brand, status, platform, views, published_date, format)
        VALUES (${`${tag} usual ${ago}`}, 'starter-story', 'Published', ${sql.json([platform])}, 100, ${day(ago)}, ${`${tag} Pillar`})`;
    }
    // Six recent clips per format: the winner's all beat it, the loser's none.
    for (let ago = 1; ago <= 6; ago++) {
      for (const [format, views] of [[winner, 1000], [loser, 10]] as const) {
        await sql`INSERT INTO production_items (title, brand, status, platform, views, published_date, format)
          VALUES (${`${tag} clip`}, 'starter-story', 'Published', ${sql.json([platform])}, ${views}, ${day(ago)}, ${format})`;
      }
    }
    const [pillar] = await sql`
      INSERT INTO production_items (title, brand, status, media_s3_key, published_date) VALUES (${`${tag} pillar`}, 'starter-story', 'Published', 'e2e/none.mp4', ${day(0)}) RETURNING id`;
    await sql`INSERT INTO transcripts (production_item_id, full_text, segments)
      VALUES (${pillar.id}, 'hello there', ${sql.json([{ startSec: 0, endSec: 900, text: "hello there" }])})`;
    // The loser's idea comes EARLIER in the video and was generated LAST:
    // before, the list showed only this batch, and by the writer's number.
    for (const [hook, format, start, est, at] of [
      ["Winner", winner, 500, 1000, "1 hour"],
      ["Loser", loser, 10, 900000, "0 hours"],
    ] as const) {
      const [idea] = await sql`INSERT INTO clip_ideas (source_production_item_id, batch_id, start_sec, end_sec, hook, angle, rationale, generated_by, target_format, estimated_views, created_at)
        VALUES (${pillar.id}, gen_random_uuid(), ${start}, ${start + 40}, ${`${hook} hook`}, 'e2e', ${`${hook} rationale`}, 'e2e', ${format}, ${est}, now() - ${at}::interval) RETURNING id`;
      // Its Queue row (what generation creates alongside the idea).
      await sql`INSERT INTO production_items (title, brand, status, format, platform, source_clip_idea_id, pillar_content_item_id)
        VALUES (${`${tag} ${hook} row`}, 'starter-story', 'Idea', ${format}, ${sql.json([platform])}, ${idea.id}, ${pillar.id})`;
    }

    await page.goto(`/starter-story/content/${pillar.id}?tab=clip-ideas`);
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    const items = page.locator("ol > li");
    await expect(items).toHaveCount(2, { timeout: 15000 });
    await expect(items.nth(0)).toContainText("Winner hook");
    await expect(items.nth(0).getByTestId("clip-odds")).toHaveText("6/6 beat usual");
    await expect(items.nth(1)).toContainText("Loser hook");
    await expect(items.nth(1).getByTestId("clip-odds")).toHaveText("0/6 beat usual");
    await expect(page.getByText("· best odds first")).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    // The clip dialog says why.
    await items.nth(0).click();
    const why = page.getByTestId("clip-odds-why");
    await expect(why).toContainText(`6 of the last 6 ${winner} clips beat this account's usual ${platform} post`);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT.replace(/\.png$/, "-dialog.png") });

    // The Queue: same video, winner's row first, each with its chip. (The
    // report is cached 60 s, so give it one reload past the cache.)
    await page.keyboard.press("Escape");
    const winnerRow = page.locator("tr", { hasText: `${tag} Winner row` });
    await page.goto("/starter-story/queue");
    if (!(await winnerRow.isVisible({ timeout: 8000 }).catch(() => false))) {
      await page.waitForTimeout(61_000);
      await page.reload();
    }
    await expect(winnerRow.getByTestId("clip-odds")).toHaveText("6/6 beat usual", { timeout: 15000 });
    const rows = page.locator("tr", { hasText: tag });
    await expect(rows.nth(0)).toContainText("Winner row");
    await expect(rows.nth(1)).toContainText("Loser row");
    await expect(rows.nth(1).getByTestId("clip-odds")).toHaveText("0/6 beat usual");
    if (process.env.E2E_SHOT) await winnerRow.screenshot({ path: process.env.E2E_SHOT.replace(/\.png$/, "-queue.png") });
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`${tag}%`}`;
    await sql.end();
  }
});
