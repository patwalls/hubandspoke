import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The brand dashboard names the week's posts that beat their own account's
// usual (views vs. that account + post type's 90-day median). A post at its
// usual stays off the list; the winner opens its content page.
test("the dashboard shows posts that beat their usual this week", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  try {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'tiktok', ${`e2e_winners_${stamp}`} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    // Baseline: six posts 20–45 days old at ~1,000 views.
    for (let i = 0; i < 6; i++) {
      await sql`
        INSERT INTO production_items (title, brand, account_id, post_type, status, views, published_at)
        VALUES (${`E2E baseline ${i} ${stamp}`}, 'starter-story', ${account.id}, 'tiktok', 'Published',
                ${900 + i * 40}, now() - make_interval(days => ${20 + i * 5}))`;
    }
    const winnerTitle = `E2E winner ${stamp}`;
    const usualTitle = `E2E usual ${stamp}`;
    await sql`
      INSERT INTO production_items (title, brand, account_id, post_type, format, status, views, published_at)
      VALUES (${winnerTitle}, 'starter-story', ${account.id}, 'tiktok', 'Repackage Section w/ Hook', 'Published',
              8400, now() - interval '2 days'),
             (${usualTitle}, 'starter-story', ${account.id}, 'tiktok', NULL, 'Published',
              1100, now() - interval '1 day')`;

    await page.goto("/starter-story");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const strip = page.getByTestId("winners-strip");
    await expect(strip.getByRole("heading", { name: "Beat their usual this week" })).toBeVisible({
      timeout: 15_000,
    });
    const row = strip.getByRole("link", { name: new RegExp(winnerTitle) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("8.4×");
    await expect(strip.getByText(usualTitle)).toHaveCount(0);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await row.click();
    await expect(page).toHaveURL(/\/starter-story\/content\/[0-9a-f-]{36}/);
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E % ${stamp}`}`;
    await sql`DELETE FROM accounts WHERE handle = ${`e2e_winners_${stamp}`}`;
    await sql.end();
  }
});
