#!/usr/bin/env npx tsx
/**
 * ops-escalate — the ops loop's only channel to a human.
 *
 * A `/lap` self-heals what it's allowed to and says nothing about it. Everything it
 * *can't* or *shouldn't* fix on its own comes through here and lands in GitHub, where
 * the whole team can see it, argue with it, and close it.
 *
 * GitHub is deliberately the state store rather than a table in our DB: open/closed is
 * acknowledgement, `wontfix` is a permanent mute, and a closed issue is how a human
 * decision reaches a lap that starts with no memory of the conversation.
 *
 *   # a finding the loop can't fix (opens an issue once it survives the streak gate)
 *   npx tsx scripts/ops-escalate.ts report \
 *     --fingerprint "sync-error:linkedin:company-page-url" \
 *     --severity warn \
 *     --title "LinkedIn sync failing: account missing company page URL" \
 *     --body-file /tmp/evidence.md
 *
 *   # same, but the loop wrote the fix and pushed a branch — opens a DRAFT PR instead
 *   npx tsx scripts/ops-escalate.ts report ... --branch ops/fix-linkedin-guard
 *
 *   # the condition cleared
 *   npx tsx scripts/ops-escalate.ts resolve --fingerprint "..." --note "cleared after v773"
 *
 *   # what's open + what's building toward escalation (run at lap start; also sweeps)
 *   npx tsx scripts/ops-escalate.ts status
 *
 * Notification discipline, because the point is to be quiet:
 *  - Nothing reaches GitHub until a finding survives 3 laps (2 for CRIT).
 *  - An already-open finding gets its body EDITED, which GitHub does not notify on.
 *    A comment fires only when severity climbs or the finding resolves.
 *  - At most 2 new artifacts per 90 minutes, no matter how bad the lap is.
 *  - Closing the issue mutes it for 7 days; closing it with `wontfix` mutes it forever.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_POLICY,
  decideReport,
  decideSweep,
  emptyState,
  fingerprintMarker,
  parseFingerprint,
  severityLabel,
  type FindingState,
  type OpsState,
  type Severity,
  AUTO_CLOSED_LABEL,
  classifyClose,
} from "../src/lib/ops/escalation-policy";

const STATE_PATH = join(homedir(), ".claude", "hubandspoke-ops-state.json");
const OPS_LABEL = "ops-loop";
const COOLDOWN_DAYS = 7;

type Kind = "issue" | "pr";

// ---------------------------------------------------------------- state

function loadState(): OpsState {
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as OpsState;
    return { findings: parsed.findings ?? {}, creations: parsed.creations ?? [] };
  } catch {
    // A corrupt state file must not wedge the loop. Worst case we re-derive from
    // GitHub on the next create (the marker search is state-independent).
    console.error("! ops state unreadable; starting fresh");
    return emptyState();
  }
}

function saveState(state: OpsState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  // Keep the rate-limiter list from growing without bound.
  const cutoff = Date.now() - 24 * 3_600_000;
  state.creations = state.creations.filter((iso) => Date.parse(iso) >= cutoff);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------- gh

function gh(args: string[], stdin?: string): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input: stdin,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`gh ${args.join(" ")} failed: ${e.stderr || e.message}`);
  }
}

function ensureLabels(): void {
  const specs: Array<[string, string, string]> = [
    [OPS_LABEL, "5319e7", "Raised by the automated ops loop"],
    [severityLabel("warn"), "fbca04", "Ops loop: degraded, not urgent"],
    [severityLabel("crit"), "b60205", "Ops loop: needs attention now"],
    [AUTO_CLOSED_LABEL, "c5def5", "Closed by the ops loop itself, not by a human"],
  ];
  for (const [name, color, description] of specs) {
    try {
      gh(["label", "create", name, "--color", color, "--description", description]);
    } catch {
      // Already exists — the only expected failure, and re-creating is not worth a
      // second round-trip to confirm.
    }
  }
}

interface Artifact {
  number: number;
  state: string;
  body: string;
  labels: Array<{ name: string }>;
  kind: Kind;
}

/** Find an existing artifact carrying this fingerprint, open or closed. */
function findByFingerprint(fingerprint: string): Artifact | null {
  const fields = "number,state,body,labels";
  for (const kind of ["issue", "pr"] as Kind[]) {
    const raw = gh([
      kind,
      "list",
      "--state",
      "all",
      "--label",
      OPS_LABEL,
      "--limit",
      "100",
      "--json",
      fields,
    ]);
    const rows = JSON.parse(raw || "[]") as Omit<Artifact, "kind">[];
    const hit = rows.find((r) => parseFingerprint(r.body) === fingerprint);
    if (hit) return { ...hit, kind };
  }
  return null;
}

