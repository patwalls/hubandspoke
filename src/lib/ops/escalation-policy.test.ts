import { describe, it, expect } from "vitest";
import {
  AUTO_CLOSED_LABEL,
  classifyClose,
  DEFAULT_POLICY,
  decideReport,
  decideSweep,
  emptyState,
  parseFingerprint,
  fingerprintMarker,
  type OpsState,
  type Severity,
  stripComposedBody,
  FOOTER_LEAD,
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

  it("does not sweep the whole backlog on the first lap after the loop was down", () => {
    // 2026-08-28: the runner was down ~24h. Every finding went stale at the same
    // instant, so the first `status` back closed draft PRs #16 and #17 at once.
    const state: OpsState = {
      findings: {
        fp: {
          streak: 59,
          firstSeenAt: T0.toISOString(),
          lastSeenAt: T0.toISOString(),
          severity: "warn",
          escalation: {
            kind: "pr",
            number: 16,
            severity: "warn",
            createdAt: T0.toISOString(),
          },
        },
      },
      creations: [],
      lastLapAt: T0.toISOString(),
    };
    expect(decideSweep(state, hoursLater(24))).toEqual([]);
  });

  it("still sweeps a cleared finding while laps are running normally", () => {
    const state: OpsState = {
      findings: {
        fp: {
          streak: 5,
          firstSeenAt: T0.toISOString(),
          lastSeenAt: T0.toISOString(),
          severity: "warn",
        },
      },
      creations: [],
      // A lap ran 12 minutes ago, so the gap is the finding's, not the loop's.
      lastLapAt: hoursLater(3.8).toISOString(),
    };
    expect(decideSweep(state, hoursLater(4)).map((x) => x.fingerprint)).toEqual(["fp"]);
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

describe("classifyClose", () => {
  it("treats the loop's own auto-close as auto, never as a human decision", () => {
    // Regression: PR #15 was closed by the loop's own sweep on 2026-08-25, then
    // read back as a human close, which muted a still-live finding for 7 days.
    expect(classifyClose([{ name: "ops-loop" }, { name: AUTO_CLOSED_LABEL }])).toBe(
      "auto",
    );
  });

  it("keeps wontfix winning over the auto-close stamp", () => {
    expect(classifyClose([{ name: AUTO_CLOSED_LABEL }, { name: "wontfix" }])).toBe(
      "wontfix",
    );
  });

  it("treats an unlabelled close as a human decision", () => {
    expect(classifyClose([{ name: "ops-loop" }])).toBe("human");
    expect(classifyClose([])).toBe("human");
    expect(classifyClose(undefined)).toBe("human");
  });
});

describe("stripComposedBody", () => {
  const compose = (evidence: string, streak: number) =>
    [
      fingerprintMarker("yt-archive:memory-guard"),
      "",
      `**WARN** · first seen 2026-09-01 17:59 UTC · seen in ${streak} consecutive laps · last 2026-09-02 09:18 UTC`,
      "",
      stripComposedBody(evidence),
      "",
      "---",
      "",
      `${FOOTER_LEAD} (\`/lap\`). It re-checks this every lap.</sub>`,
    ].join("\n");

  const EVIDENCE = "### What's broken\n\nThe guard runs after the enqueue.";

  it("leaves a plain evidence body alone", () => {
    expect(stripComposedBody(EVIDENCE)).toBe(EVIDENCE);
  });

  it("makes composing idempotent when a body is fed back in", () => {
    // The 2026-09-02 bug: refreshing PR #19 by passing its own description back
    // stacked a new header on top of the old one, every lap, three deep.
    const once = compose(EVIDENCE, 13);
    const twice = compose(once, 13);
    expect(twice).toBe(once);
    expect(twice.split("ops-fingerprint:").length - 1).toBe(1);
  });

  it("keeps only the newest header across repeated refreshes", () => {
    let body = compose(EVIDENCE, 1);
    for (let streak = 2; streak <= 5; streak++) body = compose(body, streak);
    expect(body.split("ops-fingerprint:").length - 1).toBe(1);
    expect(body.split(FOOTER_LEAD).length - 1).toBe(1);
    expect(body).toContain("seen in 5 consecutive laps");
    expect(body).not.toContain("seen in 4 consecutive laps");
    expect(body).toContain("The guard runs after the enqueue.");
  });

  it("strips a bare marker with no severity line", () => {
    expect(stripComposedBody(`${fingerprintMarker("x:y")}\n\n${EVIDENCE}`)).toBe(
      EVIDENCE,
    );
  });
});
