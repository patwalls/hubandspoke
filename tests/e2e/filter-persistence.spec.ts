import { test, expect } from "@playwright/test";

/**
 * Filter persistence — keep filtered list views shareable + restorable
 * across detail-page round-trips.
 *
 * Tests three things on the Content list (the canonical example):
 *   1. Applying a filter pushes the key into the URL.
 *   2. Clicking into a detail and using the browser back button lands
 *      back on the filtered list (URL is the source of truth, so the
 *      filter is restored automatically).
 *   3. The in-app `← Content` back link in the section-tabs row lands
 *      back on the filtered list too (via sessionStorage written by
 *      `useRememberListUrl`).
 *
 * If/when a new filtered surface is added (Production, Queue, Formats,
 * etc.), extend this file with an analogous test rather than spreading
 * filter checks across feature-specific specs.
 */

test.describe("filter persistence — Content list", () => {
  test("applying a filter pushes it into the URL", async ({ page }) => {
    await page.goto("/starter-story/content");
    await page.waitForLoadState("networkidle");
    // Filter chip — open the Platform picker and choose YouTube.
    await page.getByText(/^Platform/, { exact: false }).first().click();
    await page
      .locator("[role=menu], [role=listbox], [role=dialog]")
      .getByText(/^YouTube$/i)
      .first()
      .click();
    await expect(page).toHaveURL(/[?&]platform=youtube/);
  });

  test("browser back from detail restores the filter", async ({ page }) => {
    await page.goto("/starter-story/content?platform=youtube");
    await page.waitForLoadState("networkidle");
    // First content row deep-link.
    const firstRow = page
      .locator("table a[href*='/starter-story/content/']")
      .first();
    await firstRow.click();
    await page.waitForURL(/\/starter-story\/content\/[0-9a-f-]+/);
    await page.goBack();
    await expect(page).toHaveURL(/[?&]platform=youtube/);
  });

  test("'← Content' back link restores the filter", async ({ page }) => {
    await page.goto("/starter-story/content?platform=youtube");
    await page.waitForLoadState("networkidle");
    const firstRow = page
      .locator("table a[href*='/starter-story/content/']")
      .first();
    await firstRow.click();
    await page.waitForURL(/\/starter-story\/content\/[0-9a-f-]+/);
    // Section-tabs-row back link.
    await page.getByRole("link", { name: /^← Content/ }).first().click();
    await expect(page).toHaveURL(/[?&]platform=youtube/);
  });
});
