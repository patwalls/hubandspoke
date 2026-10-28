import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// .githooks/pre-push typechecks the commit being pushed to main, because a
// direct push deploys without CI's gate and a type error in a test file failed
// two Heroku builds (e2ac24f1 2026-10-21, 9506006f 2026-10-26).

const HOOK = join(process.cwd(), ".githooks/pre-push");
const TSC = join(process.cwd(), "node_modules/.bin/tsc");
const ZERO = "0".repeat(40);

let repo: string;
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

// A tiny repo whose committed index.ts has `source` as its body.
function repoWith(source: string): string {
  repo = mkdtempSync(join(tmpdir(), "hs-prepush-test-"));
  git("init", "-q");
  writeFileSync(join(repo, "tsconfig.json"), '{"compilerOptions":{"strict":true,"noEmit":true}}');
  writeFileSync(join(repo, "index.ts"), source);
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
  return git("rev-parse", "HEAD");
}

function push(remoteRef: string, sha: string) {
  return spawnSync("bash", [HOOK, "origin", "git@example:x.git"], {
    cwd: repo,
    input: `refs/heads/x ${sha} ${remoteRef} ${ZERO}\n`,
    env: { ...process.env, HS_PREPUSH_TYPECHECK: `${TSC} --noEmit -p .` },
    encoding: "utf8",
  });
}

describe("pre-push hook", () => {
  it("refuses a push to main that does not typecheck", () => {
    const sha = repoWith("const n: number = 'not a number';\n");
    const r = push("refs/heads/main", sha);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Push refused");
  });

  it("lets a push to main through when it typechecks", () => {
    const sha = repoWith("export const n: number = 1;\n");
    expect(push("refs/heads/main", sha).status).toBe(0);
  });

  it("checks the pushed commit, not the working tree", () => {
    const sha = repoWith("const n: number = 'not a number';\n");
    // Another session's uncommitted fix in the shared checkout must not rescue it.
    writeFileSync(join(repo, "index.ts"), "export const n: number = 1;\n");
    expect(push("refs/heads/main", sha).status).toBe(1);
  });

  it("leaves pushes to other branches alone", () => {
    const sha = repoWith("const n: number = 'not a number';\n");
    expect(push("refs/heads/app-loop/x", sha).status).toBe(0);
  });
});
