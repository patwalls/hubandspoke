import { test, expect } from "@playwright/test";
import postgres from "postgres";

// content-list-fast M4: open a post from the Content list and step through
// that list from the post (‹ 2 of 5 ›, j / k) without going back to it.
test("a post opened from the Content list steps through that list", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  const handle = `e2e_step_${stamp}`;
  const title = (i: number) => `E2E step ${String(i).padStart(2, "0")} ${stamp}`;
  try {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'youtube', ${handle} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    // Five posts, one per day, newest first in the list's default sort.
    for (let i = 0; i < 5; i++) {
      await sql`
        INSERT INTO production_items (title, brand, account_id, post_type, status, views,
                                      published_date, published_at)
        VALUES (${title(i)}, 'starter-story', ${account.id},
                'youtube_shorts', 'Published', ${1000 + i},
                current_date - ${i}::int, now() - make_interval(days => ${i}))`;
    }

    // A range only this run asks for (the report is cached per params).
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await page.goto(`/starter-story/content?startDate=${day(-20)}&endDate=${day(1 + (stamp % 600))}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});

    await page.getByRole("link", { name: title(1) }).click({ timeout: 15_000 });
    await page.waitForURL(/\/starter-story\/content\/[0-9a-f-]{36}/);

    const run = page.getByTestId("production-run");
    await expect(run.getByTestId("production-run-position")).toHaveText("2 of 5", { timeout: 15_000 });
    await expect(run.getByRole("link", { name: "← Content" })).toBeVisible();
    await expect(page.locator("h1:visible", { hasText: title(1) })).toBeVisible();

    // The moment worth seeing: the post, with where you are in the list.
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    // j steps to the next row in the list's order, k back.
    await page.keyboard.press("j");
    await expect(run.getByTestId("production-run-position")).toHaveText("3 of 5", { timeout: 15_000 });
    await expect(page.locator("h1:visible", { hasText: title(2) })).toBeVisible();
    await run.getByRole("link", { name: "Previous" }).click();
    await expect(run.getByTestId("production-run-position")).toHaveText("2 of 5", { timeout: 15_000 });

    // The back link goes to the Content list, not In Production.
    await run.getByRole("link", { name: "← Content" }).click();
    await page.waitForURL(/\/starter-story\/content\?/);
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E step % ${stamp}`}`;
    await sql`DELETE FROM accounts WHERE handle = ${handle}`;
    await sql.end();
  }
});
