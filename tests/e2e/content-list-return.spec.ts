import { test, expect } from "@playwright/test";
import postgres from "postgres";

// content-list-fast M3: open a post far down the Content list, come back, and
// the list is where you left it with that row flashed — not at the top.
test("Content list comes back to where you were and flashes the row you opened", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  const handle = `e2e_return_${stamp}`;
  try {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'youtube', ${handle} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    // 60 posts, one per day, newest first in the list's default sort.
    for (let i = 0; i < 60; i++) {
      await sql`
        INSERT INTO production_items (title, brand, account_id, post_type, status, views,
                                      published_date, published_at)
        VALUES (${`E2E return ${String(i).padStart(2, "0")} ${stamp}`}, 'starter-story', ${account.id},
                'youtube_shorts', 'Published', ${1000 + i},
                current_date - ${i}::int, now() - make_interval(days => ${i}))`;
    }

    // A range only this run asks for (the report is cached per params).
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const start = day(-70);
    const end = day(1 + (stamp % 600));
    await page.goto(`/starter-story/content?startDate=${start}&endDate=${end}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});

    const title = `E2E return 45 ${stamp}`;
    const link = page.getByRole("link", { name: title });
    await link.scrollIntoViewIfNeeded({ timeout: 15_000 });
    const yBefore = await page.evaluate(() => window.scrollY);
    expect(yBefore).toBeGreaterThan(400);

    await link.click();
    await page.waitForURL(/\/starter-story\/content\/[0-9a-f-]{36}/);
    await page.goBack();
    await page.waitForURL(/\/starter-story\/content\?/);

    const row = page.locator("tr", { hasText: title });
    await expect(row).toHaveAttribute("data-returned", "true", { timeout: 10_000 });
    await expect(row).toBeInViewport();
    const yAfter = await page.evaluate(() => window.scrollY);
    expect(Math.abs(yAfter - yBefore)).toBeLessThan(200);

    // The moment worth seeing: back where you were, the row flashed.
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    // The flash fades; a second visit lands normally (the spot is used once).
    await expect(row).not.toHaveAttribute("data-returned", "true", { timeout: 5_000 });
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E return % ${stamp}`}`;
    await sql`DELETE FROM accounts WHERE handle = ${handle}`;
    await sql.end();
  }
});
