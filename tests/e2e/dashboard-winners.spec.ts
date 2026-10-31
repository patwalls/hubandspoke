import { test, expect } from "@playwright/test";
import postgres from "postgres";
import type { Page } from "@playwright/test";

async function expandWinners(page: Page) {
  const toggle = page.getByTestId("winners-strip").getByRole("button", { name: /Beat their usual this week/ });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

// The brand dashboard names the week's posts that beat their own account's
// usual (views vs. that account + post type's 90-day median). A post at its
// usual stays off the list; a winner shows its "why it won" note; the winner
// opens its content page.
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
    // Written by the winner-notes cron on prod (Haiku); the e2e box has no LLM key.
    const winNote = {
      note: "Opens on a dollar figure instead of the founder's name, unlike the usual posts.",
      lift: 8.4,
      generatedAt: new Date().toISOString(),
      model: "e2e",
    };
    await sql`
      INSERT INTO production_items (title, brand, account_id, post_type, format, status, views, published_at, win_note)
      VALUES (${winnerTitle}, 'starter-story', ${account.id}, 'tiktok', 'Repackage Section w/ Hook', 'Published',
              8400, now() - interval '2 days', ${sql.json(winNote)}),
             (${usualTitle}, 'starter-story', ${account.id}, 'tiktok', NULL, 'Published',
              1100, now() - interval '1 day', NULL)`;

    await page.goto("/starter-story");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const strip = page.getByTestId("winners-strip");
    await expect(strip.getByRole("heading", { name: "Beat their usual this week" })).toBeVisible({
      timeout: 15_000,
    });
    // Collapsed by default: one line naming the top post, no list, no scoreboard
    // (the open list read as a junk drawer at the top of the dashboard).
    const toggle = strip.getByRole("button", { name: /Beat their usual this week/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toContainText(winnerTitle);
    await expect(strip.getByRole("link")).toHaveCount(0);
    await expect(page.getByTestId("format-scoreboard")).toHaveCount(0);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT.replace(/\.png$/, "-collapsed.png") });
    await toggle.click();
    const row = strip.getByRole("link", { name: new RegExp(winnerTitle) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("8.4×");
    await expect(row.getByTestId("win-note")).toHaveText(`Why: ${winNote.note}`);
    await expect(strip.getByText(usualTitle)).toHaveCount(0);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await row.click();
    await expect(page).toHaveURL(/\/starter-story\/content\/[0-9a-f-]{36}/);

    // Expanded is remembered on this browser.
    await page.goto("/starter-story");
    await expect(page.getByTestId("winners-strip").getByRole("link", { name: new RegExp(winnerTitle) })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E % ${stamp}`}`;
    await sql`DELETE FROM accounts WHERE handle = ${`e2e_winners_${stamp}`}`;
    await sql.end();
  }
});

// Facebook (like LinkedIn, Threads, Instagram photo posts) has no real view
// count — views are likes × 165. Those posts are judged and shown in likes,
// and a post with a handful of likes doesn't make the list on its estimate.
test("posts with estimated views are judged on likes", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  try {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'facebook', ${`e2e_winners_fb_${stamp}`} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    const post = (title: string, likes: number, daysAgo: number) => sql`
      INSERT INTO production_items (title, brand, account_id, post_type, status, likes, views, views_estimated, published_at)
      VALUES (${title}, 'starter-story', ${account.id}, 'facebook_post', 'Published',
              ${likes}, ${likes * 165}, true, now() - make_interval(days => ${daysAgo}))`;
    for (let i = 0; i < 6; i++) await post(`E2E fb baseline ${i} ${stamp}`, 2, 20 + i * 5);
    const hitTitle = `E2E fb hit ${stamp}`;
    const smallTitle = `E2E fb small ${stamp}`;
    await post(hitTitle, 120, 2); // 60× its usual 2 likes
    await post(smallTitle, 11, 1); // 5.5×, but only 11 likes (~1,800 estimated views)

    await page.goto("/starter-story");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const strip = page.getByTestId("winners-strip");
    await expandWinners(page);
    const row = strip.getByRole("link", { name: new RegExp(hitTitle) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("60×");
    await expect(row).toContainText("120 likes");
    await expect(strip.getByText(smallTitle)).toHaveCount(0);
    // No screenshot here: the first test's shot (with a "why it won" note) is the one to look at.
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E % ${stamp}`}`;
    await sql`DELETE FROM accounts WHERE handle = ${`e2e_winners_fb_${stamp}`}`;
    await sql.end();
  }
});

// Format scoreboard (M3): under the winners, the formats whose posts beat
// their usual most often over 4 weeks — a format that hits 2 of 3 outranks
// one lucky post in a format that usually doesn't. The Monday email (M4)
// carries the same winners and formats (admin preview).
test("the scoreboard ranks formats by how often they beat their usual, and the Monday email carries it", async ({
  page,
}) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  const steady = `E2E Steady ${stamp}`;
  const lucky = `E2E Lucky ${stamp}`;
  try {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'tiktok', ${`e2e_formats_${stamp}`} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    const post = (title: string, format: string | null, views: number, daysAgo: number) => sql`
      INSERT INTO production_items (title, brand, account_id, post_type, format, status, views, published_at)
      VALUES (${title}, 'starter-story', ${account.id}, 'tiktok', ${format}, 'Published', ${views},
              now() - make_interval(days => ${daysAgo}))`;
    // Baseline before the 28-day window: usual ~1,000 views.
    for (let i = 0; i < 6; i++) await post(`E2E fbase ${i} ${stamp}`, null, 950 + i * 20, 35 + i * 5);
    // Steady: 2 of 3 posts at 3×. Lucky: 1 of 4 at 20×.
    await post(`E2E s1 ${stamp}`, steady, 3_000, 3);
    await post(`E2E s2 ${stamp}`, steady, 3_000, 10);
    await post(`E2E s3 ${stamp}`, steady, 900, 15);
    await post(`E2E l1 ${stamp}`, lucky, 20_000, 2);
    for (let i = 2; i <= 4; i++) await post(`E2E l${i} ${stamp}`, lucky, 800, 5 + i * 3);

    await page.goto("/starter-story");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    await expandWinners(page);
    const board = page.getByTestId("format-scoreboard");
    await expect(board.getByRole("heading", { name: "Formats that keep beating their usual" })).toBeVisible({
      timeout: 15_000,
    });
    const rows = board.getByRole("listitem");
    const steadyRow = rows.filter({ hasText: steady });
    const luckyRow = rows.filter({ hasText: lucky });
    await expect(steadyRow).toContainText("2 of 3 posts");
    await expect(luckyRow).toContainText("1 of 4 posts");
    const order = await rows.allTextContents();
    expect(order.findIndex((t) => t.includes(steady))).toBeLessThan(order.findIndex((t) => t.includes(lucky)));
    if (process.env.E2E_SHOT) await board.screenshot({ path: process.env.E2E_SHOT.replace(/\.png$/, "-formats.png") });

    // The Monday email preview (the e2e user has the winnersEmail flag).
    await page.goto("/api/winners-email/preview");
    await expect(page.getByRole("link", { name: `E2E l1 ${stamp}` })).toBeVisible();
    await expect(page.getByText(`${steady}: 2 of 3 posts (best 3.0×)`)).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT.replace(/\.png$/, "-email.png"), fullPage: true });
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E % ${stamp}`}`;
    await sql`DELETE FROM accounts WHERE handle = ${`e2e_formats_${stamp}`}`;
    await sql.end();
  }
});
