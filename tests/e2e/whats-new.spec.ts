import { test, expect } from "@playwright/test";
import { WHATS_NEW } from "../../src/lib/whats-new/entries";

// The What's new list is reachable from the user menu on every dashboard page,
// whether or not the pop-up already showed (it pops once per user).
test("user menu opens the What's new list", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
  // Dismissed means quiet: the next page load doesn't pop it again (and new
  // cards wait ~a day so they arrive together — popupFor, unit-tested).
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "What's new" }).click();
  const list = page.getByRole("dialog", { name: "What's new" });
  await expect(list).toBeVisible();
  await expect(list.getByText("Everything that's shipped lately, newest first.")).toBeVisible();
  // Newest first: the card that shipped last is the first thing you see.
  const newest = list.getByText(WHATS_NEW[0].title, { exact: true });
  await newest.scrollIntoViewIfNeeded();
  await expect(newest).toBeVisible();
  // The product loop's visual check (scripts/loop-e2e.sh) passes a path to look at.
  // The modal hides the closing menu from the a11y tree, so wait on the DOM.
  await expect(page.locator("[role=menu]")).toHaveCount(0);
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
});
