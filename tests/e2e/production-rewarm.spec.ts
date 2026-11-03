import { test, expect } from "@playwright/test";
import postgres from "postgres";

// After an edit expires the production report, the dyno re-warms In
// Production's key a few seconds later (src/lib/report-rewarm.ts). The list
// must still show the edit — the re-warm can never serve the pre-edit report.

test("In Production shows a post right after it was created, with the re-warm in between", async ({ page }) => {
  test.setTimeout(90_000);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Rewarm ${Date.now()}`;
  const ids: string[] = [];
  try {
    // The warm endpoint stays closed without the secret, scoped or not.
    const closed = await page.request.get("/api/warm?only=production");
    expect(closed.status()).toBe(401);

    await page.goto("/starter-story/production");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});

    const res = await page.request.post("/api/production-items", {
      data: {
        title: `${tag} fresh post`,
        platform: ["linkedin"],
        postType: "linkedin",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    ids.push(id);
    await sql`UPDATE production_items SET status = 'Review' WHERE id = ${id}`;
    // Move it through the app so the report is invalidated (and re-warmed)
    // after the row changed.
    const move = await page.request.put("/api/production-items", {
      data: { id, status: "Ready To Publish" },
    });
    expect(move.ok(), await move.text()).toBeTruthy();
    await page.waitForTimeout(6_000); // past the 4 s re-warm delay

    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});
    const row = page.locator(`[data-production-row="${id}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });

    await page.goto("/starter-story/production");
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});
    await expect(page.locator(`[data-production-row="${id}"]`)).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    if (ids.length) await sql`DELETE FROM production_items WHERE id IN ${sql(ids)}`;
    await sql.end();
  }
});
