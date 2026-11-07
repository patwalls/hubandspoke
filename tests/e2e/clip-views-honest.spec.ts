import { test, expect } from "@playwright/test";
import { WHATS_NEW } from "../../src/lib/whats-new/entries";

// Est. Views on clip-idea rows now uses the history-based predictor (the
// number itself is pinned by src/lib/services/production-report.test.ts — the
// e2e DB has no clip ideas). Here: the Queue still renders in its default
// state and the fix's What's new card explains the change.
test("Queue renders and the Est. Views fix is in What's new", async ({ page }) => {
  await page.goto("/starter-story/queue");
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
  await expect(page.getByRole("button", { name: /^History/ }).first()).toBeVisible();

  await page.getByRole("button", { name: /^Learn:/ }).click();
  await page.getByRole("menuitem", { name: "What's new" }).click();
  const list = page.getByRole("dialog", { name: "What's new" });
  const card = WHATS_NEW.find((e) => e.id === "2026-11-07-clip-views-honest")!;
  const title = list.getByText(card.title, { exact: true });
  await title.scrollIntoViewIfNeeded();
  await expect(title).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();

  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
});
