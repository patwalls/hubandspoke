import { test, expect } from "@playwright/test";
import postgres from "postgres";

// my-day M9: a post someone else made you the editor of shows "From <name> · 18h"
// and the new dot on its My Work row until you act on it. Seeded straight into
// the DB like my-work-news.spec.ts: a curator hands me one post (a batch
// assignment), and another post was handed to me before I last worked on it.
test("My Work rows say who handed the post to you", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const [{ name: myName }] = await sql<{ name: string | null }[]>`SELECT name FROM users WHERE id = ${me}`;
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`e2e-curator-${stamp}@local.test`}, 'Evie Curator')
      RETURNING id`;
    const create = async (title: string) => {
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
      await sql`UPDATE production_items SET status = 'Assigned' WHERE id = ${id}`;
      return id;
    };

    const fresh = `E2E handed fresh ${stamp}`;
    const worked = `E2E handed worked ${stamp}`;
    const freshId = await create(fresh);
    const workedId = await create(worked);

    // Creating them logged my own events at "now": move them back two days.
    await sql`
      UPDATE content_events SET created_at = now() - interval '2 days'
      WHERE user_id = ${me} AND content_item_id IN (${freshId}, ${workedId})`;
    const handOver = { type: "editor_change", from: null, to: myName };
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at) VALUES
        (${freshId}, ${other.id}, 'editor_change', ${sql.json(handOver)}, now() - interval '18 hours'),
        (${workedId}, ${other.id}, 'editor_change', ${sql.json(handOver)}, now() - interval '3 days')`;

    await page.goto("/my-work");
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    const row = (title: string) =>
      page.locator("tr[data-my-work-row]", { has: page.getByRole("link", { name: title }) }).first();

    const news = row(fresh).locator("[data-my-work-news]");
    await expect(news).toContainText("From Evie · 18h");
    await expect(news.getByLabel("New since your last change")).toBeVisible();

    // I've worked on this one since it was handed over: nothing to flag.
    await expect(row(worked).locator("[data-my-work-news]")).toHaveCount(0);

    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: false });
  } finally {
    await sql.end();
  }
});
