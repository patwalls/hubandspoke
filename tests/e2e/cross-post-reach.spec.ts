import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// The cross-post picker (post page's Cross-post tab and the cross-post
// queue's dialog) shows what each target typically gets over the last 30 days: TikTok (6 posts, ~1.5K views) reads "~1.5K views"; X (6
// posts, 4 with 0 likes) adds "mostly no likes"; Threads (2 posts) is too
// new to say anything.
async function createItem(page: Page, title: string, editorUserId: string): Promise<string> {
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
  return (await res.json()).id as string;
}

// Seeds four target accounts with 30 days of history and today's
// doing-well Instagram source in a fresh format (three quiet earlier posts in
// it, published 40 days ago, so the queue sees the source as hot).
async function seedReach(page: Page, sql: postgres.Sql) {
  const stamp = Date.now();
  const format = `E2E Reach ${stamp}`;
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
  const tiktok = await account("tiktok");
  const x = await account("x");
  const threads = await account("threads");

  // Published history on each target (days ago, views, likes).
  const history: Array<[string, string, number, number, number]> = [];
  for (let i = 0; i < 6; i++) history.push([tiktok, "tiktok", i + 1, 1000 + i * 200, 20]);
  for (let i = 0; i < 6; i++) history.push([x, "x", i + 1, 60 + i, i < 4 ? 0 : 3]);
  for (let i = 0; i < 2; i++) history.push([threads, "threads", i + 1, 5000, 50]);
  let n = 0;
  for (const [accountId, postType, daysAgo, views, likes] of history) {
    const id = await createItem(page, `E2E reach history ${n++} ${stamp}`, editorUserId);
    await sql`
      UPDATE production_items
      SET status = 'Published', account_id = ${accountId}, post_type = ${postType},
          views = ${views}, likes = ${likes},
          published_link = ${`https://example.com/${stamp}/${n}`},
          published_date = (now() - make_interval(days => ${daysAgo}))::date,
          published_at = now() - make_interval(days => ${daysAgo})
      WHERE id = ${id}`;
  }

  for (let i = 0; i < 3; i++) {
    const id = await createItem(page, `E2E reach earlier ${i} ${stamp}`, editorUserId);
    await sql`
      UPDATE production_items
      SET status = 'Published', format = ${format}, account_id = ${ig}, views = 10,
          published_at = now() - interval '40 days', enrichment_completed_at = now()
      WHERE id = ${id}`;
  }

  // Today's source on Instagram, with media on hand so the tab is enabled.
  const title = `E2E reach source ${stamp}`;
  const sourceId = await createItem(page, title, editorUserId);
  await sql`
    UPDATE production_items
    SET status = 'Published', format = ${format}, account_id = ${ig}, views = 5000,
        published_at = now() - interval '2 hours', enrichment_completed_at = now(),
        descript_composition_id = ${`e2e-${stamp}`}
    WHERE id = ${sourceId}`;
  return { stamp, title, sourceId };
}

function dismissWhatsNew(page: Page) {
  const popup = page.getByRole("dialog", { name: "What's new" });
  return page.addLocatorHandler(popup, async () => {
    await popup.getByRole("button", { name: "Got it" }).click();
  });
}

async function expectReach(page: Page, stamp: number) {
  const row = (handle: string) =>
    page.locator("label").filter({ has: page.getByRole("checkbox", { name: new RegExp(handle) }) });
  const tiktokReach = row(`e2e_tiktok_${stamp}`).getByTestId("cross-post-reach");
  await expect(tiktokReach).toHaveText("~1.5K views", { timeout: 15_000 });
  await expect(tiktokReach).toHaveAttribute("title", /6 posts here, typical post 1,500 views/);

  const xReach = row(`e2e_x_${stamp}`).getByTestId("cross-post-reach");
  await expect(xReach).toHaveText("~63 views · mostly no likes");
  await expect(xReach).toHaveAttribute("title", /4 of 6 got no likes/);

  await expect(row(`e2e_threads_${stamp}`).getByTestId("cross-post-reach")).toHaveCount(0);
}

test("the Cross-post tab shows each account's typical reach", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const { stamp, sourceId } = await seedReach(page, sql);
    await dismissWhatsNew(page);
    await page.goto(`/starter-story/content/${sourceId}?tab=cross-post`);
    await expectReach(page, stamp);
  } finally {
    await sql.end();
  }
});

// The cross-post queue's picker (same panel, opened from a hot post) carries
// the same labels, from the queue's own payload.
test("the cross-post queue's picker shows each account's typical reach", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const { stamp, title } = await seedReach(page, sql);
    await dismissWhatsNew(page);
    await page.goto("/starter-story/queue/cross-post");
    if (process.env.E2E_SHOT) {
      await expect(page.getByRole("button", { name: title })).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: process.env.E2E_SHOT.replace(/\.png$/, "-before.png"), fullPage: true });
    }
    await page.getByRole("button", { name: title }).click();
    await expectReach(page, stamp);
    if (process.env.E2E_SHOT) {
      await page.waitForTimeout(500);
      await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    }
  } finally {
    await sql.end();
  }
});
