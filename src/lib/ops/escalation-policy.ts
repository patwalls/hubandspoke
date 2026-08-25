/**
 * Decision logic for the ops loop's GitHub escalation channel.
 *
 * Split out from `scripts/ops-escalate.ts` so the rules that decide *whether a human
 * gets pinged* are unit-testable without a GitHub round-trip. Everything here is pure;
 * the CLI owns the `gh` calls and the state file.
 *
 * The problem these rules exist to solve: laps run with fresh context, so without
 * durable state every lap re-discovers the same finding and re-reports it at the same
 * volume forever. Streaks give a finding a trend, the rate limiter caps the blast
 * radius, and cooldown/wontfix let a human decision survive into future laps.
 */

export type Severity = "attn" | "warn" | "crit";

export const SEVERITY_RANK: Record<Severity, number> = {
  attn: 0,
  warn: 1,
  crit: 2,
};

export interface EscalationRecord {
  kind: "issue" | "pr";
  number: number;
  /** Severity at the time the artifact was created or last raised. */
  severity: Severity;
  createdAt: string;
}

export interface FindingState {
  /** Consecutive laps this finding has been reported in. */
  streak: number;
  firstSeenAt: string;
  lastSeenAt: string;
  severity: Severity;
  escalation?: EscalationRecord;
  /** Closed by a human with `wontfix` — never raise again. */
  suppressedForever?: boolean;
  /** Closed by a human without `wontfix` — stay quiet until this passes. */
  cooldownUntil?: string;
}

export interface OpsState {
  findings: Record<string, FindingState>;
  /** ISO timestamps of GitHub artifacts created, for the rate limiter. */
  creations: string[];
}

export interface PolicyConfig {
  escalateAfterLaps: Record<Severity, number>;
  sameLapWindowMs: number;
  staleAfterMs: number;
  maxCreationsPerWindow: number;
  rateWindowMs: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  // A finding must survive this many consecutive laps before it earns a human's
  // attention. The 2026-08-09 Mac swap dip (612 MB for one lap, recovered by the
  // next) is the case this exists to swallow.
  escalateAfterLaps: { attn: Number.POSITIVE_INFINITY, warn: 3, crit: 2 },
  // Two reports inside this window are one lap double-reporting, not two laps.
  sameLapWindowMs: 30 * 60_000,
  // Unreported for this long (≈3 missed hourly laps) => the condition cleared.
  staleAfterMs: 3.5 * 60 * 60_000,
  maxCreationsPerWindow: 2,
  rateWindowMs: 90 * 60_000,
};

export type ReportAction =
  /** Recorded locally; nothing reaches GitHub. */
  | { type: "track"; reason: string }
  /** Open a new issue (or draft PR). */
  | { type: "create" }
  /** Silent body edit on the existing artifact — no notification. */
  | { type: "refresh"; kind: "issue" | "pr"; number: number }
  /** Severity climbed: comment + swap the severity label. */
  | {
      type: "raise";
      kind: "issue" | "pr";
      number: number;
      from: Severity;
      to: Severity;
    }
  | { type: "suppressed"; reason: string }
  | { type: "rate-limited"; reason: string };

export interface ReportInput {
  fingerprint: string;
  severity: Severity;
  now: Date;
}

export interface ReportDecision {
  action: ReportAction;
  finding: FindingState;
}

export function emptyState(): OpsState {
  return { findings: {}, creations: [] };
}

/**
 * Decide what a single `report` invocation should do. Returns the action plus the
 * finding's next state; the caller persists it only after the GitHub call succeeds
 * (so a failed `gh` doesn't burn the streak).
 */
