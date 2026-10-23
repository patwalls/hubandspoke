import { test, expect } from "@playwright/test";
import postgres from "postgres";

// My Work's row actions hand the work over too, by the content page's handoff
// rules: "Send to review → Rita" on your Assigned row makes the brand's
// reviewer the editor; "Approve → Rita" / "Send back → Rita" on a To review row
// give it back to whoever sent it. Rita is a second user seeded straight into
// the DB, as in handoff.spec.ts.
test("My Work row actions hand the item to the next person", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();

    const [rita] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`rita-${stamp}@local.test`}, 'Rita Reviewer')
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

    // Both of us approved starter-story posts → I see To review, Rita is the
    // reviewer my work goes to.
    const pastMine = await create(`E2E mwh past mine ${stamp}`, "Published");
    await statusEvent(pastMine, me, "Review", "Ready To Publish");
    const pastRita = await create(`E2E mwh past rita ${stamp}`, "Published");
    await statusEvent(pastRita, rita.id, "Review", "Ready To Publish");
    await statusEvent(pastRita, rita.id, "Review", "Ready To Publish");

    const mine = `E2E mwh mine ${stamp}`;
    const approve = `E2E mwh approve ${stamp}`;
    const sendBack = `E2E mwh send back ${stamp}`;
    const mineId = await create(mine, "Assigned");
    // Rita sent these two to me for review.
    const approveId = await create(approve, "Review");
    await statusEvent(approveId, rita.id, "Assigned", "Review");
    const sendBackId = await create(sendBack, "Review");
    await statusEvent(sendBackId, rita.id, "Assigned", "Review");

    await page.goto("/my-work");
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    const row = (title: string) =>
      page.locator("tr[data-my-work-row]", { has: page.getByRole("link", { name: title }) }).first();

    await expect(row(mine).getByRole("button", { name: /Send to review → Rita/ })).toBeVisible();
    await expect(row(approve).getByRole("button", { name: /Approve → Rita/ })).toBeVisible();
    await expect(row(sendBack).getByRole("button", { name: /Send back → Rita/ })).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    const state = async (id: string) => {
      const [r] = await sql<{ status: string; editor_user_id: string }[]>`
        SELECT status, editor_user_id FROM production_items WHERE id = ${id}`;
      return `${r.status}/${r.editor_user_id}`;
    };

    await row(mine).getByRole("button", { name: /Send to review → Rita/ }).click();
    await expect.poll(() => state(mineId)).toBe(`Review/${rita.id}`);
    await row(approve).getByRole("button", { name: /Approve → Rita/ }).click();
    await expect.poll(() => state(approveId)).toBe(`Ready To Publish/${rita.id}`);
    await page.waitForLoadState("networkidle");
    await row(sendBack).getByRole("button", { name: /Send back → Rita/ }).click();
    const note = row(sendBack).getByRole("textbox", { name: "Note for the editor" });
    await note.fill("Tighten the hook");
    await note.press("Enter");
    await expect.poll(() => state(sendBackId)).toBe(`Assigned/${rita.id}`);

    const items = await sql<{ id: string; status: string; editor_user_id: string }[]>`
      SELECT id, status, editor_user_id FROM production_items
       WHERE id IN (${mineId}, ${approveId}, ${sendBackId})`;
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId[mineId]).toMatchObject({ status: "Review", editor_user_id: rita.id });
    expect(byId[approveId]).toMatchObject({ status: "Ready To Publish", editor_user_id: rita.id });
    expect(byId[sendBackId]).toMatchObject({ status: "Assigned", editor_user_id: rita.id });
  } finally {
    await sql.end();
  }
});
