import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The header's My Work button counts what's waiting on you and opens My Work:
// your turn (Assigned / Ready To Publish on your items) and To review (Review
// items on a brand you approved a post for this month). The approval history
// is seeded straight into content_events.
test("My Work button shows what's waiting and the To review section", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const create = async (title: string, editorUserId: string | null) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: ["tiktok"],
          postType: "tiktok",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
          editorUserId,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };

    const assignedId = await create(`E2E my-work assigned ${stamp}`, me);
    const approvedId = await create(`E2E my-work approved ${stamp}`, null);
    const reviewId = await create(`E2E my-work review ${stamp}`, null);
    await sql`UPDATE production_items SET status = 'Assigned' WHERE id = ${assignedId}`;
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${approvedId}`;
    await sql`UPDATE production_items SET status = 'Review' WHERE id = ${reviewId}`;
    // I approved a starter-story post last week, so its Review items are mine to review.
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${approvedId}, ${me}, 'status_change',
        ${sql.json({ type: "status_change", from: "Review", to: "Ready To Publish" })},
        now() - interval '7 days')`;

    const expected = await (await page.request.get("/api/my-work/count")).json();
    expect(expected.count).toBeGreaterThanOrEqual(2);

    await page.goto("/starter-story");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.waitForLoadState("networkidle");
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    const button = page.getByTestId("my-work-button");
    await expect(page.getByTestId("my-work-count")).toHaveText(String(expected.count));
    await button.click();
    await expect(page).toHaveURL(/\/my-work$/);

    const toReview = page.locator("div.rounded-lg", { has: page.getByRole("heading", { name: /To review/ }) });
    await expect(toReview.getByRole("link", { name: `E2E my-work review ${stamp}` })).toBeVisible();
    const yourTurn = page.locator("div.rounded-lg", { has: page.getByRole("heading", { name: /Your turn/ }) });
    await expect(yourTurn.getByRole("link", { name: `E2E my-work assigned ${stamp}` })).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql.end();
  }
});
