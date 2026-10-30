import { test, expect } from "@playwright/test";
import postgres from "postgres";

// An AI draft written with the WHAT EDITORS CHANGED block (prompt v16+) shows
// "Learned from N recent edits" above the simulator; opening it lists the
// (AI draft → editor published) pairs from the same brand + format. A draft
// from before v16 never claims it learned. A cross-post an editor fixed
// (copied source caption → their version) counts too, labelled as a copy.
test("an AI draft shows which editor rewrites it learned from", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const format = `E2E Learned ${stamp}`;
    const schema = sql.json({ version: 1, fields: [] });
    const create = async (title: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: ["x"],
          postType: "x",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      const id = (await res.json()).id as string;
      await sql`UPDATE production_items SET format = ${format} WHERE id = ${id}`;
      return id;
    };

    // A published post an editor rewrote: v15 AI draft → their version.
    const doneId = await create(`E2E rewritten ${stamp}`);
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${doneId}`;
    await sql`
      INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
      VALUES
        (${doneId}, 1, false, ${sql.json({ caption: "Jane Doe, who built a $40K/mo Excel app, says ship ugly." })}, ${schema}, 'draft-algo:v1.7:claude-opus-5-5:v15'),
        (${doneId}, 2, true, ${sql.json({ caption: "This dude Jane who built a $40K/mo app says: ship ugly." })}, ${schema}, 'user:edit')`;

    // A published cross-post: the source's caption copied, then fixed.
    const crossId = await create(`E2E cross-post ${stamp}`);
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${crossId}`;
    await sql`
      INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
      VALUES
        (${crossId}, 1, false, ${sql.json({ caption: "He just built 4 apps doing at least $150K/month each!" })}, ${schema}, 'copy:source'),
        (${crossId}, 2, true, ${sql.json({ caption: "Nicole built 4 apps, doing about $150K/month each!" })}, ${schema}, 'user:edit')`;

    // The post being drafted now, by a v17 run.
    const id = await create(`E2E new draft ${stamp}`);
    await sql`UPDATE production_items SET status = 'Assigned' WHERE id = ${id}`;
    await sql`
      INSERT INTO content_drafts (production_item_id, version, is_current, content, field_schema_snapshot, generated_by)
      VALUES (${id}, 1, true, ${sql.json({ caption: "This dude Sam who built a $9K/mo tool says: charge more." })}, ${schema}, 'draft-algo:v1.7:claude-opus-5-5:v17')`;

    // The rewritten post only has a v15 draft: nothing learned there.
    const none = await (await page.request.get(`/api/production-items/${doneId}/learned-edits`)).json();
    expect(none.examples).toEqual([]);

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${id}`);
    const chip = page.getByRole("button", { name: "Learned from 2 recent edits" });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.click();
    await expect(page.getByText("This dude Jane who built a $40K/mo app says: ship ugly.")).toBeVisible();
    await expect(page.getByText("Jane Doe, who built a $40K/mo Excel app, says ship ugly.")).toBeVisible();
    await expect(page.getByText("Nicole built 4 apps, doing about $150K/month each!")).toBeVisible();
    await expect(page.getByText(/^Copied caption/)).toBeVisible();
    if (process.env.E2E_SHOT) {
      // The What's new handler's "Got it" can close the popover; reopen it for the shot.
      if (!(await page.getByText(/^Copied caption/).isVisible())) await chip.click();
      await expect(page.getByText(/^Copied caption/)).toBeVisible();
      await page.waitForTimeout(400); // let the popover finish fading in
      await page.screenshot({ path: process.env.E2E_SHOT });
    }
  } finally {
    await sql.end();
  }
});