function viewArtifact(kind: Kind, number: number): Artifact {
  const raw = gh([
    kind,
    "view",
    String(number),
    "--json",
    "number,state,body,labels",
  ]);
  return { ...(JSON.parse(raw) as Omit<Artifact, "kind">), kind };
}

// ---------------------------------------------------------------- body

function composeBody(opts: {
  fingerprint: string;
  severity: Severity;
  finding: FindingState;
  evidence: string;
  suggestion?: string;
}): string {
  const { fingerprint, severity, finding, evidence } = opts;
  const fmt = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";
  return [
    fingerprintMarker(fingerprint),
    "",
    `**${severity.toUpperCase()}** · first seen ${fmt(finding.firstSeenAt)} · ` +
      `seen in ${finding.streak} consecutive laps · last ${fmt(finding.lastSeenAt)}`,
    "",
    evidence.trim(),
    "",
    "---",
    "",
    "<sub>Raised by the Hub & Spoke ops loop (`/lap`). It re-checks this every lap and " +
      "updates this description silently — it will comment only if severity rises, and " +
      "will close this on its own if the condition clears. **Close it to mute for " +
      `${COOLDOWN_DAYS} days; close it with the \`wontfix\` label to mute it permanently.**</sub>`,
  ].join("\n");
}

// ---------------------------------------------------------------- commands

