import { defineConfig } from "vitest/config";

// Vitest config. Two kinds of tests live in the repo:
//
// - `*.test.ts` — pure unit tests. No network, no DB, no external
//   services. Run on every commit via `npm run test:unit`.
//
// - `*.integration.test.ts` — hit the real local Postgres via
//   DATABASE_URL from .env.local. Run with `npm run test:integration`.
//   Tests insert disposable fixtures and delete them in `afterEach`;
//   nothing leaks between runs.
//
// `npm run test` runs both. Tests run in a single fork (no parallelism)
// because graphile-worker's jobs table and the dev DB are global state
// and parallel tests can step on each other.
export default defineConfig({
  resolve: {
    // Native tsconfig-paths resolution (picks up the `@/*` alias from
    // tsconfig.json). Replaces the vite-tsconfig-paths plugin.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    globals: false,
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
    env: loadEnvFile(".env.local"),
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
        },
      },
    ],
  },
});

// Minimal .env parser so integration tests pick up DATABASE_URL without
// needing --env-file on every invocation.
function loadEnvFile(path: string): Record<string, string> {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(path)) return {};
    const raw = fs.readFileSync(path, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
