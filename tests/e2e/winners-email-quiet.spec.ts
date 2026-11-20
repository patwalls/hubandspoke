import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The Monday winners email names, per brand, the channels where most of 10+
// posts in the last 30 days got no likes (channels-worth-it M4), under the
// brand's winners, with a link to its accounts page. Checked on the email's
// own preview route (flag-gated; the e2e user is on the flag).
test("the Monday email lists a brand's quiet channels", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  const tiktok = `e2e_win_${stamp}`;
  const facebook = `e2e_quiet_${stamp}`;
  try {
    const [tt] = await sql<{ id: string }[]>`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'tiktok', ${tiktok} FROM brands WHERE slug = 'starter-story' RETURNING id`;
    const [fb] = await sql<{ id: string }[]>`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'facebook', ${facebook} FROM brands WHERE slug = 'starter-story' RETURNING id`;
    // A winner, so the email sends at all: six ~1,000-view posts, then 8,400.
    for (let i = 0; i < 6; i++) {
      await sql`
        INSERT INTO production_items (title, brand, account_id, post_type, status, views, published_at)
        VALUES (${`E2E baseline ${i} ${stamp}`}, 'starter-story', ${tt.id}, 'tiktok', 'Published',
                ${900 + i * 40}, now() - make_interval(days => ${20 + i * 5}))`;
    }
    await sql`
      INSERT INTO production_items (title, brand, account_id, post_type, status, views, published_at)
      VALUES (${`E2E winner ${stamp}`}, 'starter-story', ${tt.id}, 'tiktok', 'Published', 8400, now() - interval '2 days')`;
    // A quiet Facebook page: 12 posts in the last 30 days, 8 with no likes.
    for (let i = 0; i < 12; i++) {
      await sql`
        INSERT INTO production_items (title, brand, account_id, post_type, status, views, likes,
                                      published_link, published_date, published_at)
        VALUES (${`E2E fb ${i} ${stamp}`}, 'starter-story', ${fb.id}, 'facebook_post', 'Published', 40,
                ${i < 8 ? 0 : 3}, ${`https://facebook.com/e2e/${stamp}/${i}`},
                (now() - make_interval(days => ${1 + i}))::date, now() - make_interval(days => ${1 + i}))`;
    }

    await page.goto("/api/winners-email/preview");
    await expect(page.getByText(`E2E winner ${stamp}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Mostly no likes (last 30 days)")).toBeVisible();
    await expect(page.getByText(new RegExp(`@${facebook} .+: 8 of 12 posts got none`))).toBeVisible();
    await expect(page.getByRole("link", { name: "accounts" })).toHaveAttribute("href", /\/starter-story\/accounts$/);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E % ${stamp}`}`;
    await sql`DELETE FROM accounts WHERE handle IN (${tiktok}, ${facebook})`;
    await sql.end();
  }
});
