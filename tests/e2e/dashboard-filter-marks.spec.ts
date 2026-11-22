import { test, expect } from "@playwright/test";

// The dashboard records which filter people change (dashboard:filter:<key>:<value>)
// so a later lap can tell "re-picks the same view every visit" from "explores".
// Landing on the dashboard records no filter mark; picking Monthly does.
test("changing a dashboard filter records one mark, landing records none", async ({ page }) => {
  const marks: string[] = [];
  page.on("request", (req) => {
    if (!req.url().endsWith("/api/usage") || req.method() !== "POST") return;
    const mark = (req.postDataJSON() as { mark?: string } | null)?.mark;
    if (mark) marks.push(mark);
  });

  await page.goto("/starter-story");
  const popup = page.getByRole("dialog", { name: "What's new" });
  await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
  await expect(popup).toBeHidden();
  await expect(page.getByText("Content Production").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  expect(marks.filter((m) => m.startsWith("dashboard:filter:"))).toEqual([]);

  await page.getByRole("button", { name: /^Weekly/ }).first().click();
  await page
    .locator("[role=menu], [role=listbox], [role=dialog]")
    .getByText(/^Monthly$/)
    .first()
    .click();
  await expect(page).toHaveURL(/[?&]viewType=monthly/);
  await expect
    .poll(() => marks.filter((m) => m.startsWith("dashboard:filter:")))
    .toEqual(["dashboard:filter:viewType:monthly"]);

  await page.keyboard.press("Escape");
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
});
