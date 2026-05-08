import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load `.env.local` before reading any env vars below. Playwright doesn't
// pick this up automatically the way Next.js does — without this the
// auth-setup spec fails on the credentials check, and you'd get a confusing
// "missing E2E_TEST_USER_*" error even though the values live in
// `.env.local`. Use the Node 20+ `--env-file` equivalent via the experimental
// loader pattern: read + parse manually so we don't depend on `dotenv`.
const ENV_FILE = resolve(__dirname, ".env.local");
if (existsSync(ENV_FILE)) {
  for (const line of require("node:fs").readFileSync(ENV_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * Playwright config for committable end-to-end tests.
 *
 * Pattern matches the existing vitest split (unit / integration) — `tests/e2e`
 * lives alongside, owns the user-facing browser layer, and never imports app
 * code. Auth state is set up once via `auth.setup.ts` and reused via
 * `storageState` so individual specs don't pay the login cost.
 *
 * Required env (in `.env.local`):
 *   - E2E_TEST_USER_EMAIL — credentials for the test user
 *   - E2E_TEST_USER_PASSWORD
 *   See `docs/conventions.md` for how to seed via `scripts/seed-user.mjs`.
 *
 * Optional env:
 *   - E2E_BASE_URL — override the dev server target. Default
 *     `http://localhost:3000`.
 *
 * `npm run dev` is started by Playwright when the dev server isn't already
 * running. Pre-existing `npm run dev` (e.g. you have it open in a tab) is
 * reused.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Single shared dev DB — parallel tests stomp on each other's writes. Keep
  // serial until specs are designed for isolation (separate seed user per
  // worker, transactional rollback, etc.).
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // 30s default per assertion is plenty against a local dev server.
  timeout: 30 * 1000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // Logs in once + writes session cookie to disk. Other projects depend
    // on this so they inherit the auth state without re-typing creds.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    // Local dev: reuse the user's already-running dev server. CI: always
    // fresh boot.
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    // Inherit our env so the dev server sees the same DATABASE_URL / etc.
    stdout: "ignore",
    stderr: "pipe",
  },
});
