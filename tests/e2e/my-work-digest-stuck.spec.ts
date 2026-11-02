import { test, expect } from "@playwright/test";
import postgres from "postgres";

// handoffs-dont-stall M3: in the My Work morning email, a Ready To Publish
// post that has sat 3+ days heads the list with how long it has waited, and
// one line under the subject counts the stuck. A fresh Assigned post (and an
// Assigned one 9 days old — backlog, not a stuck hand-off) stays plain.
test("Morning email puts posts stuck 3+ days first and says how long", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const create = async (title: string, status: string, daysAgo: number) => {
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
      await sql`UPDATE production_items SET status = ${status}, updated_at = now() WHERE id = ${id}`;
      await sql`
        INSERT INTO content_events (content_item_id, event_type, payload, created_at)
        VALUES (${id}, 'status_change', ${sql.json({ type: "status_change", from: "Assigned", to: status })},
                now() - ${`${daysAgo} days`}::interval)`;
      return id;
    };
    const fresh = `E2E digest fresh ${stamp}`;
    const backlog = `E2E digest backlog ${stamp}`;
    const stuck = `E2E digest stuck ${stamp}`;
    await create(fresh, "Assigned", 0);
    await create(backlog, "Assigned", 9);
    await create(stuck, "Ready To Publish", 4);

    await page.goto("/my-work/email");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const preview = page.locator("[data-digest-preview]");
    await expect(preview).toContainText(/of these ha(s|ve) waited 3\+ days to move on\./);
    await expect(preview).toContainText("Ready To Publish, waiting 4 days");
    const titles = await preview.locator("table a").allTextContents();
    const mine = titles.filter((t) => t.includes(String(stamp)));
    expect(mine[0]).toBe(stuck);
    await expect(preview).not.toContainText("Assigned, waiting");

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql.end();
  }
});