function cmdReport(args: Args): void {
  const fingerprint = required(args, "fingerprint");
  const severity = required(args, "severity") as Severity;
  if (!["attn", "warn", "crit"].includes(severity)) {
    fail(`--severity must be attn|warn|crit (got ${severity})`);
  }
  const title = required(args, "title");
  const evidence = args["body-file"]
    ? readFileSync(args["body-file"] as string, "utf8")
    : ((args.body as string) ?? "");
  const branch = args.branch as string | undefined;
  const dryRun = Boolean(args["dry-run"]);

  const state = loadState();
  const now = new Date();
  const { action, finding } = decideReport(state, { fingerprint, severity, now });

  const commit = (next: FindingState) => {
    state.findings[fingerprint] = next;
    if (!dryRun) saveState(state);
  };

  switch (action.type) {
    case "track":
    case "suppressed":
    case "rate-limited": {
      commit(finding);
      console.log(`${action.type}: ${fingerprint} — ${action.reason}`);
      return;
    }

    case "refresh":
    case "raise": {
      // Check GitHub before writing: the artifact may have been closed by a human
      // since the last lap, and that decision has to win.
      const live = dryRun
        ? { state: "OPEN", labels: [] as Array<{ name: string }> }
        : viewArtifact(action.kind, action.number);
      if (live.state !== "OPEN") {
        const closedBy = classifyClose(live.labels);
        const next: FindingState = { ...finding, escalation: undefined };
        if (closedBy === "auto") {
          // The loop closed this itself when the condition went quiet, and the
          // condition is back. Forget the artifact and let the next report open a
          // fresh one — muting here would make any auto-resolved finding unraisable.
          commit(next);
          console.log(
            `reopening: ${fingerprint} — #${action.number} was auto-closed by the loop, condition is back`,
          );
          return;
        }
        if (closedBy === "wontfix") next.suppressedForever = true;
        else
          next.cooldownUntil = new Date(
            now.getTime() + COOLDOWN_DAYS * 24 * 3_600_000,
          ).toISOString();
        commit(next);
        console.log(
          `suppressed: ${fingerprint} — #${action.number} closed by a human` +
            (closedBy === "wontfix"
              ? " as wontfix (permanent)"
              : ` (quiet ${COOLDOWN_DAYS}d)`),
        );
        return;
      }

      const body = composeBody({ fingerprint, severity, finding, evidence });
      if (dryRun) {
        console.log(`[dry-run] ${action.type} #${action.number}\n${body}`);
        return;
      }
      gh([action.kind, "edit", String(action.number), "--body-file", "-"], body);
      if (action.type === "raise") {
        gh(
          [action.kind, "comment", String(action.number), "--body-file", "-"],
          `Severity raised **${action.from.toUpperCase()} → ${action.to.toUpperCase()}** ` +
            `after ${finding.streak} consecutive laps.`,
        );
        gh([
          action.kind,
          "edit",
          String(action.number),
          "--add-label",
          severityLabel(action.to),
          "--remove-label",
          severityLabel(action.from),
        ]);
        finding.escalation = { ...finding.escalation!, severity: action.to };
      }
      commit(finding);
      console.log(
        `${action.type}: ${fingerprint} — #${action.number}` +
          (action.type === "refresh" ? " (silent)" : ""),
      );
      return;
    }

    case "create": {
      if (dryRun) {
        console.log(
          `[dry-run] would open ${branch ? "draft PR" : "issue"}: ${title}\n` +
            composeBody({ fingerprint, severity, finding, evidence }),
        );
        return;
      }
      ensureLabels();

      // State-independent duplicate guard: if the state file was lost or the loop
      // moved machines, the marker in GitHub is the source of truth.
      const existing = findByFingerprint(fingerprint);
      if (existing && existing.state === "OPEN") {
        finding.escalation = {
          kind: existing.kind,
          number: existing.number,
          severity,
          createdAt: now.toISOString(),
        };
        commit(finding);
        console.log(`adopted: ${fingerprint} — existing #${existing.number}`);
        return;
      }
      // A previously auto-closed artifact is not a decision — fall through and open
      // a fresh one. Only a human close (or `wontfix`) mutes the fingerprint.
      if (existing && existing.state !== "OPEN" && classifyClose(existing.labels) !== "auto") {
        const wontfix = classifyClose(existing.labels) === "wontfix";
        const next: FindingState = { ...finding };
        if (wontfix) next.suppressedForever = true;
        else
          next.cooldownUntil = new Date(
            now.getTime() + COOLDOWN_DAYS * 24 * 3_600_000,
          ).toISOString();
        commit(next);
        console.log(
          `suppressed: ${fingerprint} — #${existing.number} was closed by a human` +
            (wontfix ? " as wontfix" : ""),
        );
        return;
      }

      const body = composeBody({ fingerprint, severity, finding, evidence });
      const labels = ["--label", OPS_LABEL, "--label", severityLabel(severity)];
      let number: number;
      let kind: Kind;
      if (branch) {
        const out = gh(
          [
            "pr",
            "create",
            "--draft",
            "--base",
            "main",
            "--head",
            branch,
            "--title",
            title,
            "--body-file",
            "-",
            ...labels,
          ],
          body,
        );
        number = numberFromUrl(out);
        kind = "pr";
      } else {
        const out = gh(
          ["issue", "create", "--title", title, "--body-file", "-", ...labels],
          body,
        );
        number = numberFromUrl(out);
        kind = "issue";
      }
      finding.escalation = { kind, number, severity, createdAt: now.toISOString() };
      state.creations.push(now.toISOString());
      commit(finding);
      console.log(`created: ${fingerprint} — ${kind} #${number}`);
      return;
    }
  }
}

