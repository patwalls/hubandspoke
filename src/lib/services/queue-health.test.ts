import { describe, it, expect } from "vitest";
import { evaluateQueueHealth, type QueueHealthRows } from "./queue-health";

const base: QueueHealthRows = { livePoolId: "pool-live", oldestDueSeconds: null, locks: [], stalledRenders: [] };

describe("evaluateQueueHealth", () => {
  it("is green for an idle queue", () => {
    expect(evaluateQueueHealth(base)).toMatchObject({ ok: true, reasons: [] });
  });

  it("tolerates a live worker's own long lock (a 20-minute render is normal)", () => {
    const h = evaluateQueueHealth({
      ...base,
      locks: [{ kind: "queue", name: "media-heavy", lockedBy: "pool-live", ageSeconds: 1200 }],
    });
    expect(h.ok).toBe(true);
  });

  it("goes red when a dead pool has held a lock for more than five minutes", () => {
    const h = evaluateQueueHealth({
      ...base,
      locks: [{ kind: "queue", name: "media-heavy", lockedBy: "pool-dead", ageSeconds: 301 }],
    });
    expect(h.ok).toBe(false);
    expect(h.reasons[0]).toMatch(/dead worker.*media-heavy@pool-dead/);
  });

  it("gives a freshly orphaned lock the worker a minute to reconcile before paging", () => {
    const h = evaluateQueueHealth({
      ...base,
      locks: [{ kind: "queue", name: "media-heavy", lockedBy: "pool-dead", ageSeconds: 90 }],
    });
    expect(h.ok).toBe(true);
    expect(h.checks.foreignLocks).toHaveLength(1);
  });

  it("cannot judge locks without a live pool id, but still catches the backlog", () => {
    const h = evaluateQueueHealth({
      ...base,
      livePoolId: null,
      oldestDueSeconds: 16 * 60,
      locks: [{ kind: "queue", name: "media-heavy", lockedBy: "pool-x", ageSeconds: 9999 }],
    });
    expect(h.reasons).toHaveLength(1);
    expect(h.reasons[0]).toMatch(/waited 16 min/);
  });

  it("goes red on a stalled clip render", () => {
    const h = evaluateQueueHealth({
      ...base,
      stalledRenders: [{ id: "r1", status: "queued", ageSeconds: 1500 }],
    });
    expect(h.ok).toBe(false);
  });
});
