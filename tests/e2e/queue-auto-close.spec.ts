import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The weekly clip-idea auto-close (services/idea-auto-close.ts) leaves one
// quiet line atop the queue's History tab with an Undo. The close itself is
// covered by idea-auto-close.integration.test.ts; here two items are put in
// the state a run leaves (Killed + a `killed` event tagged bulk auto-close
// with a run id) and Undo must bring both back to Idea.

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(90_000);

test("History shows last week's auto-close and Undo brings the ideas back", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    // A run id no real run will share, so earlier runs on this DB don't count.
    const run = new Date().toISOString().slice(0, 10);
    const ids: string[] = [];
    for (const title of [`E2E auto-closed A ${stamp}`, `E2E auto-closed B ${stamp}`]) {
      const res = await page.request.post("/api/production-items", {
        data: { title, platform: ["tiktok"], postType: "tiktok", publishedDate: "2026-08-20", brand: "starter-story" },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      ids.push((await res.json()).id as string);
    }
    // Clear any earlier test's run with the same id so the counts are ours.
    await sql`DELETE FROM content_events WHERE event_type = 'killed' AND payload->>'bulk' = 'auto-close' AND payload->>'run' = ${run}`;
    await sql`UPDATE production_items SET status = 'Killed' WHERE id IN ${sql(ids)}`;
    for (const id of ids) {
      await sql`INSERT INTO content_events (content_item_id, event_type, payload)
        VALUES (${id}, 'killed', ${sql.json({ type: "killed", from: "Idea", reason: "Closed itself: nobody touched it for 60 days", bulk: "auto-close", run })})`;
    }

    await page.goto("/starter-story/queue/history");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();
    const notice = page.getByTestId("auto-close-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText("2 clip ideas nobody touched in 60 days closed themselves");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: false });

    await notice.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("Brought back 2 ideas")).toBeVisible();
    await expect(notice).toContainText("all brought back or moved since");

    const rows = await sql<{ status: string }[]>`SELECT status FROM production_items WHERE id IN ${sql(ids)}`;
    expect(rows.map((r) => r.status)).toEqual(["Idea", "Idea"]);
  } finally {
    await sql.end();
  }
});
