import { describe, it, expect } from "vitest";
import {
  classifyLocks,
  isTransientDbError,
  judgeReconcileFailure,
  shouldReportReconcile,
  TRANSIENT_FAILURES_BEFORE_REPORT,
  type LockRow,
} from "./lock-reconcile";

const boot = new Date("2026-10-15T17:28:00Z");
const now = new Date("2026-10-15T17:40:00Z");
const me = "pool-self";

function row(partial: Partial<LockRow> & Pick<LockRow, "lockedBy" | "lockedAt">): LockRow {
  return { kind: "queue", id: "1", queueName: "media-heavy", ...partial };
}

describe("classifyLocks", () => {
  it("treats a foreign holder whose lock predates our boot as an orphan", () => {
    const out = classifyLocks({
      rows: [
        row({ lockedBy: "pool-dead", lockedAt: new Date("2026-10-15T17:14:54Z") }),
        row({ kind: "job", id: "42", lockedBy: "pool-dead", lockedAt: new Date("2026-10-15T17:14:54Z") }),
      ],
      selfPoolId: me, bootAt: boot, now,
      inFlightJobIds: new Set(), inFlightQueueIds: new Set(),
    });
    expect(out.orphanHolders).toEqual(["pool-dead"]);
    expect(out.ghostJobIds).toEqual([]);
    expect(out.foreignLiveHolders).toEqual([]);
  });

  it("never touches a foreign holder whose lock is newer than our boot (another live worker)", () => {
    const out = classifyLocks({
      rows: [row({ lockedBy: "pool-other", lockedAt: new Date("2026-10-15T17:30:00Z") })],
      selfPoolId: me, bootAt: boot, now,
      inFlightJobIds: new Set(), inFlightQueueIds: new Set(),
    });
    expect(out.orphanHolders).toEqual([]);
    expect(out.foreignLiveHolders).toEqual(["pool-other"]);
  });

  it("flags our own job lock as a ghost only when it is old and not in flight", () => {
    const old = new Date("2026-10-15T17:30:00Z");
    const fresh = new Date("2026-10-15T17:39:30Z");
    const out = classifyLocks({
      rows: [
        row({ kind: "job", id: "1", lockedBy: me, lockedAt: old }),      // ghost
        row({ kind: "job", id: "2", lockedBy: me, lockedAt: old }),      // running
        row({ kind: "job", id: "3", lockedBy: me, lockedAt: fresh }),    // inside grace
      ],
      selfPoolId: me, bootAt: boot, now,
      inFlightJobIds: new Set(["2"]), inFlightQueueIds: new Set(["1"]),
    });
    expect(out.ghostJobIds).toEqual(["1"]);
  });

  it("flags our own queue lock as a ghost when nothing in flight belongs to that queue", () => {
    const old = new Date("2026-10-15T17:30:00Z");
    const out = classifyLocks({
      rows: [
        row({ kind: "queue", id: "1", queueName: "media-heavy", lockedBy: me, lockedAt: old }),
        row({ kind: "queue", id: "2", queueName: "diarize", lockedBy: me, lockedAt: old }),
      ],
      selfPoolId: me, bootAt: boot, now,
      inFlightJobIds: new Set(["9"]), inFlightQueueIds: new Set(["2"]),
    });
    expect(out.ghostQueueIds).toEqual(["1"]);
  });

  it("returns nothing to do for a healthy worker", () => {
    const out = classifyLocks({
      rows: [row({ kind: "job", id: "7", lockedBy: me, lockedAt: new Date("2026-10-15T17:35:00Z") })],
      selfPoolId: me, bootAt: boot, now,
      inFlightJobIds: new Set(["7"]), inFlightQueueIds: new Set(["1"]),
    });
    expect(out).toEqual({ orphanHolders: [], ghostJobIds: [], ghostQueueIds: [], foreignLiveHolders: [] });
  });
});

