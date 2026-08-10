import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLICY,
  decideReport,
  decideSweep,
  emptyState,
  parseFingerprint,
  fingerprintMarker,
  type OpsState,
  type Severity,
} from "./escalation-policy";

const T0 = new Date("2026-08-09T12:00:00.000Z");
const hoursLater = (n: number) => new Date(T0.getTime() + n * 3_600_000);

/** Report the same fingerprint once per simulated lap, one hour apart. */
function runLaps(
  state: OpsState,
  laps: number,
  severity: Severity = "warn",
  startHour = 0,
) {
  let decision = decideReport(state, {
    fingerprint: "fp",
    severity,
    now: hoursLater(startHour),
  });
  for (let i = 1; i < laps; i++) {
    state.findings.fp = decision.finding;
    decision = decideReport(state, {
      fingerprint: "fp",
      severity,
      now: hoursLater(startHour + i),
    });
  }
  state.findings.fp = decision.finding;
  return decision;
}

describe("escalation policy — when a human hears about it", () => {
  it("swallows a one-lap blip", () => {
    const state = emptyState();
    const { action } = runLaps(state, 1, "warn");
    expect(action).toEqual({ type: "track", reason: "seen 1/3 laps" });
  });

  it("escalates a WARN only on its third consecutive lap", () => {
    const state = emptyState();
    expect(runLaps(state, 2, "warn").action.type).toBe("track");

    const third = decideReport(state, {
      fingerprint: "fp",
      severity: "warn",
      now: hoursLater(2),
    });
    expect(third.action.type).toBe("create");
  });

  it("escalates a CRIT a lap sooner than a WARN", () => {
    const state = emptyState();
    expect(runLaps(state, 2, "crit").action.type).toBe("create");
  });

  it("never escalates ATTN, but still tracks it", () => {
    const state = emptyState();
    const { action, finding } = runLaps(state, 10, "attn");
    expect(action).toEqual({
      type: "track",
      reason: "severity attn never escalates",
    });
    expect(finding.streak).toBe(10);
  });

  it("does not let one lap reporting twice inflate the streak", () => {
    const state = emptyState();
    decideReport(state, { fingerprint: "fp", severity: "crit", now: T0 });
    state.findings.fp = decideReport(state, {
      fingerprint: "fp",
      severity: "crit",
      now: T0,
    }).finding;

    // Five minutes later — same lap retrying, not a new one.
    const again = decideReport(state, {
      fingerprint: "fp",
      severity: "crit",
      now: new Date(T0.getTime() + 5 * 60_000),
    });
    expect(again.finding.streak).toBe(1);
    expect(again.action.type).toBe("track");
  });
});

describe("escalation policy — staying quiet once escalated", () => {
  const escalated = (severity: Severity = "warn"): OpsState => ({
    findings: {
      fp: {
        streak: 3,
        firstSeenAt: T0.toISOString(),
        lastSeenAt: T0.toISOString(),
        severity,
        escalation: {
          kind: "issue",
          number: 42,
          severity,
          createdAt: T0.toISOString(),
        },
      },
    },
    creations: [T0.toISOString()],
  });

  it("refreshes silently instead of commenting when nothing changed", () => {
    const { action } = decideReport(escalated(), {
      fingerprint: "fp",
      severity: "warn",
      now: hoursLater(1),
    });
    expect(action).toEqual({ type: "refresh", kind: "issue", number: 42 });
  });

  it("comments only when severity climbs", () => {
    const { action } = decideReport(escalated("warn"), {
      fingerprint: "fp",
      severity: "crit",
      now: hoursLater(1),
    });
    expect(action).toMatchObject({ type: "raise", from: "warn", to: "crit" });
  });

  it("stays silent when severity falls back — no downgrade chatter", () => {
    const { action } = decideReport(escalated("crit"), {
      fingerprint: "fp",
      severity: "warn",
      now: hoursLater(1),
    });
    expect(action.type).toBe("refresh");
  });
});

