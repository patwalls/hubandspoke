import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The curator gives an unstarted post (an Idea, or a clip parked in Ready To
// Publish) to the editor who makes its format, with a brief: status, editor
// and comment were three steps. The comment box now offers "Comment & assign
// → <editor>" (the editor = whoever handed this brand + format's posts in
// lately). Seeded like comment-handoff.spec.ts.
test("assign an unstarted post to its format's editor from the comment box, brief included", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const format = `E2E Assign Format ${stamp}`;
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();

    const [editor] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`editor-ca-${stamp}@local.test`}, 'Nora Editor')
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
      await sql`UPDATE production_items SET status = ${status}, format = ${format} WHERE id = ${id}`;
      return id;
    };

    // History: Nora handed one of this format's posts in last week.
    const pastId = await create(`E2E comment-assign past ${stamp}`, "Published");
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${pastId}, ${editor.id}, 'status_change',
        ${sql.json({ type: "status_change", from: "Assigned", to: "Review" })}, now() - interval '5 days')`;

    const parkedId = await create(`E2E comment-assign parked ${stamp}`, "Ready To Publish");

    await page.goto(`/starter-story/content/${parkedId}`);
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    // Default state: the page looks as it did (nothing new by the status chip).
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT.replace(/\.png$/, "-before.png"), fullPage: true });

    const assign = page.getByRole("button", { name: "Comment & assign → Nora" });
    await expect(assign).toBeHidden();
    await expect(page.getByTestId("handoff")).toBeHidden();

    await page.locator(".ProseMirror").last().click();
    await page.keyboard.type("Tighten the hook, captions in brand font");
    await expect(assign).toBeVisible();
    await assign.scrollIntoViewIfNeeded();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    const posted = page.waitForResponse(
      (r) => r.url().endsWith(`/api/production-items/${parkedId}/comments`) && r.request().method() === "POST",
    );
    await assign.click();
    const res = await posted;
    expect(res.status()).toBe(201);
    expect(JSON.parse(res.request().postData() ?? "{}").handoffTo).toBe(editor.id);

    await expect
      .poll(async () => {
        const [row] = await sql<{ status: string; editor_user_id: string }[]>`
          SELECT status, editor_user_id FROM production_items WHERE id = ${parkedId}`;
        return row;
      })
      .toMatchObject({ status: "Assigned", editor_user_id: editor.id });

    const comments = await sql<{ body: string }[]>`
      SELECT body FROM content_comments WHERE content_item_id = ${parkedId}`;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Tighten the hook");

    // Assigned to Nora now: the box's assign is gone.
    await expect(assign).toBeHidden();
  } finally {
    await sql.end();
  }
});
