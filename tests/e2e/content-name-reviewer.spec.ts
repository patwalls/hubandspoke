import { test, expect } from "@playwright/test";
import postgres from "postgres";

// An editor moves their own post to Review from the status menu instead of the
// "Send to review → <reviewer>" button: the post is in Review but still in
// their name, so no reviewer was told. The content page then offers "Hand to
// <reviewer> for review", which makes the reviewer the editor and leaves the
// status alone (no Review → Review event). Reviewer seeded as in
// content-handoff.spec.ts.
test("name the reviewer after moving a post to Review from the status menu", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();

    const [reviewer] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`reviewer-nr-${stamp}@local.test`}, 'Rita Reviewer')
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

    // Rita approved a starter-story post last week → she's the brand's reviewer.
    const pastId = await create(`E2E name-reviewer past ${stamp}`, "Published");
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${pastId}, ${reviewer.id}, 'status_change',
        ${sql.json({ type: "status_change", from: "Review", to: "Ready To Publish" })}, now() - interval '2 days')`;

    const mineId = await create(`E2E name-reviewer mine ${stamp}`, "Assigned");

    await page.goto(`/starter-story/content/${mineId}`);
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }

    // Skip the button: move it with the status menu, the way 30 of 66 sends went.
    await expect(page.getByRole("button", { name: "Send to review → Rita" })).toBeVisible();
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Review", exact: true }).click();

    const hand = page.getByRole("button", { name: "Hand to Rita for review" });
    await expect(hand).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    await hand.click();
    await expect(hand).toBeHidden();

    await expect
      .poll(async () => {
        const [row] = await sql<{ status: string; editor_user_id: string }[]>`
          SELECT status, editor_user_id FROM production_items WHERE id = ${mineId}`;
        return row;
      })
      .toMatchObject({ status: "Review", editor_user_id: reviewer.id });

    // One Assigned → Review move, and no Review → Review from the hand-off.
    const moves = await sql<{ f: string; t: string }[]>`
      SELECT payload->>'from' AS f, payload->>'to' AS t FROM content_events
      WHERE content_item_id = ${mineId} AND event_type = 'status_change'`;
    expect(moves).toEqual([{ f: "Assigned", t: "Review" }]);
  } finally {
    await sql.end();
  }
});
