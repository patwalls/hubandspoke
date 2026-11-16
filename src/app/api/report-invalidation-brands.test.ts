/**
 * Every pipeline write names the brands it touched (production-instant).
 *
 * `invalidateReportCaches()` with no brands expires EVERY brand's In
 * Production report at once, and the after-edit re-warm then rebuilds them
 * one by one — so one cross-post or new post in any brand left most brands
 * cold for a minute (GET /api/reports/production p95 ~6 s, 2026-11-16).
 * A route that writes production items must pass `{ brands: [...] }`.
 * The bare form stays available for jobs that can't name a brand, but no
 * API route should need it — add one here only with the reason.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const API = join(__dirname);
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(p);
  }
})(API);

/** Routes allowed to expire every brand, with why. */
const EVERY_BRAND: Record<string, string> = {};

describe("API writes expire only the brands they touched", () => {
  it("found the routes that invalidate the reports", () => {
    const callers = files.filter((f) => readFileSync(f, "utf8").includes("invalidateReportCaches("));
    expect(callers.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of files) {
    const rel = relative(API, file);
    const src = readFileSync(file, "utf8");
    if (!src.includes("invalidateReportCaches(")) continue;
    it(`${rel} names its brands`, () => {
      const bare = src.match(/invalidateReportCaches\(\s*\)/g) ?? [];
      if (EVERY_BRAND[rel]) return;
      expect(bare, `${rel} calls invalidateReportCaches() with no brands — pass { brands: [...] }`).toEqual([]);
    });
  }
});
