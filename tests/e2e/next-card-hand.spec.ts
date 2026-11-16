import { test, expect } from "@playwright/test";
import postgres from "postgres";

// editor-handoffs M3: an editor moves their own post to Review from the status
// menu, and My Work's next card ("Sent to review.") comes up. The card offers
// "Hand to <reviewer> for review" right beside Open next, so the reviewer is
// named before they move on. Reviewer seeded as in content-name-reviewer.spec.ts.
test("the next card hands a post moved to Review from the status menu to the reviewer", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();

    const [reviewer] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`reviewer-nch-${stamp}@local.test`}, 'Rita Reviewer')
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
    const pastId = await create(`E2E next-card-hand past ${stamp}`, "Published");
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${pastId}, ${reviewer.id}, 'status_change',
        ${sql.json({ type: "status_change", from: "Review", to: "Ready To Publish" })}, now() - interval '2 days')`;

    const mineId = await create(`E2E next-card-hand mine ${stamp}`, "Assigned");

    await page.goto(`/starter-story/content/${mineId}`);
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }

    // A second post waiting on me, so the card has an Open next.
    await create(`E2E next-card-hand next ${stamp}`, "Assigned");
    await page.reload();
    await page.waitForLoadState("networkidle");

    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Review", exact: true }).click();

    const card = page.getByTestId("up-next-card");
    await expect(card).toContainText("Sent to review.");
    const hand = card.getByRole("button", { name: "Hand to Rita for review" });
    await expect(hand).toBeVisible();
    await expect(card.getByRole("link", { name: /Open next/ })).toBeVisible();
    await page.waitForTimeout(400);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
    await hand.click();

    await expect(card).toContainText("Handed to Rita for review.");
    await expect(hand).toBeHidden();
    await expect(card.getByRole("link", { name: /Open next/ })).toBeVisible();

    await expect
      .poll(async () => {
        const [row] = await sql<{ status: string; editor_user_id: string }[]>`
          SELECT status, editor_user_id FROM production_items WHERE id = ${mineId}`;
        return row;
      })
      .toMatchObject({ status: "Review", editor_user_id: reviewer.id });

    const moves = await sql<{ f: string; t: string }[]>`
      SELECT payload->>'from' AS f, payload->>'to' AS t FROM content_events
      WHERE content_item_id = ${mineId} AND event_type = 'status_change'`;
    expect(moves).toEqual([{ f: "Assigned", t: "Review" }]);
  } finally {
    await sql.end();
  }
});
