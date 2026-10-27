import { test, expect } from "@playwright/test";

/**
 * Queue → Newsletters (flag `newsletterDrafter`): opening an undrafted
 * scheduled issue (Daily Seinfeld / Sunday Breakfast) asks for its pillar
 * video and angle in the New-newsletter dialog, with the format and send
 * date already set, instead of the drafter picking its own stories
 * (Pat, 2026-10-27). Nothing is chosen for you: Create waits for a pick.
 * Read-only: never clicks Create (that's a paid drafter run).
 */
test.use({ viewport: { width: 1400, height: 950 } });

test("an undrafted queue newsletter opens the start dialog, pillar first", async ({ page }) => {
  const { flags } = await (await page.request.get("/api/feature-flags")).json();
  test.skip(flags.newsletterDrafter !== true, "e2e user does not have the newsletterDrafter flag");
  await page.goto("/starter-story/queue/newsletters");
  await page.getByRole("row").nth(1).waitFor({ timeout: 30_000 });
  const row = page.getByRole("row").filter({ hasText: "Daily Seinfeld" }).filter({ hasNotText: "Draft" }).first();
  test.skip((await row.count()) === 0, "no undrafted Daily Seinfeld issue in the local queue");
  await row.getByText("Starter Story |").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Start newsletter" })).toBeVisible({ timeout: 20_000 });
  const format = dialog.locator("select").first();
  await expect(format).toBeDisabled();
  await expect(format.locator("option:checked")).toHaveText(/Daily Seinfeld/);
  await expect(dialog.locator('input[type="date"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(dialog.locator('input[type="date"]')).toBeDisabled();

  const pillar = dialog.getByTestId("newsletter-pillar");
  await expect(pillar).toBeVisible({ timeout: 15_000 });
  await expect(pillar).toHaveValue("");
  await expect(dialog.getByTestId("new-newsletter-create")).toBeDisabled();
  await expect(dialog.getByTestId("new-content-angle")).toBeVisible();

  const first = pillar.locator("option:not([disabled])").first();
  test.skip((await first.count()) === 0, "no transcribed Starter Story video locally");
  await pillar.selectOption(await first.getAttribute("value"));
  await expect(dialog.getByTestId("new-newsletter-create")).toBeEnabled();
  await page.screenshot({ path: ".playwright-mcp/screenshots/newsletter-queue-start.png" });
});