describe("escalation policy — human decisions outlive fresh context", () => {
  it("never re-raises something closed as wontfix", () => {
    const state: OpsState = {
      findings: {
        fp: {
          streak: 9,
          firstSeenAt: T0.toISOString(),
          lastSeenAt: T0.toISOString(),
          severity: "crit",
          suppressedForever: true,
        },
      },
      creations: [],
    };
    const { action } = decideReport(state, {
      fingerprint: "fp",
      severity: "crit",
      now: hoursLater(500),
    });
    expect(action).toMatchObject({ type: "suppressed" });
  });

  it("honors a cooldown, then allows a genuine recurrence through", () => {
    const cooldownUntil = hoursLater(24).toISOString();
    const base = {
      streak: 3,
      firstSeenAt: T0.toISOString(),
      lastSeenAt: T0.toISOString(),
      severity: "crit" as Severity,
      cooldownUntil,
    };

    const during = decideReport(
      { findings: { fp: { ...base } }, creations: [] },
      { fingerprint: "fp", severity: "crit", now: hoursLater(2) },
    );
    expect(during.action.type).toBe("suppressed");

    const after = decideReport(
      { findings: { fp: { ...base } }, creations: [] },
      { fingerprint: "fp", severity: "crit", now: hoursLater(30) },
    );
    expect(after.action.type).toBe("create");
  });

  it("keeps a wontfix suppression out of the auto-resolve sweep", () => {
    const stale = new Date(T0.getTime() - 10 * 3_600_000).toISOString();
    const state: OpsState = {
      findings: {
        gone: {
          streak: 4,
          firstSeenAt: stale,
          lastSeenAt: stale,
          severity: "warn",
        },
        declined: {
          streak: 4,
          firstSeenAt: stale,
          lastSeenAt: stale,
          severity: "warn",
          suppressedForever: true,
        },
      },
      creations: [],
    };
    expect(decideSweep(state, T0).map((s) => s.fingerprint)).toEqual(["gone"]);
  });
});

describe("escalation policy — blast radius", () => {
  it("rate-limits a burst so one bad lap cannot open five issues", () => {
    const state: OpsState = {
      findings: {},
      // Both inside the 90m window as of the escalating lap at hour 1.9.
      creations: [hoursLater(1).toISOString(), hoursLater(1.5).toISOString()],
    };
    const { action } = runLaps(state, 2, "crit", 0.9);
    expect(action).toMatchObject({ type: "rate-limited" });
  });

  it("lets the same finding through once the window clears", () => {
    const state: OpsState = {
      findings: {},
      creations: [T0.toISOString(), T0.toISOString()],
    };
    const { action } = runLaps(state, 2, "crit", 4);
    expect(action.type).toBe("create");
  });

  it("sweeps a finding that stopped being reported", () => {
    const state: OpsState = {
      findings: {
        fp: {
          streak: 5,
          firstSeenAt: T0.toISOString(),
          lastSeenAt: T0.toISOString(),
          severity: "crit",
        },
      },
      creations: [],
    };
    expect(decideSweep(state, hoursLater(2))).toHaveLength(0);
    expect(decideSweep(state, hoursLater(4))).toHaveLength(1);
  });

  it("keeps the default gates conservative", () => {
    expect(DEFAULT_POLICY.maxCreationsPerWindow).toBeLessThanOrEqual(2);
    expect(DEFAULT_POLICY.escalateAfterLaps.warn).toBeGreaterThanOrEqual(2);
  });
});

describe("fingerprint marker", () => {
  it("round-trips through a GitHub body", () => {
    const fp = "sync-error:linkedin:company-page-url";
    const body = `${fingerprintMarker(fp)}\n\nSome evidence.`;
    expect(parseFingerprint(body)).toBe(fp);
  });

  it("returns null for an unrelated body", () => {
    expect(parseFingerprint("just a normal issue")).toBeNull();
    expect(parseFingerprint(null)).toBeNull();
  });
});
