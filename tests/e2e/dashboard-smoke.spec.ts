import { test, expect } from "@playwright/test";

/**
 * Smoke test — proves the toolchain is wired and an authenticated user
 * can land on the dashboard. Real coverage grows from here as we identify
 * surfaces that benefit from end-to-end verification.
 *
 * Auth state comes from `auth.setup.ts` via `storageState` — see
 * `playwright.config.ts`.
 */
test("dashboard renders for an authenticated user", async ({ page }) => {
  await page.goto("/");
  // We're authenticated; bare `/` redirects to the default brand landing
  // page (e.g. `/starter-story`). What we care about is that we're NOT
  // bounced back to login.
  await expect(page).not.toHaveURL(/\/login/);
  // The Hub & Spoke wordmark sits in the top-left nav rail.
  await expect(page.getByText(/hub & spoke/i).first()).toBeVisible();
});
