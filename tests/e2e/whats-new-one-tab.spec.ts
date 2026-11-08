import { test, expect } from "@playwright/test";

// Opening several posts in tabs at once used to pop What's new in every tab
// (the server only learns it was seen on dismiss). Now the first tab claims
// it in localStorage and the rest stay quiet — popup-claim.ts, unit-tested.
test("What's new pops up in one tab at most, not in every tab", async ({ context }) => {
  const first = await context.newPage();
  await first.goto("/");
  await first.waitForLoadState("networkidle");
  const second = await context.newPage();
  await second.goto("/");
  await second.waitForLoadState("networkidle");

  const shown =
    (await first.getByRole("dialog", { name: "What's new" }).count()) +
    (await second.getByRole("dialog", { name: "What's new" }).count());
  expect(shown).toBeLessThanOrEqual(1);
  // The second tab is the page as it opens — no pop-up on top of it.
  await expect(second.getByRole("dialog", { name: "What's new" })).toHaveCount(0);

  // The full list is still one click away.
  await second.getByRole("button", { name: /^Learn:/ }).click();
  await second.getByRole("menuitem", { name: "What's new" }).click();
  await expect(second.getByRole("dialog", { name: "What's new" })).toBeVisible();
  await second.getByRole("button", { name: "Got it" }).click();
  await expect(second.getByRole("dialog")).toHaveCount(0);
  if (process.env.E2E_SHOT) await second.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
});
