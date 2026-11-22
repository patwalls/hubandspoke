import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Publishing happens from the post page: open the post, copy its caption,
// post it natively, paste the live link back. The caption used to be
// hand-selected out of a long textarea every time; the post page now has a
// quiet "Copy caption" link under it.

test("the post page copies the caption in one click", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E publish kit ${stamp}`,
        platform: ["instagram_reel"],
        postType: "instagram_reel",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    const caption = `He built an app in a week ${stamp}.\n\nNow it pays his rent.`;
    await sql`UPDATE production_items SET status = 'Ready To Publish', enrichment_completed_at = now() WHERE id = ${id}`;
    await sql`
      INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
      VALUES (${id}, 1, true, ${sql.json({ caption })}, ${sql.json({ version: 1, fields: [] })}, 'user')`;

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${id}`);

    const copy = page.getByRole("button", { name: "Copy caption", exact: true });
    await expect(copy).toBeVisible({ timeout: 15_000 });
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: false });

    await copy.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(caption);
    await expect.poll(async () => {
      const [r] = await sql`SELECT count(*)::int AS n FROM usage_events WHERE screen = 'content:caption-copied'`;
      return r.n as number;
    }).toBeGreaterThan(0);
  } finally {
    await sql.end();
  }
});

// The copy link used to exist only on Instagram, X, LinkedIn/Facebook and
// TikTok. Threads, YouTube (title + description) and YouTube Community had
// none, and the CTA reply / pinned comment had to be hand-selected on every
// platform that has one.
async function makePost(
  page: import("@playwright/test").Page,
  sql: postgres.Sql,
  postType: string,
  content: Record<string, string>,
) {
  const res = await page.request.post("/api/production-items", {
    data: {
      title: `E2E copy ${postType} ${Date.now()}`,
      platform: [postType],
      postType,
      publishedDate: new Date().toISOString().slice(0, 10),
      brand: "starter-story",
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const id = (await res.json()).id as string;
  await sql`UPDATE production_items SET status = 'Ready To Publish', enrichment_completed_at = now() WHERE id = ${id}`;
  await sql`
    INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
    VALUES (${id}, 1, true, ${sql.json(content)}, ${sql.json({ version: 1, fields: [] })}, 'user')`;
  return id;
}

async function expectCopies(
  page: import("@playwright/test").Page,
  sql: postgres.Sql,
  label: string,
  text: string,
  mark: string,
) {
  const btn = page.getByRole("button", { name: label, exact: true });
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await btn.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  await expect.poll(async () => {
    const [r] = await sql`SELECT count(*)::int AS n FROM usage_events WHERE screen = ${mark}`;
    return r.n as number;
  }).toBeGreaterThan(0);
}

test("Threads, YouTube and CTA replies copy in one click too", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });

    const post = "She quit her job to sell candles.\n\nNow it's $40K a month.";
    const cta = "Full story: starterstory.com/candles";
    const threadsId = await makePost(page, sql, "threads", { post, cta });
    await page.goto(`/starter-story/content/${threadsId}`);
    await expect(page.getByRole("button", { name: "Copy post", exact: true })).toBeVisible({ timeout: 15_000 });
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: false });
    await expectCopies(page, sql, "Copy post", post, "content:caption-copied");
    await expectCopies(page, sql, "Copy reply", cta, "content:cta-copied");

    const title = "He built a $1M app alone";
    const description = "The full breakdown of how he did it.";
    const shortsId = await makePost(page, sql, "youtube_shorts", { title, description });
    await page.goto(`/starter-story/content/${shortsId}`);
    await expectCopies(page, sql, "Copy title", title, "content:title-copied");
    await expectCopies(page, sql, "Copy description", description, "content:caption-copied");
  } finally {
    await sql.end();
  }
});
