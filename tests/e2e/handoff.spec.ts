import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// The content page's one-click handoff: "Send to review → <reviewer>" on your
// Assigned item moves it to Review AND makes the brand's reviewer the editor;
// "Approve → back to <sender>" on a Review item moves it to Ready To Publish
// and hands it back. The reviewer is a second user seeded straight into the
// DB with one approval on the brand, as in my-work.spec.ts.
test("hand work to the reviewer and back in one click", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();

    const [reviewer] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`reviewer-${stamp}@local.test`}, 'Rita Reviewer')
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
    const statusEvent = (itemId: string, userId: string, from: string, to: string) => sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${itemId}, ${userId}, 'status_change',
        ${sql.json({ type: "status_change", from, to })}, now() - interval '2 days')`;

    // Rita approved a starter-story post last week → she's the brand's reviewer.
    const pastId = await create(`E2E handoff past ${stamp}`, "Published");
    await statusEvent(pastId, reviewer.id, "Review", "Ready To Publish");

    const mineId = await create(`E2E handoff mine ${stamp}`, "Assigned");
    // Rita sent this one to me for review.
    const reviewId = await create(`E2E handoff review ${stamp}`, "Review");
    await statusEvent(reviewId, reviewer.id, "Assigned", "Review");

    const open = async (p: Page, id: string) => {
      await p.goto(`/starter-story/content/${id}`);
      await p.waitForLoadState("networkidle");
      const popup = p.getByRole("dialog", { name: "What's new" });
      if (await popup.isVisible()) {
        await popup.getByRole("button", { name: "Got it" }).click();
        await expect(popup).toBeHidden();
      }
    };

    // 1. Send to review → Rita.
    await open(page, mineId);
    const send = page.getByRole("button", { name: "Send to review → Rita" });
    await expect(send).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
    await send.click();
    await expect(send).toBeHidden();

    // 2. Approve → back to Rita.
    await open(page, reviewId);
    const approve = page.getByRole("button", { name: "Approve → back to Rita" });
    await expect(approve).toBeVisible();
    await approve.click();
    await expect(approve).toBeHidden();

    const rows = await sql<{ id: string; status: string; editor_user_id: string }[]>`
      SELECT id, status, editor_user_id FROM production_items WHERE id IN (${mineId}, ${reviewId})`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[mineId]).toMatchObject({ status: "Review", editor_user_id: reviewer.id });
    expect(byId[reviewId]).toMatchObject({ status: "Ready To Publish", editor_user_id: reviewer.id });
  } finally {
    await sql.end();
  }
});
