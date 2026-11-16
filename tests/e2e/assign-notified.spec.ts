import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Assigning someone on the post page says they were told — "Rita was notified
// by email and in their bell" — so the assigner doesn't have to follow up with
// a bare "@Rita" comment. Someone with no login yet gets a warning instead
// (no email could go out). Driven through "Send to review → Rita", which
// assigns through the same save as the editor picker.
test("assigning someone says they were notified", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();

    // Rita can sign in (has a password) and approved a post last week, so
    // she's the brand's reviewer.
    const [reviewer] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash)
      VALUES (${`notified-${stamp}@local.test`}, 'Rita Reviewer', 'x')
      RETURNING id`;

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
    const pastId = await create(`E2E notified past ${stamp}`, "Published");
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${pastId}, ${reviewer.id}, 'status_change',
        ${sql.json({ type: "status_change", from: "Review", to: "Ready To Publish" })},
        now() - interval '2 days')`;
    const mineId = await create(`E2E notified mine ${stamp}`, "Assigned");

    await page.goto(`/starter-story/content/${mineId}`);
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }

    await page.getByRole("button", { name: "Send to review → Rita" }).click();
    const toast = page.getByText("Rita was notified by email and in their bell");
    await expect(toast).toBeVisible();
    // The moment worth seeing: the whole post page, the toast in its corner.
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notifications
      WHERE user_id = ${reviewer.id} AND content_item_id = ${mineId} AND kind = 'assigned'`;
    expect(row.n).toBe(1);

    // Assigning yourself back says nothing (you don't notify yourself).
    const res = await page.request.put("/api/production-items", {
      data: { id: mineId, editorUserId: me },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).assignedNotice).toMatchObject({ delivery: "none" });
  } finally {
    await sql.end();
  }
});
