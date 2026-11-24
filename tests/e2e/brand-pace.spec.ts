import { test, expect } from "@playwright/test";

// "Brands this week" on /all: one collapsed line under the goal tiles; opening
// it lists every brand's week, each row a link to that brand's dashboard.
test("/all shows a collapsed Brands this week line that opens to every brand", async ({ page }) => {
  await page.goto("/all");
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
  const strip = page.getByTestId("brand-pace-strip");
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("heading", { name: "Brands this week" })).toBeVisible();
  // Collapsed by default: no rows until it's opened.
  await expect(page.getByTestId("brand-pace-row")).toHaveCount(0);
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

  await strip.getByRole("button", { name: /Brands this week/ }).click();
  const row = page.getByTestId("brand-pace-row").first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("href", /^\/[a-z0-9-]+$/);

  // Brand dashboards don't carry it — it's /all's.
  await page.goto("/starter-story");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("brand-pace-strip")).toHaveCount(0);
});
