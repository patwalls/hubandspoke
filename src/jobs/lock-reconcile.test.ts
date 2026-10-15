import { describe, it, expect } from "vitest";
import { classifyLocks, type LockRow } from "./lock-reconcile";

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