describe("shouldReportReconcile", () => {
  const clean = { orphanHolders: [], ghostJobIds: [], ghostQueueIds: [], foreignLiveHolders: [], acted: false };

  it("logs, not pages, a boot pass that only released the previous process's orphans", () => {
    // HUBANDSPOKE-6: deploy restart at 19:02Z left pool-86a8… holding a lock.
    expect(shouldReportReconcile("boot", { ...clean, orphanHolders: ["pool-old"], acted: true })).toBe(false);
  });

  it("pages an orphan found on an interval pass (a lock sat wedged while we were up)", () => {
    expect(shouldReportReconcile("interval", { ...clean, orphanHolders: ["pool-old"], acted: true })).toBe(true);
  });

  it("pages ghosts and foreign live holders even at boot", () => {
    expect(shouldReportReconcile("boot", { ...clean, ghostJobIds: ["7"], acted: true })).toBe(true);
    expect(shouldReportReconcile("boot", { ...clean, ghostQueueIds: ["3"], acted: true })).toBe(true);
    expect(shouldReportReconcile("boot", { ...clean, foreignLiveHolders: ["pool-other"] })).toBe(true);
  });

  it("stays quiet on a clean pass", () => {
    expect(shouldReportReconcile("interval", clean)).toBe(false);
    expect(shouldReportReconcile("boot", clean)).toBe(false);
  });
});

// The shapes pg actually throws when Heroku Postgres restarts under us
// (HUBANDSPOKE-D, 2026-11-26 maintenance: breadcrumbs show 57P01, then
// 25006 "cannot execute LISTEN during recovery", then the socket reset).
function sysErr(code: string, message: string) {
  return Object.assign(new Error(message), { code, errno: -104, syscall: "read" });
}
function pgErr(code: string, message: string) {
  return Object.assign(new Error(message), { code, severity: "FATAL" });
}

describe("isTransientDbError", () => {
  it.each([
    ["socket reset (the GlitchTip #93 error)", sysErr("ECONNRESET", "read ECONNRESET")],
    ["refused while the server restarts", sysErr("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:5432")],
    ["admin shutdown", pgErr("57P01", "terminating connection due to administrator command")],
    ["server starting up", pgErr("57P03", "the database system is starting up")],
    ["still in recovery", pgErr("25006", "cannot execute LISTEN during recovery")],
    ["connection failure", pgErr("08006", "connection failure")],
    ["pg client: socket closed", new Error("Connection terminated unexpectedly")],
    ["pg client: dead client reused", new Error("Client has encountered a connection error and is not queryable")],
    ["wrapped in a cause", new Error("pass failed", { cause: sysErr("ECONNRESET", "read ECONNRESET") })],
  ])("%s → transient", (_label, err) => {
    expect(isTransientDbError(err)).toBe(true);
  });

  it.each([
    ["SQL syntax error", pgErr("42601", "syntax error at or near \"selec\"")],
    ["missing table (graphile schema changed)", pgErr("42P01", "relation \"graphile_worker._private_jobs\" does not exist")],
    ["a bug in our code", new TypeError("Cannot read properties of undefined (reading 'getTime')")],
    ["not an error at all", "boom"],
    ["null", null],
  ])("%s → not transient", (_label, err) => {
    expect(isTransientDbError(err)).toBe(false);
  });
});

describe("judgeReconcileFailure", () => {
  const reset = sysErr("ECONNRESET", "read ECONNRESET");

  it("does not page on a single dropped connection", () => {
    expect(judgeReconcileFailure(reset, 0)).toEqual({ report: false, transientStreak: 1 });
  });

  it("pages once when the database stays unreachable for the threshold, not on every pass after", () => {
    let streak = 0;
    const reports: boolean[] = [];
    for (let i = 0; i < TRANSIENT_FAILURES_BEFORE_REPORT + 3; i++) {
      const v = judgeReconcileFailure(reset, streak);
      streak = v.transientStreak;
      reports.push(v.report);
    }
    expect(reports.filter(Boolean)).toHaveLength(1);
    expect(reports[TRANSIENT_FAILURES_BEFORE_REPORT - 1]).toBe(true);
  });

  it("pages immediately on a non-connection error and resets the streak", () => {
    const sqlErr = pgErr("42601", "syntax error");
    expect(judgeReconcileFailure(sqlErr, 3)).toEqual({ report: true, transientStreak: 0 });
  });
});
