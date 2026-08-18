import { describe, it, expect } from "vitest";
import { getScCreditsExhaustionState } from "./sc-credits-watch";
import { createTestScCallLog } from "@/test/factories";

/**
 * Regression coverage for the "recency clear" in getScCreditsExhaustionState.
 *
 * These tests seed rows only 1–3 minutes old on purpose. The detector scans
 * the whole table over a 60-minute window, so a tight window keeps ambient
 * rows in a pulled-down dev DB from deciding the outcome — for a case to
 * flip spuriously the DB would need its own billed row seconds old.
 */
describe("getScCreditsExhaustionState — recency clear", () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  it("stays exhausted when the only newer success is an unbilled (Pulse-served) call", async () => {
    // The 2026-08-18 production shape: billed 402s, then a free Pulse call
    // lands a second later. Before the credits>0 filter this reported
    // no_alert_needed while X + YouTube content sync were fully down.
    await createTestScCallLog({ credits: 1, ok: false, createdAt: minutesAgo(3) });
    await createTestScCallLog({
      credits: 0,
      ok: true,
      caller: "capture-velocity-snapshot",
      notes: "cp=4h — via pulse",
      createdAt: minutesAgo(1),
    });

    const state = await getScCreditsExhaustionState();

    expect(state.exhausted).toBe(true);
    expect(state.failedCount).toBeGreaterThanOrEqual(1);
    expect(state.sampleError).toMatch(/out of credits/i);
  });

  it("clears when a billed call succeeds after the latest 402", async () => {
    // A real top-up: the next billed call goes through, so credits flow and
    // the banner must clear rather than camp for the rest of the hour.
    await createTestScCallLog({ credits: 1, ok: false, createdAt: minutesAgo(3) });
    await createTestScCallLog({ credits: 2, ok: true, createdAt: minutesAgo(1) });

    const state = await getScCreditsExhaustionState();

    expect(state.exhausted).toBe(false);
    expect(state.failedCount).toBe(0);
  });

  it("stays exhausted when the billed success predates the latest 402", async () => {
    // Ordering still matters: a success before the failure proves nothing.
    await createTestScCallLog({ credits: 2, ok: true, createdAt: minutesAgo(3) });
    await createTestScCallLog({ credits: 1, ok: false, createdAt: minutesAgo(1) });

    const state = await getScCreditsExhaustionState();

    expect(state.exhausted).toBe(true);
    expect(state.failedCount).toBeGreaterThanOrEqual(1);
  });
});
