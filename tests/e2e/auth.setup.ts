import { test as setup, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const AUTH_FILE = "tests/e2e/.auth/user.json";

/**
 * Run once before any other e2e project.
 *
 * Logs in via the credentials form at /login (matches the real user flow —
 * `signIn("credentials", { email, password })` from `next-auth/react`),
 * then persists the resulting session cookie to `tests/e2e/.auth/user.json`.
 * Other projects load it via `storageState` so individual specs start
 * authenticated without re-typing credentials each time.
 *
 * The cookie file is gitignored — it carries a real session token.
 *
 * Required env (in `.env.local`):
 *   - E2E_TEST_USER_EMAIL
 *   - E2E_TEST_USER_PASSWORD
 *
 * See `docs/conventions.md` for the one-liner that seeds the test user.
 */
setup("authenticate", async ({ page }) => {
  const email = process.env.E2E_TEST_USER_EMAIL;
  const password = process.env.E2E_TEST_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "E2E_TEST_USER_EMAIL / E2E_TEST_USER_PASSWORD missing. " +
        "Add them to .env.local and seed the user via " +
        "`node --env-file=.env.local scripts/seed-user.mjs <email> <password>`. " +
        "See docs/conventions.md → End-to-end testing.",
    );
  }

  await page.goto("/login");
  // Hydration guard: filling a controlled React input BEFORE hydration sets
  // the DOM value but not React state — the form then submits empty and the
  // test stays on /login (observed flake 2026-08-10). Wait for the page to
  // go network-idle (hydration done), fill, and verify the value stuck;
  // re-fill once if the first fill raced.
  await page.waitForLoadState("networkidle");
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    if ((await page.getByLabel(/email/i).inputValue()) === email) break;
    await page.waitForTimeout(1000);
  }
  await page.getByRole("button", { name: /sign in/i }).click();

  // After login the app routes to its default brand landing page (e.g.
  // `/starter-story`); a brand-less `/` 302's there too. Either way we
  // just need to be off `/login`.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
  await expect(page.getByText(/hub & spoke/i).first()).toBeVisible();

  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
