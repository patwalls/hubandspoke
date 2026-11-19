import { test, expect } from "@playwright/test";
import postgres from "postgres";

// When a report rebuild is slow, the server answers In Production with its
// last report marked `stale: true` (services/production-report.ts →
// getProductionReportFast) and the page asks again a few seconds later. The
// e2e DB never makes a rebuild slow, so the first answer is faked: the real
// report minus the new post, marked stale. The page must paint it, then pick
// up the post from the follow-up fetch without a spinner or a reload.
test("In Production swaps a stale report for the fresh one by itself", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const title = `E2E last-good ${Date.now()}`;
    const res = await page.request.post("/api/production-items", {
      data: {
        title,
        platform: ["tiktok"],
        postType: "tiktok",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    await sql`UPDATE production_items SET status = 'Assigned' WHERE id = ${id}`;

    // Every answer in the first 2 s is stale (dev-mode React mounts twice, so
    // the page's own first load is two fetches); only the page's follow-up,
    // 4 s after a stale answer, gets the real report.
    let calls = 0;
    let firstAt = 0;
    await page.route("**/api/reports/production?*", async (route) => {
      calls += 1;
      if (!firstAt) firstAt = Date.now();
      if (Date.now() - firstAt > 2_000) return route.continue();
      const real = await route.fetch();
      const body = await real.json();
      body.items = (body.items ?? []).filter((i: { id: string }) => i.id !== id);
      body.stale = true;
      await route.fulfill({ response: real, json: body });
    });

    await page.goto("/starter-story/production");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible().catch(() => false)) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    // The stale answer painted (the new post isn't in it) …
    await expect.poll(() => calls).toBeGreaterThanOrEqual(1);
    await expect(page.getByText(title)).toHaveCount(0);
    // … and the follow-up brings it in, with no reload.
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - firstAt).toBeGreaterThan(2_000);

    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql.end();
  }
});
