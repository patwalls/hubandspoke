import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// In Production comes back at once: returning from a post shows the list the
// tab already had (no spinner), then swaps in the fresh report quietly. Every
// status change clears the server's report cache, so the refetch after a
// change is the slow one — the report is slowed here so a spinner would be
// caught if it showed.

async function makePost(page: Page, title: string): Promise<string> {
  const res = await page.request.post("/api/production-items", {
    data: {
      title,
      platform: ["linkedin"],
      postType: "linkedin",
      publishedDate: new Date().toISOString().slice(0, 10),
      brand: "starter-story",
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).id as string;
}

test("In Production comes back instantly from a post and refreshes behind it", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Instant ${Date.now()}`;
  const ids: string[] = [];
  try {
    const id = await makePost(page, `${tag} before`);
    ids.push(id);
    await sql`UPDATE production_items SET status = 'Assigned' WHERE id = ${id}`;
    // A write through the app drops the 60 s report cache after the row
    // changed underneath it.
    ids.push(await makePost(page, `E2E cache bust ${Date.now()}`));

    await page.goto("/starter-story/production");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();
    const row = page.locator(`[data-production-row="${id}"]`);
    await expect(row).toContainText(`${tag} before`);

    // The whole page in its default state, for the loop's visual check.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    let reportCalls = 0;
    await page.route("**/api/reports/production?**", async (route) => {
      reportCalls += 1;
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });

    // Open the post (client-side), change it underneath, come back with Back.
    await row.locator("a[data-row-open]").click();
    await page.waitForURL(new RegExp(`/starter-story/content/${id}`));
    await sql`UPDATE production_items SET title = ${`${tag} after`} WHERE id = ${id}`;
    // A write through the app drops the server's 60 s report cache, like a
    // status change does.
    ids.push(await makePost(page, `E2E cache bust ${Date.now()}`));
    await page.goBack();
    await page.waitForURL(/\/starter-story\/production/);

    // At once: the remembered list, no spinner…
    await expect(row).toContainText(`${tag} before`, { timeout: 1000 });
    await expect(page.getByText("Loading production pipeline…")).toHaveCount(0);
    // …and the fresh report replaces it when it lands.
    await expect(row).toContainText(`${tag} after`, { timeout: 15_000 });
    expect(reportCalls).toBeGreaterThan(0);
    await expect(page.getByText("Loading production pipeline…")).toHaveCount(0);
  } finally {
    if (ids.length) await sql`DELETE FROM production_items WHERE id IN ${sql(ids)}`;
    await sql.end();
  }
});
