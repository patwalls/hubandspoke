import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Outside editors hand finished work back with a comment ("review & publish",
// a design link), never the status-chip button. The comment box now offers
// "Comment & send to review → <reviewer>": one click moves the post to
// Review, makes the reviewer the editor, and posts the note. Reviewer seeded
// as in content-name-reviewer.spec.ts.
test("send a post to review from the comment box, note included", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();

    const [reviewer] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`reviewer-ch-${stamp}@local.test`}, 'Rita Reviewer')
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

    const pastId = await create(`E2E comment-handoff past ${stamp}`, "Published");
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${pastId}, ${reviewer.id}, 'status_change',
        ${sql.json({ type: "status_change", from: "Review", to: "Ready To Publish" })}, now() - interval '2 days')`;

    const mineId = await create(`E2E comment-handoff mine ${stamp}`, "Assigned");

    await page.goto(`/starter-story/content/${mineId}`);
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }

    const send = page.getByRole("button", { name: "Comment & send to review → Rita" });
    // Nothing typed yet → only "Post comment" (the box stays as it was).
    await expect(page.getByRole("button", { name: "Send to review → Rita" })).toBeVisible();
    await expect(send).toBeHidden();

    await page.locator(".ProseMirror").last().click();
    await page.keyboard.type("Ready for review, cut the intro to 3s");
    await expect(send).toBeVisible();
    await send.scrollIntoViewIfNeeded();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    const posted = page.waitForResponse(
      (r) => r.url().endsWith(`/api/production-items/${mineId}/comments`) && r.request().method() === "POST",
    );
    await send.click();
    const res = await posted;
    expect(res.status()).toBe(201);
    expect(JSON.parse(res.request().postData() ?? "{}").handoffTo).toBe(reviewer.id);

    await expect
      .poll(async () => {
        const [row] = await sql<{ status: string; editor_user_id: string }[]>`
          SELECT status, editor_user_id FROM production_items WHERE id = ${mineId}`;
        return row;
      })
      .toMatchObject({ status: "Review", editor_user_id: reviewer.id });

    const comments = await sql<{ body: string }[]>`
      SELECT body FROM content_comments WHERE content_item_id = ${mineId}`;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("cut the intro to 3s");

    // Handed off: the chip button is gone, and so is the box's handoff.
    await expect(page.getByRole("button", { name: "Send to review → Rita" })).toBeHidden();
    await expect(send).toBeHidden();
  } finally {
    await sql.end();
  }
});
