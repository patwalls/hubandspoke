import { test, expect } from "@playwright/test";
import postgres from "postgres";

// A live LinkedIn post with no likes has no views estimate (LinkedIn never
// reports views; we estimate from likes). Its Views tile used to say
// "Reported" under a blank number, which read like a broken sync.
test("a LinkedIn post with no likes says why it has no views", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  try {
    const [post] = await sql<{ id: string }[]>`
      INSERT INTO production_items (title, brand, post_type, status, published_link, likes, comments, published_at, published_date, last_performance_sync_at)
      VALUES (${`E2E quiet linkedin ${stamp}`}, 'starter-story', 'linkedin', 'Published',
              ${`https://www.linkedin.com/posts/e2e_activity-${stamp}`}, NULL, 1,
              now() - interval '2 days', (now() - interval '2 days')::date, now() - interval '1 hour')
      RETURNING id`;

    await page.goto(`/starter-story/content/${post.id}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    await expect(page.getByText("LinkedIn doesn't report views · estimated once it has likes")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Reported", { exact: true })).toHaveCount(0);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E % ${stamp}`}`;
    await sql.end();
  }
});
