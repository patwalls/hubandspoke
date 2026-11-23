import { test, expect } from "@playwright/test";

// Flag brandSwitchKeepsSection (on for the e2e user): a brand chip in the nav
// keeps you on the same list page. From In Production, the "All" chip goes to
// All's In Production, not its dashboard, and records nav:brand-switch:production.
// The e2e DB has one brand, so "All" is the other brand to switch to.
test("switching brand from In Production stays on In Production", async ({ page }) => {
  const marks: string[] = [];
  page.on("request", (req) => {
    if (!req.url().endsWith("/api/usage") || req.method() !== "POST") return;
    const mark = (req.postDataJSON() as { mark?: string } | null)?.mark;
    if (mark) marks.push(mark);
  });

  await page.goto("/starter-story/production");
  const popup = page.getByRole("dialog", { name: "What's new" });
  await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
  await expect(popup).toBeHidden();

  const allChip = page.locator('a[href="/all/production"]').first();
  await expect(allChip).toBeVisible({ timeout: 15_000 });
  // The current brand's own chip points at the same page too.
  await expect(page.locator('a[href="/starter-story/production"]').first()).toBeAttached();

  await allChip.click();
  await expect(page).toHaveURL(/\/all\/production$/);
  await expect.poll(() => marks).toContain("nav:brand-switch:production");

  // From the dashboard the chips still go to dashboards, as before.
  await page.goto("/starter-story");
  await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});
  await expect(page.locator('a[href="/all"]').first()).toBeVisible({ timeout: 15_000 });

  await page.goto("/starter-story/production");
  await page.waitForLoadState("networkidle");
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
});
