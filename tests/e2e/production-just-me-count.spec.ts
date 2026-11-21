import { test, expect } from "@playwright/test";
import postgres from "postgres";

// In Production's Editor pill says how many rows are yours ("Just me · 2"),
// so an editor checking for work sees it without filtering; picking it is
// recorded as production:editor-filter:me.

test("the Editor pill counts your rows and records the pick", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E JustMe ${Date.now()}`;
  try {
    const [me] = await sql`SELECT id FROM users WHERE email = 'e2e@local.test'`;
    for (const n of [1, 2, 3]) {
      const res = await page.request.post("/api/production-items", {
        data: { title: `${tag} part ${n}`, platform: ["linkedin"], postType: "linkedin", publishedDate: new Date().toISOString().slice(0, 10), brand: "starter-story" },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      const id = (await res.json()).id as string;
      // Two are mine, one is nobody's.
      await sql`UPDATE production_items SET status = 'Assigned', editor_user_id = ${n < 3 ? me.id : null} WHERE id = ${id}`;
    }
    await page.goto(`/starter-story/production`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(page.locator("[data-production-row]").first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /Editor/ }).first().click();
    // The throwaway DB may hold other specs' rows too: at least my two.
    const justMe = page.getByText(/^Just me · \d+$/);
    await expect(justMe).toBeVisible();
    expect(Number((await justMe.textContent())!.split("·")[1])).toBeGreaterThanOrEqual(2);
    if (process.env.E2E_SHOT) {
      await page.waitForTimeout(300); // popover fade-in
      await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    }
    await justMe.click();

    // The list narrows to my rows; the nobody's row is gone.
    await page.getByRole("searchbox").fill(tag);
    await expect(page.locator("[data-production-row]")).toHaveCount(2);

    await expect
      .poll(async () => {
        const [{ n }] = await sql`
          SELECT count(*)::int AS n FROM usage_events
          WHERE user_id = ${me.id} AND screen = 'production:editor-filter:me'`;
        return n;
      }, { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});
