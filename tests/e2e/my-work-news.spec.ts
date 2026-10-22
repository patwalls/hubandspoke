import { test, expect } from "@playwright/test";
import postgres from "postgres";

// My Work rows say what changed since you last touched the item: the latest
// comment from someone else (with a "new" dot when it came after your last
// action) and "Sent back by …" when a reviewer moved it back to Assigned.
// The other person, their comment and the send-back are seeded straight
// into the DB, as in my-work.spec.ts.
test("My Work rows show new comments and send-backs", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`e2e-reviewer-${stamp}@local.test`}, 'Andrew Reviewer')
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

    const sentBack = `E2E news sent back ${stamp}`;
    const commented = `E2E news comment ${stamp}`;
    const quiet = `E2E news quiet ${stamp}`;
    const sentBackId = await create(sentBack);
    const commentedId = await create(commented);
    await create(quiet);

    // I sent it to review yesterday; the reviewer sent it back with a note.
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at) VALUES
        (${sentBackId}, ${me}, 'status_change',
          ${sql.json({ type: "status_change", from: "Assigned", to: "Review" })}, now() - interval '1 day'),
        (${sentBackId}, ${other.id}, 'status_change',
          ${sql.json({ type: "status_change", from: "Review", to: "Assigned" })}, now() - interval '2 hours')`;
    await sql`
      INSERT INTO content_comments (content_item_id, user_id, body, created_at) VALUES
        (${sentBackId}, ${other.id}, '<p>Sent back: Hook is too slow &amp; cut the first 3s</p>', now() - interval '2 hours'),
        (${commentedId}, ${other.id}, '<p>Love this one, can we add captions?</p>', now() - interval '5 hours')`;

    await page.goto("/my-work");
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    const row = (title: string) =>
      page.locator("tr[data-my-work-row]", { has: page.getByRole("link", { name: title }) }).first();

    const back = row(sentBack).locator("[data-my-work-news]");
    await expect(back).toContainText("Sent back by Andrew");
    await expect(back).toContainText("Andrew: Sent back: Hook is too slow & cut the first 3s");
    await expect(back.getByLabel("New since your last change")).toBeVisible();

    const note = row(commented).locator("[data-my-work-news]");
    await expect(note).toContainText("Andrew: Love this one, can we add captions?");
    await expect(note).not.toContainText("Sent back");

    await expect(row(quiet).locator("[data-my-work-news]")).toHaveCount(0);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql.end();
  }
});
