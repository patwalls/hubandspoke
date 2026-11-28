/**
 * A route that sets a production item's status expires the reports.
 *
 * In Production (and the Content list) read a cached report that lives up to
 * 60 s (services/production-report.ts). A write that moves an item between
 * statuses without `invalidateReportCaches()` leaves it in its old group for
 * that minute: the Publish dialog's route — the only way to Published /
 * Scheduled — never expired it, so a post just published still sat under
 * Ready To Publish when the publisher got back to the list (found by
 * publish-one-trip M7's e2e, 2026-11-28).
 *
 * The check is on the source: a route that inserts or updates
 * production_items AND writes a status value (`status: "Published"`,
 * `.set({ status`, `updates.status =`) must call invalidateReportCaches(.
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

const WRITES_ITEMS = /\.(update|insert)\(productionItems\)/;
const WRITES_STATUS = /status:\s*"[A-Z]|\.set\(\{\s*status\b|updates\.status\s*=/;

describe("status writes expire the In Production / Content reports", () => {
  const writers = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return WRITES_ITEMS.test(src) && WRITES_STATUS.test(src);
  });

  it("found the routes that write a status", () => {
    const rels = writers.map((f) => relative(API, f));
    expect(rels).toContain("production-items/[id]/publish/route.ts");
    expect(rels).toContain("brand-statuses/[id]/route.ts");
  });

  for (const file of writers) {
    const rel = relative(API, file);
    it(`${rel} expires the reports`, () => {
      expect(readFileSync(file, "utf8")).toContain("invalidateReportCaches(");
    });
  }
});
