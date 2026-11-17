import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/loop-e2e.sh is the product loop's browser check. Its dependency step reinstalls
// node_modules when package-lock.json changes, but used to keep Next's old build cache (.next),
// so after a Next upgrade every check failed until someone cleared it by hand (idea d15f20).
// Worse, the ship broker links Pat's checkout's .next into its worktree, so the check shared a
// cache with a different node_modules (16.4.1 there, 16.4.6 here on 2026-11-17).

const SCRIPT = join(process.cwd(), "scripts/loop-e2e.sh");
const LOCK = '{"lockfileVersion":3}\n';
const SUM = createHash("sha256").update(LOCK).digest("hex").slice(0, 16);

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A worktree whose node_modules is already installed for the current lockfile (so no npm ci).
function worktree(): string {
  dir = mkdtempSync(join(tmpdir(), "hs-loop-e2e-test-"));
  const wt = join(dir, "wt");
  mkdirSync(join(wt, "node_modules"), { recursive: true });
  writeFileSync(join(wt, "package-lock.json"), LOCK);
  writeFileSync(join(wt, "node_modules/.lock-sum"), SUM + "\n");
  return wt;
}

function prepare(wt: string) {
  const r = spawnSync("bash", [SCRIPT, "--deps-only"], { cwd: wt, encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout;
}

function cache(wt: string, stamp: string | null) {
  mkdirSync(join(wt, ".next/dev"), { recursive: true });
  writeFileSync(join(wt, ".next/dev/old-chunk.js"), "x");
  if (stamp !== null) writeFileSync(join(wt, ".next/.lock-sum"), stamp + "\n");
}

describe("loop-e2e.sh dependency step", () => {
  it("clears a .next written under other dependencies", () => {
    const wt = worktree();
    cache(wt, "0123456789abcdef");
    expect(prepare(wt)).toContain("cleared");
    expect(existsSync(join(wt, ".next/dev/old-chunk.js"))).toBe(false);
    expect(readFileSync(join(wt, ".next/.lock-sum"), "utf8").trim()).toBe(SUM);
  });

  it("clears a .next from before the stamp existed", () => {
    const wt = worktree();
    cache(wt, null);
    prepare(wt);
    expect(existsSync(join(wt, ".next/dev/old-chunk.js"))).toBe(false);
  });

  it("keeps a .next built under these dependencies (no cold compile every run)", () => {
    const wt = worktree();
    cache(wt, SUM);
    prepare(wt);
    expect(existsSync(join(wt, ".next/dev/old-chunk.js"))).toBe(true);
  });

  it("replaces a linked .next with its own and leaves the linked cache alone", () => {
    const wt = worktree();
    const other = join(dir, "pats-checkout-next");
    mkdirSync(other);
    writeFileSync(join(other, ".lock-sum"), SUM + "\n"); // even a matching stamp: still not ours
    writeFileSync(join(other, "chunk.js"), "x");
    symlinkSync(other, join(wt, ".next"));
    expect(prepare(wt)).toContain("was a link");
    expect(lstatSync(join(wt, ".next")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(other, "chunk.js"))).toBe(true);
    expect(readFileSync(join(wt, ".next/.lock-sum"), "utf8").trim()).toBe(SUM);
  });
});
