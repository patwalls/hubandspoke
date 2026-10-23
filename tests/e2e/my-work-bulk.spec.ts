import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Bulk changes on My Work: tick rows (or a section's select-all), then Move
// to a status, Kill with one reason, or Delete — from the bar at the bottom.
test("select My Work rows and move, kill or delete them together", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const create = async (title: string, status: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: ["tiktok"],
          postType: "tiktok",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
          editorUserId: me,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      const id = (await res.json()).id as string;
      await sql`UPDATE production_items SET status = ${status} WHERE id = ${id}`;
      return id;
    };

    const move1 = `E2E bulk move one ${stamp}`;
    const move2 = `E2E bulk move two ${stamp}`;
    const kill = `E2E bulk kill ${stamp}`;
    const del = `E2E bulk delete ${stamp}`;
    const move1Id = await create(move1, "On Hold");
    const move2Id = await create(move2, "On Hold");
    const killId = await create(kill, "On Hold");
    const delId = await create(del, "Assigned");

    await page.goto("/my-work");
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    const pick = (title: string) => page.getByRole("checkbox", { name: `Select “${title}”` }).check();
    const bar = page.locator("[data-my-work-bulk]");

    // Select-all ticks every row in the section; ticking again clears them.
    const all = page.getByRole("checkbox", { name: "Select all in Waiting on others" });
    await all.check();
    await expect(page.getByRole("checkbox", { name: `Select “${kill}”` })).toBeChecked();
    await all.uncheck();
    await expect(bar).toBeHidden();

    // Move two to Idea: they leave My Work.
    await pick(move1);
    await pick(move2);
    await expect(bar).toContainText("2 selected");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: false });
    await bar.getByRole("button", { name: /Move to/ }).click();
    await page.getByRole("menuitem", { name: "Idea", exact: true }).click();
    await expect(page.getByRole("link", { name: move1 })).toHaveCount(0);
    await expect(page.getByRole("link", { name: move2 })).toHaveCount(0);

    // Kill one with a reason.
    await pick(kill);
    await bar.getByRole("button", { name: "Kill" }).click();
    const killDialog = page.getByRole("dialog", { name: /Kill 1 post/ });
    await killDialog.getByRole("textbox").fill("Old interview pipeline junk");
    await killDialog.getByRole("button", { name: /Kill 1 post/ }).click();
    // A modal hides the page from role queries, so wait for the result, not the row.
    await expect(page.getByText("Killed 1 post")).toBeVisible();
    await expect(page.getByRole("link", { name: kill })).toHaveCount(0);

    // Delete one, after confirming.
    await pick(del);
    await bar.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog", { name: /Delete 1 post/ }).getByRole("button", { name: "Delete 1 post" }).click();
    await expect(page.getByText("Deleted 1 post")).toBeVisible();
    await expect(page.getByRole("link", { name: del })).toHaveCount(0);

    const rows = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM production_items
      WHERE id IN (${move1Id}, ${move2Id}, ${killId}, ${delId})`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[move1Id].status).toBe("Idea");
    expect(byId[move2Id].status).toBe("Idea");
    expect(byId[killId].status).toBe("Killed");
    const [killed] = await sql<{ reason: string }[]>`
      SELECT payload->>'reason' AS reason FROM content_events
      WHERE content_item_id = ${killId} AND event_type = 'killed'`;
    expect(killed.reason).toBe("Old interview pipeline junk");
    expect(byId[delId]).toBeUndefined();
  } finally {
    await sql.end();
  }
});
