import { describe, it, expect } from "vitest";
import { evaluateQueueHealth, type QueueHealthRows } from "./queue-health";

const base: QueueHealthRows = { livePoolId: "pool-live", dueBacklog: [], locks: [], stalledRenders: [] };

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
      dueBacklog: [{ queueName: "media-heavy", count: 1, oldestSeconds: 16 * 60 }],
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

  // 2026-10-26: ten diarize jobs queued behind each other on the serial
  // `diarize` queue, one ~5-min chunk at a time. The oldest had sat 51 min,
  // but the queue had taken a new job 4 min earlier — moving, not stuck.
  it("does not page on a serial queue backlog the live worker is draining", () => {
    const h = evaluateQueueHealth({
      ...base,
      dueBacklog: [{ queueName: "diarize", count: 9, oldestSeconds: 51 * 60 }],
      locks: [{ kind: "queue", name: "diarize", lockedBy: "pool-live", ageSeconds: 4 * 60 }],
    });
    expect(h).toMatchObject({ ok: true, reasons: [] });
    expect(h.checks.oldestDueSeconds).toBe(4 * 60);
  });

  it("pages when the live worker has sat on one serial-queue job past the limit", () => {
    const h = evaluateQueueHealth({
      ...base,
      dueBacklog: [{ queueName: "diarize", count: 3, oldestSeconds: 51 * 60 }],
      locks: [{ kind: "queue", name: "diarize", lockedBy: "pool-live", ageSeconds: 16 * 60 }],
    });
    expect(h.ok).toBe(false);
    expect(h.reasons[0]).toMatch(/waited 16 min.*queue diarize \(3 waiting\)/);
  });

  it("still pages on a backlog nobody is working (no queue, or a queue nobody holds)", () => {
    for (const queueName of [null, "media-heavy"]) {
      const h = evaluateQueueHealth({ ...base, dueBacklog: [{ queueName, count: 2, oldestSeconds: 16 * 60 }] });
      expect(h.ok).toBe(false);
      expect(h.reasons[0]).toMatch(/waited 16 min/);
    }
  });

  it("a busy serial queue does not mask a stuck job elsewhere", () => {
    const h = evaluateQueueHealth({
      ...base,
      dueBacklog: [
        { queueName: "diarize", count: 9, oldestSeconds: 51 * 60 },
        { queueName: null, count: 1, oldestSeconds: 20 * 60 },
      ],
      locks: [{ kind: "queue", name: "diarize", lockedBy: "pool-live", ageSeconds: 60 }],
    });
    expect(h.ok).toBe(false);
    expect(h.checks.oldestDueSeconds).toBe(20 * 60);
  });
});
