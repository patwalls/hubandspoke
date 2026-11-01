import { test, expect, type Page } from "@playwright/test";

async function dismissWhatsNew(page: Page) {
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
}

// content-list-fast M1: coming back to the Content list shows the last report
// at once (refreshed quietly behind it), and a filter change keeps the rows on
// screen, dimmed, instead of blanking the page to a spinner. The report is
// slowed on purpose so a spinner would be caught if it showed.
test("Content list comes back instantly and keeps rows while refiltering", async ({ page }) => {
  await page.goto("/starter-story/content");
  await dismissWhatsNew(page);
  const empty = page.getByText("No content items found for the selected filters.");
  await expect(empty).toBeVisible();

  let reportCalls = 0;
  await page.route("**/api/reports/content?**", async (route) => {
    reportCalls += 1;
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  // Leave client-side (the sidebar link), then come back with browser Back.
  await page.getByRole("link", { name: "In Production" }).first().click();
  await page.waitForURL(/\/starter-story\/production/);
  await page.goBack();
  await page.waitForURL(/\/starter-story\/content$/);
  await expect(empty).toBeVisible({ timeout: 1000 });
  await expect(page.getByText("Loading content...")).toHaveCount(0);
  // …and it still refreshed behind the remembered report.
  await expect.poll(() => reportCalls).toBeGreaterThan(0);

  // A filter change: rows stay, dimmed, no spinner.
  await page.getByText(/^Platform/, { exact: false }).first().click();
  await page
    .locator("[role=menu], [role=listbox], [role=dialog]")
    .getByText(/^YouTube$/i)
    .first()
    .click();
  await expect(page).toHaveURL(/[?&]platform=/);
  await expect(page.locator("[aria-busy=true]")).toBeVisible();
  await expect(page.getByText("Loading content...")).toHaveCount(0);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0, { timeout: 10_000 });

  // The whole page in its default state, for the loop's visual check.
  await page.keyboard.press("Escape");
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
});
