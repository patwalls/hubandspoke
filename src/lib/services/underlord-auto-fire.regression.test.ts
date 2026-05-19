import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the 2026-05-18 Underlord auto-fire kill switch.
// Underlord is Descript's paid AI agent (~$3.50 per call). Auto-firing it
// from cross-post / repost / threshold-monitor cascades burned $35 in 30
// minutes. The policy now: Underlord fires only on explicit clip-idea
// promote buttons.
//
// This file is intentionally a string-level assertion against the route
// source, NOT a runtime test. The runtime test would need to mock auth +
// build a fake source row + spy on enqueue; the string check catches
// re-introductions in one line and runs in milliseconds. If a contributor
// re-adds an `enqueue("descript-derivative-create", …)` call in either
// route, this test fails before code review ever sees the PR.

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("Underlord auto-fire is disabled in cross-post / repost / draft-algorithm", () => {
  it("cross-post route does not enqueue descript-derivative-create", () => {
    const src = readSource(
      "src/app/api/production-items/[id]/cross-post/route.ts",
    );
    // The kill-switch comment in the route mentions the task name in prose —
    // those are fine. We're catching the live `enqueue(` call site.
    expect(src).not.toMatch(
      /enqueue\(\s*["']descript-derivative-create["']/,
    );
  });

  it("repost route does not enqueue descript-derivative-create", () => {
    const src = readSource(
      "src/app/api/production-items/[id]/repost/route.ts",
    );
    expect(src).not.toMatch(
      /enqueue\(\s*["']descript-derivative-create["']/,
    );
  });

  it("draft-algorithm descript-step has the kill switch off", () => {
    const src = readSource("src/lib/services/draft-algorithm/descript-step.ts");
    expect(src).toMatch(/UNDERLORD_AUTO_FIRE_ENABLED\s*=\s*false/);
  });

  it("descript-clip-resolve does not call invokeDescriptAgent in the cold-chain branch", () => {
    const src = readSource("src/jobs/tasks/descript-clip-resolve.ts");
    // The whole cold-chain agent call was removed when the kill switch
    // landed. Importing the function would itself be a red flag.
    expect(src).not.toMatch(/\binvokeDescriptAgent\b/);
  });
});
