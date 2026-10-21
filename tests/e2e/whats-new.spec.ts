import { test, expect } from "@playwright/test";

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
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "What's new" }).click();
  const list = page.getByRole("dialog", { name: "What's new" });
  await expect(list).toBeVisible();
  await expect(list.getByText("New improvements, every few days")).toBeVisible();
});
