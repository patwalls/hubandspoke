import { test, expect } from "@playwright/test";

/**
 * The Content Production card on the dashboard swaps its table for charts
 * (Lines / Per <group> / Stacked). Golden path on the cross-brand /all view:
 * each view renders a chart, and the pick survives a reload.
 */
test("content production card switches between table and chart views", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/all");
  const card = page
    .locator("div.rounded-lg", { has: page.getByText(/Content Production \(by/) })
    .last();
  await expect(card).toBeVisible({ timeout: 45_000 });
  const view = (name: string | RegExp) => card.getByRole("radio", { name });

  await view("Lines").click();
  await expect(card.locator(".recharts-line").first()).toBeVisible();
  await expect(card.locator("table")).toHaveCount(0);

  await view(/^Per /).click();
  await expect(card.locator(".recharts-surface").nth(1)).toBeVisible();

  await view("Stacked").click();
  await expect(card.locator(".recharts-bar-rectangle").first()).toBeVisible();

  // Views per post is an average — stacking is off and Lines stands in.
  await card.getByRole("button", { name: "Views Per Post" }).click();
  await expect(view("Stacked")).toBeDisabled();
  await expect(view("Lines")).toHaveAttribute("aria-checked", "true");

  await page.reload();
  await expect(view("Stacked")).toHaveAttribute("aria-checked", "true", { timeout: 45_000 });

  await view("Table").click();
  await expect(card.locator("table")).toBeVisible();
});

/**
 * Wide ranges on /all are the ones that used to blow the web dyno's memory
 * (the report shipped every item). Year to date must load, and a filter
 * change must say it's updating rather than sit silent on stale data.
 */
test("year to date on /all loads and shows an updating state on filter change", async ({ page }) => {
  test.setTimeout(90_000);
  const jan1 = `${new Date().getFullYear()}-01-01`;
  await page.goto(`/all?startDate=${jan1}&viewType=monthly`);
  const card = page
    .locator("div.rounded-lg", { has: page.getByText(/Content Production \(by/) })
    .last();
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Failed to load dashboard data")).toHaveCount(0);

  await page.route("**/api/reports/content**", async (route) => {
    await new Promise((r) => setTimeout(r, 1000));
    await route.continue();
  });
  await page.getByRole("button", { name: /Monthly/ }).first().click();
  await page.getByText("Weekly", { exact: true }).click();
  await expect(page.getByText("Updating report…")).toBeVisible();
  await expect(page.getByText("Updating report…")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.getByText("Failed to load dashboard data")).toHaveCount(0);
});

/** The charts carry the table's Total row: an "All brands" chip that plots
 *  a total line on Lines, and a leading combined tile on Per brand. */
test("charts show an all-brands total", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/all?groupBy=brand");
  const card = page
    .locator("div.rounded-lg", { has: page.getByText(/Content Production \(by/) })
    .last();
  await expect(card).toBeVisible({ timeout: 45_000 });
  await card.getByRole("radio", { name: "Lines" }).click();
  const chip = card.getByRole("button", { name: /^All brands/ });
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  const lines = await card.locator(".recharts-line").count();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(card.locator(".recharts-line")).not.toHaveCount(lines);

  await card.getByRole("radio", { name: /^Per / }).click();
  await expect(card.getByText("All brands", { exact: true })).toBeVisible();
});
