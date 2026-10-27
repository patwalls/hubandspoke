import { describe, expect, it } from "vitest";
import { parseCrontab } from "graphile-worker";
import { CRONTAB } from "./crontab";

describe("CRONTAB", () => {
  const items = parseCrontab(CRONTAB);

  it("parses", () => {
    expect(items.length).toBeGreaterThan(0);
  });

  // graphile fetches `priority asc, run_at asc`. On 2026-10-27 the :05
  // account-content-sync fan-out (~50 jobs, up to 30s each) queued ahead of
  // every per-minute heartbeat while diarize held the other slot; the row
  // went 8+ min stale and /api/health/worker paged on a busy, healthy worker.
  it("runs worker-heartbeat ahead of every other job", () => {
    const heartbeat = items.find((i) => i.task === "worker-heartbeat");
    expect(heartbeat?.options.priority).toBeLessThan(0);
    for (const item of items) {
      if (item.task === "worker-heartbeat") continue;
      expect(item.options.priority ?? 0, item.task).toBeGreaterThan(heartbeat!.options.priority!);
    }
  });
});
