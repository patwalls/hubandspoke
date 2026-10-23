import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The My Work morning email: /my-work links to /my-work/email, which shows
// the email you'd get right now (same builder the weekday task sends) and a
// switch to turn it off. A send-back is seeded so it heads the list.
test("Morning email preview lists what's waiting, and turns off", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`e2e-digest-${stamp}@local.test`}, 'Andrew Reviewer')
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
    const plain = `E2E digest plain ${stamp}`;
    const back = `E2E digest sent back ${stamp}`;
    await create(plain);
    const backId = await create(back);
    await sql`
      UPDATE content_events SET created_at = now() - interval '2 days'
      WHERE user_id = ${me} AND content_item_id = ${backId}`;
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at) VALUES
        (${backId}, ${other.id}, 'status_change',
          ${sql.json({ type: "status_change", from: "Review", to: "Assigned" })}, now() - interval '1 hour')`;

    await page.goto("/my-work");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    await page.getByRole("link", { name: "Morning email" }).click();
    await expect(page).toHaveURL(/\/my-work\/email$/);
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
    }

    const preview = page.locator("[data-digest-preview]");
    await expect(preview).toContainText(/\d+ things? waiting on you/);
    await expect(preview).toContainText(`${back}`);
    await expect(preview).toContainText("Sent back by Andrew");
    await expect(preview).toContainText(plain);
    // The send-back heads the list.
    const titles = await preview.locator("table a").allTextContents();
    expect(titles[0]).toBe(back);

    await expect(page.locator("[data-digest-state]")).toContainText("on");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    await page.getByRole("button", { name: "Turn off" }).click();
    await expect(page.locator("[data-digest-state]")).toContainText("off");
    const [row] = await sql<{ on: boolean }[]>`SELECT my_work_digest_enabled AS on FROM users WHERE id = ${me}`;
    expect(row.on).toBe(false);
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page.locator("[data-digest-state]")).toContainText("on");
  } finally {
    await sql.end();
  }
});
