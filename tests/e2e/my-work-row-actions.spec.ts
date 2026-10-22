import { test, expect } from "@playwright/test";
import postgres from "postgres";

// My Work rows act without opening the item: Send to review on your Assigned
// items, Approve / Send back (with a note that becomes a comment) on To review,
// and j/k + the button's key from the keyboard. Approval history is seeded
// straight into content_events, as in my-work.spec.ts.
test("act on My Work rows from buttons and keys", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
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

    const assigned = `E2E row assigned ${stamp}`;
    const approve = `E2E row approve ${stamp}`;
    const sendBack = `E2E row send back ${stamp}`;
    const assignedId = await create(assigned, "Assigned");
    const approveId = await create(approve, "Review");
    const sendBackId = await create(sendBack, "Review");
    const pastId = await create(`E2E row past ${stamp}`, "Published");
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${pastId}, ${me}, 'status_change',
        ${sql.json({ type: "status_change", from: "Review", to: "Ready To Publish" })},
        now() - interval '7 days')`;

    await page.goto("/my-work");
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    const row = (title: string) =>
      page.locator("tr[data-my-work-row]", { has: page.getByRole("link", { name: title }) });
    const toReview = page.locator("div.rounded-lg", { has: page.getByRole("heading", { name: /To review/ }) });

    // Approve with a click.
    await row(approve).getByRole("button", { name: /Approve/ }).click();
    await expect(toReview.getByRole("link", { name: approve })).toHaveCount(0);

    // Send back with a note: the note input opens on the row.
    await row(sendBack).getByRole("button", { name: /Send back/ }).click();
    const note = row(sendBack).getByRole("textbox", { name: "Note for the editor" });
    await expect(note).toBeFocused();
    await note.fill("Hook is too slow, cut the first 3s");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    await note.press("Enter");
    await expect(toReview.getByRole("link", { name: sendBack })).toHaveCount(0);

    // Keyboard: j to the Assigned row, r sends it to review.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("j");
      if (await row(assigned).first().getAttribute("data-focused") !== null) break;
    }
    await expect(row(assigned).first()).toHaveAttribute("data-focused", "");
    await page.keyboard.press("r");
    await expect(toReview.getByRole("link", { name: assigned })).toBeVisible();

    const statuses = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM production_items WHERE id IN (${assignedId}, ${approveId}, ${sendBackId})`;
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s.status]));
    expect(byId[approveId]).toBe("Ready To Publish");
    expect(byId[sendBackId]).toBe("Assigned");
    expect(byId[assignedId]).toBe("Review");
    const [comment] = await sql<{ body: string }[]>`
      SELECT body FROM content_comments WHERE content_item_id = ${sendBackId}`;
    expect(comment.body).toContain("Hook is too slow");
  } finally {
    await sql.end();
  }
});
