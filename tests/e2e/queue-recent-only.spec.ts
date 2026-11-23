import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Recent-only queue report (flag `queueRecentOnly`, on for e2e@local.test):
// the queue's default "Last 30 days" view loads only recent Idea rows and the
// server's count of the older ones; "Show older" fetches the full report.
// The e2e DB starts empty: three Idea rows are created through the API and two
// are aged 90 days in the DB.

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(90_000);

test("the default queue view loads recent ideas only and still counts the older ones", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const titles = [`E2E recent ${stamp}`, `E2E aged A ${stamp}`, `E2E aged B ${stamp}`];
    const ids: string[] = [];
    for (const title of titles) {
      const res = await page.request.post("/api/production-items", {
        data: { title, platform: ["tiktok"], postType: "tiktok", publishedDate: "2026-08-20", brand: "starter-story" },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      ids.push((await res.json()).id as string);
    }
    const [, ...staleIds] = ids;
    await sql`UPDATE production_items SET status = 'Idea' WHERE id IN ${sql(ids)}`;
    await sql`UPDATE production_items SET created_at = now() - interval '90 days' WHERE id IN ${sql(staleIds)}`;
    await sql`DELETE FROM content_events WHERE content_item_id IN ${sql(staleIds)} AND event_type = 'content_changed'`;

    // The API: recent-only payload has no aged rows, and counts them.
    const api = await page.request.get("/api/reports/production?brand=starter-story&ideas=recent");
    expect(api.ok()).toBeTruthy();
    const report = (await api.json()) as { items: { id: string }[]; olderIdeas?: { total: number } };
    const apiIds = new Set(report.items.map((i) => i.id));
    expect(apiIds.has(ids[0])).toBe(true);
    for (const id of staleIds) expect(apiIds.has(id)).toBe(false);
    expect(report.olderIdeas?.total).toBeGreaterThanOrEqual(2);

    await page.goto("/starter-story/queue");
    await expect(page.getByText(titles[0])).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(titles[1])).toHaveCount(0);
    await expect(page.getByText(/\d+ older ideas? not shown/)).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    // One click away, as before: the full report loads and the aged rows show.
    await page.getByRole("button", { name: "Show older" }).click();
    await expect(page.getByText(titles[1])).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(titles[2])).toBeVisible();
  } finally {
    await sql.end();
  }
});
