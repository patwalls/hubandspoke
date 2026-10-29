import { test, expect } from "@playwright/test";
import { WHATS_NEW } from "../../src/lib/whats-new/entries";

// The drafting change itself runs on the worker (no UI); what people see is
// the What's new card announcing it. It must pop on the next page load.
test("the drafts-learn-from-edits card pops up on the next page load", async ({ page }) => {
  const card = WHATS_NEW.find((e) => e.id === "2026-10-29-drafts-learn-edits")!;
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  let dialog = page.getByRole("dialog", { name: "What's new" });
  if (!(await dialog.isVisible())) {
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "What's new" }).click();
    dialog = page.getByRole("dialog", { name: "What's new" });
  }
  const title = dialog.getByText(card.title, { exact: true });
  await title.scrollIntoViewIfNeeded();
  await expect(title).toBeVisible();
  await expect(dialog.getByText(card.body)).toBeVisible();
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
});
