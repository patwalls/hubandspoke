import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Queue "Age" pill (flag `queueAge`, on for e2e@local.test): the triage tabs
// default to ideas from the last 30 days, name how many older ones they left
// out, and "Show older" switches to them. The e2e DB starts empty: two Idea
// rows are created through the API and one is aged 90 days in the DB.

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(90_000);

test("the queue shows the last 30 days and keeps older ideas one click away", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const recentTitle = `E2E fresh idea ${stamp}`;
    const oldTitle = `E2E stale idea ${stamp}`;
    const ids: Record<string, string> = {};
    for (const title of [recentTitle, oldTitle]) {
      const res = await page.request.post("/api/production-items", {
        data: { title, platform: ["tiktok"], postType: "tiktok", publishedDate: "2026-08-20", brand: "starter-story" },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      ids[title] = (await res.json()).id as string;
    }
    await sql`UPDATE production_items SET status = 'Idea' WHERE id IN ${sql([ids[recentTitle], ids[oldTitle]])}`;
    await sql`UPDATE production_items SET created_at = now() - interval '90 days' WHERE id = ${ids[oldTitle]}`;
    await sql`DELETE FROM content_events WHERE content_item_id = ${ids[oldTitle]} AND event_type = 'content_changed'`;

    await page.goto("/starter-story/queue");
    await expect(page.getByText(recentTitle)).toBeVisible({ timeout: 30_000 });
    // Default view: last 30 days. The stale row is left out and named.
    await expect(page.getByRole("button", { name: /Age.*Last 30 days/ })).toBeVisible();
    await expect(page.getByText(oldTitle)).toHaveCount(0);
    await expect(page.getByText(/older ideas? not shown/)).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    const marked = page.waitForRequest(
      (r) => r.url().endsWith("/api/usage") && (r.postData() ?? "").includes("queue:age:older"),
    );
    await page.getByRole("button", { name: "Show older" }).click();
    await marked;
    await expect(page.getByText(oldTitle)).toBeVisible();
    await expect(page.getByText(recentTitle)).toHaveCount(0);
    await expect(page).toHaveURL(/age=older/);

    // Any age brings both back.
    await page.getByRole("button", { name: /Age.*Older than 30 days/ }).click();
    await page.getByRole("option", { name: "Any age" }).or(page.getByText("Any age", { exact: true })).first().click();
    await expect(page.getByText(oldTitle)).toBeVisible();
    await expect(page.getByText(recentTitle)).toBeVisible();
  } finally {
    await sql.end();
  }
});