function cmdResolve(args: Args): void {
  const fingerprint = required(args, "fingerprint");
  const note = (args.note as string) ?? "Condition no longer detected.";
  const dryRun = Boolean(args["dry-run"]);
  const state = loadState();
  const finding = state.findings[fingerprint];

  if (!finding) {
    console.log(`resolve: ${fingerprint} — not tracked, nothing to do`);
    return;
  }
  if (finding.escalation && !dryRun) {
    closeArtifact(finding.escalation.kind, finding.escalation.number, note);
  }
  delete state.findings[fingerprint];
  if (!dryRun) saveState(state);
  console.log(
    `resolved: ${fingerprint}` +
      (finding.escalation ? ` — closed #${finding.escalation.number}` : ""),
  );
}

function closeArtifact(kind: Kind, number: number, note: string): void {
  gh(
    [kind, "comment", String(number), "--body-file", "-"],
    `Resolved automatically by the ops loop — ${note}`,
  );
  // Stamp before closing: this is the only durable record that the close was the
  // loop's own sweep and not a human decision (both are authored by the same token).
  ensureLabels();
  try {
    gh([kind, "edit", String(number), "--add-label", AUTO_CLOSED_LABEL]);
  } catch {
    // Labelling is best-effort; failing to label must not leave the artifact open.
  }
  gh([kind, "close", String(number)]);
}

function cmdStatus(args: Args): void {
  const dryRun = Boolean(args["dry-run"]);
  const state = loadState();
  const now = new Date();

  // Sweeping here (rather than in its own command) means a lap that only ever calls
  // `status` still auto-closes findings whose condition cleared.
  const stale = decideSweep(state, now);
  for (const { fingerprint, finding } of stale) {
    if (finding.escalation && !dryRun) {
      closeArtifact(
        finding.escalation.kind,
        finding.escalation.number,
        `not seen in any lap since ${finding.lastSeenAt}.`,
      );
      console.log(`auto-closed: ${fingerprint} — #${finding.escalation.number}`);
    }
    delete state.findings[fingerprint];
  }
  // Stamp every status run, swept or not: this is the heartbeat `decideSweep` reads to
  // tell "the condition stopped happening" apart from "the loop stopped looking".
  state.lastLapAt = now.toISOString();
  if (!dryRun) saveState(state);

  const entries = Object.entries(state.findings);
  if (entries.length === 0) {
    console.log("no open ops findings");
    return;
  }
  for (const [fingerprint, f] of entries.sort(
    (a, b) => b[1].streak - a[1].streak,
  )) {
    const needed = DEFAULT_POLICY.escalateAfterLaps[f.severity];
    const where = f.suppressedForever
      ? "MUTED (wontfix)"
      : f.cooldownUntil && Date.parse(f.cooldownUntil) > now.getTime()
        ? `MUTED until ${f.cooldownUntil.slice(0, 10)}`
        : f.escalation
          ? `${f.escalation.kind.toUpperCase()} #${f.escalation.number}`
          : `tracking ${f.streak}/${Number.isFinite(needed) ? needed : "never"}`;
    console.log(
      `${f.severity.toUpperCase().padEnd(4)} ${where.padEnd(22)} ${fingerprint} ` +
        `(${f.streak} laps, last ${f.lastSeenAt.slice(0, 16)}Z)`,
    );
  }
}

// ---------------------------------------------------------------- plumbing

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command, ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return { command: command ?? "", args };
}

function required(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) fail(`--${key} is required`);
  return value as string;
}

function numberFromUrl(url: string): number {
  const match = /\/(\d+)\s*$/.exec(url.trim());
  if (!match) throw new Error(`could not parse a number out of gh output: ${url}`);
  return Number(match[1]);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const { command, args } = parseArgs(process.argv.slice(2));
try {
  if (command === "report") cmdReport(args);
  else if (command === "resolve") cmdResolve(args);
  else if (command === "status" || command === "sweep") cmdStatus(args);
  else fail(`unknown command "${command}" (expected report|resolve|status)`);
} catch (err) {
  fail((err as Error).message);
}
