import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The post page's Views card says how the post did against its own account's
// usual (the median of the same account + post type in the 90 days before
// it): a post that beat it says "N× its usual" in green; one at its usual
// just names the usual — never a below-usual ratio. A winner's "why it won"
// note shows under it; a note left on a post that no longer wins does not.
test("the post page says when a post beat its account's usual", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  try {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'tiktok', ${`e2e_usual_${stamp}`} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    // Baseline: six posts 20–45 days old at ~1,000 views (median 1,000).
    for (let i = 0; i < 6; i++) {
      await sql`
        INSERT INTO production_items (title, brand, account_id, post_type, status, views, published_at)
        VALUES (${`E2E baseline ${i} ${stamp}`}, 'starter-story', ${account.id}, 'tiktok', 'Published',
                ${900 + i * 40}, now() - make_interval(days => ${20 + i * 5}))`;
    }
    const note = (text: string) => sql.json({ note: text, lift: 8.4, generatedAt: new Date().toISOString(), model: "e2e" });
    const [winner] = await sql<{ id: string }[]>`
      INSERT INTO production_items (title, brand, account_id, post_type, status, published_link, views, published_at, win_note)
      VALUES (${`E2E winner ${stamp}`}, 'starter-story', ${account.id}, 'tiktok', 'Published', ${`https://www.tiktok.com/@e2e/video/${stamp}1`}, 8400, now() - interval '2 days',
              ${note("Opened on the exact revenue number instead of the founder's name.")})
      RETURNING id`;
    // A stale note (written when it won, lift since faded) must not show.
    const [usual] = await sql<{ id: string }[]>`
      INSERT INTO production_items (title, brand, account_id, post_type, status, published_link, views, published_at, win_note)
      VALUES (${`E2E usual ${stamp}`}, 'starter-story', ${account.id}, 'tiktok', 'Published', ${`https://www.tiktok.com/@e2e/video/${stamp}2`}, 1100, now() - interval '1 day',
              ${note("A stale note that should stay hidden.")})
      RETURNING id`;

    await page.goto(`/starter-story/content/${winner.id}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const line = page.getByTestId("views-against-usual");
    await expect(line).toBeVisible({ timeout: 15_000 });
    await expect(line).toContainText("8.4× its usual");
    await expect(line).toContainText("usual 1K");
    await expect(page.getByTestId("why-it-won")).toContainText("Why it won: Opened on the exact revenue number");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await page.goto(`/starter-story/content/${usual.id}`);
    const plain = page.getByTestId("views-against-usual");
    await expect(plain).toBeVisible({ timeout: 15_000 });
    await expect(plain).toContainText(/usual 1(\.\d)?K/);
    await expect(plain).not.toContainText("its usual");
    await expect(page.getByTestId("why-it-won")).toHaveCount(0);
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E % ${stamp}`}`;
    await sql`DELETE FROM accounts WHERE handle = ${`e2e_usual_${stamp}`}`;
    await sql.end();
  }
});
