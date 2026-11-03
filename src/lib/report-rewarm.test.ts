import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRewarmer } from "./report-rewarm";

// Every edit expires the production report for every brand; the re-warm
// rebuilds it so the next reader doesn't wait. It must coalesce bursts and
// never stack warms on the DB.
describe("createRewarmer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    let resolveRun: (() => void) | null = null;
    const run = vi.fn(
      () => new Promise<void>((r) => {
        resolveRun = r;
      }),
    );
    const w = createRewarmer({ delayMs: 4_000, minGapMs: 30_000, run, now: () => Date.now() });
    const finish = async () => {
      resolveRun?.();
      resolveRun = null;
      await vi.advanceTimersByTimeAsync(0);
    };
    return { w, run, finish };
  }

  it("a burst of edits warms once, after the last one", async () => {
    const { w, run } = setup();
    w.schedule();
    await vi.advanceTimersByTimeAsync(3_000);
    w.schedule();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("an edit during a warm queues exactly one more, not one per edit", async () => {
    const { w, run, finish } = setup();
    w.schedule();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(run).toHaveBeenCalledTimes(1);
    w.schedule();
    w.schedule();
    w.schedule();
    await finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("warms start at least minGap apart", async () => {
    const { w, run, finish } = setup();
    w.schedule();
    await vi.advanceTimersByTimeAsync(4_000);
    await finish();
    w.schedule();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(run).toHaveBeenCalledTimes(1); // only 4 s since the first started
    await vi.advanceTimersByTimeAsync(25_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2); // 30 s after the first
  });

  it("a failed warm doesn't stop the next one", async () => {
    const run = vi.fn(async () => {
      throw new Error("db down");
    });
    const w = createRewarmer({ delayMs: 10, minGapMs: 0, run });
    w.schedule();
    await vi.advanceTimersByTimeAsync(10);
    w.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
