import { test, expect } from "@playwright/test";
import postgres from "postgres";

// "Kill all older ideas" (flag `queueClearOlder`, on for e2e@local.test): on
// the queue's Older view, one link asks the server how many Idea rows are
// older than 30 days, takes one kill reason, and kills them in one pass —
// leaving recent ideas alone. The e2e DB starts empty: three Idea rows are
// created through the API and two are aged 90 days in the DB.

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(90_000);

test("the Older view kills every older idea in one pass and leaves recent ones", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const titles = [`E2E fresh ${stamp}`, `E2E stale A ${stamp}`, `E2E stale B ${stamp}`];
    const ids: string[] = [];
    for (const title of titles) {
      const res = await page.request.post("/api/production-items", {
        data: { title, platform: ["tiktok"], postType: "tiktok", publishedDate: "2026-08-20", brand: "starter-story" },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      ids.push((await res.json()).id as string);
    }
    const [freshId, ...staleIds] = ids;
    await sql`UPDATE production_items SET status = 'Idea' WHERE id IN ${sql(ids)}`;
    await sql`UPDATE production_items SET created_at = now() - interval '90 days' WHERE id IN ${sql(staleIds)}`;
    await sql`DELETE FROM content_events WHERE content_item_id IN ${sql(staleIds)} AND event_type = 'content_changed'`;

    await page.goto("/starter-story/queue?age=older");
    await expect(page.getByText(titles[1])).toBeVisible({ timeout: 30_000 });
    const link = page.getByRole("button", { name: "Kill all older ideas…" });
    await expect(link).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    await link.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Kill \d+ older ideas\?/)).toBeVisible();
    await dialog.getByRole("textbox").fill("untouched for months, clearing the backlog");
    await dialog.getByRole("button", { name: /Kill/ }).last().click();
    await expect(page.getByText(/Killed \d+ older ideas?/)).toBeVisible();
    await expect(page.getByText(titles[1])).toHaveCount(0);
    await expect(page.getByText(titles[2])).toHaveCount(0);

    const rows = await sql<{ id: string; status: string }[]>`SELECT id, status FROM production_items WHERE id IN ${sql(ids)}`;
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(status[freshId]).toBe("Idea");
    for (const id of staleIds) expect(status[id]).toBe("Killed");
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM content_events
      WHERE content_item_id IN ${sql(staleIds)} AND event_type = 'killed' AND payload->>'bulk' = 'clear-older'`;
    expect(n).toBe(2);

    // The recent idea is still on the default view.
    await page.goto("/starter-story/queue");
    await expect(page.getByText(titles[0])).toBeVisible({ timeout: 30_000 });
  } finally {
    await sql.end();
  }
});
