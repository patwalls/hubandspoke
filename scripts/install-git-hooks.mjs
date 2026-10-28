// `npm install` → `prepare` → point git at the tracked hooks in .githooks/
// (the pre-push typecheck for main). A no-op outside a git checkout, which is
// where Heroku and CI tarball builds run.
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  // Not a git checkout (or no git binary) — nothing to install.
}