export function decideReport(
  state: OpsState,
  input: ReportInput,
  config: PolicyConfig = DEFAULT_POLICY,
): ReportDecision {
  const nowIso = input.now.toISOString();
  const prior = state.findings[input.fingerprint];

  // A finding seen again within the same-lap window is the same sighting — keep the
  // streak, refresh the timestamp. Otherwise it's a new lap and the streak grows.
  const sameLap =
    prior !== undefined &&
    input.now.getTime() - Date.parse(prior.lastSeenAt) < config.sameLapWindowMs;

  const finding: FindingState = {
    streak: prior ? (sameLap ? prior.streak : prior.streak + 1) : 1,
    firstSeenAt: prior?.firstSeenAt ?? nowIso,
    lastSeenAt: nowIso,
    // Severity is allowed to climb and fall; the escalation record remembers what
    // GitHub was last told, which is what `raise` compares against.
    severity: input.severity,
    escalation: prior?.escalation,
    suppressedForever: prior?.suppressedForever,
    cooldownUntil: prior?.cooldownUntil,
  };

  if (finding.suppressedForever) {
    return {
      action: { type: "suppressed", reason: "closed as wontfix by a human" },
      finding,
    };
  }

  if (finding.cooldownUntil && Date.parse(finding.cooldownUntil) > input.now.getTime()) {
    return {
      action: {
        type: "suppressed",
        reason: `closed by a human; quiet until ${finding.cooldownUntil}`,
      },
      finding,
    };
  }

  if (finding.escalation) {
    const known = finding.escalation.severity;
    if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[known]) {
      return {
        action: {
          type: "raise",
          kind: finding.escalation.kind,
          number: finding.escalation.number,
          from: known,
          to: input.severity,
        },
        finding,
      };
    }
    // Already escalated and not worse: keep the artifact current *silently*. Editing
    // a body sends no notification; commenting would, every single lap.
    return {
      action: {
        type: "refresh",
        kind: finding.escalation.kind,
        number: finding.escalation.number,
      },
      finding,
    };
  }

  const needed = config.escalateAfterLaps[input.severity];
  if (!Number.isFinite(needed)) {
    return {
      action: { type: "track", reason: `severity ${input.severity} never escalates` },
      finding,
    };
  }
  if (finding.streak < needed) {
    return {
      action: {
        type: "track",
        reason: `seen ${finding.streak}/${needed} laps`,
      },
      finding,
    };
  }

  if (recentCreations(state, input.now, config).length >= config.maxCreationsPerWindow) {
    return {
      action: {
        type: "rate-limited",
        reason: `${config.maxCreationsPerWindow} already opened in the last ${Math.round(
          config.rateWindowMs / 60_000,
        )}m`,
      },
      finding,
    };
  }

  return { action: { type: "create" }, finding };
}

export function recentCreations(
  state: OpsState,
  now: Date,
  config: PolicyConfig = DEFAULT_POLICY,
): string[] {
  const cutoff = now.getTime() - config.rateWindowMs;
  return state.creations.filter((iso) => Date.parse(iso) >= cutoff);
}

/**
 * Findings that stopped being reported. The caller closes any GitHub artifact and
 * drops the local record — a condition that cleared should not linger as an open
 * issue, and a genuine recurrence will start a fresh streak.
 */
export function decideSweep(
  state: OpsState,
  now: Date,
  config: PolicyConfig = DEFAULT_POLICY,
): Array<{ fingerprint: string; finding: FindingState }> {
  const cutoff = now.getTime() - config.staleAfterMs;
  return Object.entries(state.findings)
    .filter(([, f]) => Date.parse(f.lastSeenAt) < cutoff)
    // A wontfix suppression is a standing human decision — it must outlive the
    // condition disappearing, or the next recurrence re-opens what was declined.
    .filter(([, f]) => !f.suppressedForever)
    .map(([fingerprint, finding]) => ({ fingerprint, finding }));
}

/** Body marker that ties a GitHub artifact back to a fingerprint. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- ops-fingerprint: ${fingerprint} -->`;
}

export function parseFingerprint(body: string | null | undefined): string | null {
  const match = /<!--\s*ops-fingerprint:\s*(.+?)\s*-->/.exec(body ?? "");
  return match ? match[1] : null;
}

/**
 * Label the loop stamps on an artifact it closes itself (condition stopped being
 * reported). Without it, the loop cannot tell its own close apart from a human's:
 * both are authored by the token owner, so `closedBy` is useless here.
 */
export const AUTO_CLOSED_LABEL = "ops:auto-closed";

/**
 * Why a tracked artifact is not OPEN. `wontfix` is a standing human decline,
 * `human` is a plain human close (mute for a cooldown), and `auto` is the loop's
 * own sweep — which must NOT mute anything, or a finding the loop auto-resolved
 * can never be raised again when it recurs.
 */
export function classifyClose(
  labels: Array<{ name: string }> | null | undefined,
): "wontfix" | "auto" | "human" {
  const names = (labels ?? []).map((l) => l.name);
  if (names.includes("wontfix")) return "wontfix";
  if (names.includes(AUTO_CLOSED_LABEL)) return "auto";
  return "human";
}

export function severityLabel(severity: Severity): string {
  return `ops:${severity}`;
}
