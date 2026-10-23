import { test, expect } from "@playwright/test";
import postgres from "postgres";

// A video's Derivatives tab: when a format spawns several posts at Idea, one
// editor pick + "Assign N" moves them all to Assigned with that editor,
// without opening each post. Posts further along are left alone.
test("Assign all on the Derivatives tab hands every idea to one editor", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const create = async (title: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: ["youtube"],
          postType: "youtube",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const pillarId = await create(`E2E assign-all pillar ${stamp}`);
    await sql`UPDATE production_items SET status = 'Published', editor_user_id = NULL WHERE id = ${pillarId}`;
    const ideas = [
      await create(`E2E assign-all idea 1 ${stamp}`),
      await create(`E2E assign-all idea 2 ${stamp}`),
      await create(`E2E assign-all idea 3 ${stamp}`),
    ];
    const reviewId = await create(`E2E assign-all in review ${stamp}`);
    await sql`UPDATE production_items SET pillar_content_item_id = ${pillarId}, status = 'Idea', editor_user_id = NULL WHERE id IN ${sql(ideas)}`;
    await sql`UPDATE production_items SET pillar_content_item_id = ${pillarId}, status = 'Review', editor_user_id = NULL WHERE id = ${reviewId}`;

    await page.goto(`/starter-story/content/${pillarId}?tab=derivatives`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const bar = page.getByTestId("derivatives-assign-all");
    await expect(bar).toContainText("3 ideas not assigned yet");
    const assign = bar.getByRole("button", { name: "Assign 3" });
    await expect(assign).toBeDisabled();
    await bar.getByRole("button", { name: "Assignee" }).click();
    await page.getByRole("option").filter({ hasNotText: "Unassigned" }).first().click();
    await expect(assign).toBeEnabled();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await assign.click();
    await expect(page.getByText(/Assigned 3 posts to/)).toBeVisible();
    await expect(bar).toBeHidden();

    const rows = await sql<{ id: string; status: string; editor_user_id: string | null }[]>`
      SELECT id, status, editor_user_id FROM production_items WHERE id IN ${sql([...ideas, reviewId])}`;
    for (const id of ideas) {
      const r = rows.find((x) => x.id === id)!;
      expect(r.status).toBe("Assigned");
      expect(r.editor_user_id).toBe(me);
    }
    const review = rows.find((x) => x.id === reviewId)!;
    expect(review.status).toBe("Review");
    expect(review.editor_user_id).toBeNull();
  } finally {
    await sql.end();
  }
});
