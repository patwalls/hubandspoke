import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// CI runs on our own forge (Forgejo on closet-cloud), never GitHub Actions.
// GitHub locked Actions over billing on 2026-11-19 and we are not unlocking it
// (~/code/cockpit/docs/forge.md). Any workflow left in .github/workflows still
// fires on GitHub, fails in ~4s ("account is locked due to a billing issue")
// and emails whoever pushed. On 2026-11-23 that sent Sam asking Pat to fix
// GitHub billing. Forgejo prefers .forgejo/workflows and ignores .github once
// that folder exists, so the real CI lives there.

const root = process.cwd();
const ghDir = join(root, ".github/workflows");
const forgeDir = join(root, ".forgejo/workflows");

describe("CI lives on the forge, not GitHub Actions", () => {
  it("GitHub has no workflow but the gate file the forge bridge reads", () => {
    // loop-auto-merge.yml stays: cockpit's forge bridge reads the merge gate
    // from that exact path (lib/loopsctl/forge.py WORKFLOWS).
    const files = existsSync(ghDir) ? readdirSync(ghDir) : [];
    expect(files.filter((f) => f !== "loop-auto-merge.yml")).toEqual([]);
  });

  it("the forge runs the build check and the health monitor", () => {
    const ci = readFileSync(join(forgeDir, "ci.yml"), "utf8");
    // The bridge and the "main: require build" ruleset wait on a job named build.
    expect(ci).toMatch(/^ {2}build:\n {4}name: build$/m);
    expect(existsSync(join(forgeDir, "health-monitor.yml"))).toBe(true);
  });

  it("the merge gate holds a loop PR that edits the forge's CI", () => {
    const gate = readFileSync(join(ghDir, "loop-auto-merge.yml"), "utf8");
    const held = /--name-only \| grep -E '([^']+)'/.exec(gate)?.[1];
    expect(held).toBeDefined();
    const re = new RegExp(held!);
    expect(re.test(".forgejo/workflows/ci.yml")).toBe(true);
    expect(re.test(".github/workflows/loop-auto-merge.yml")).toBe(true);
    expect(re.test("src/app/page.tsx")).toBe(false);
  });
});
