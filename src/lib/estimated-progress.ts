// How far along a wait with no real progress signal (one long fetch) should
// LOOK. Eases out so the bar moves briskly at first and is ~85% full at the
// expected duration, then keeps creeping toward CAP and never reaches 100% —
// the caller swaps the bar out when the work actually finishes. A slow run
// reads as "almost there", not as a full bar that's stuck.
const CAP = 0.95;
// Solves CAP * (1 - e^-K) = 0.85, i.e. 85% at t = expectedMs.
const K = -Math.log(1 - 0.85 / CAP);

export function estimatedProgress(elapsedMs: number, expectedMs: number): number {
  if (elapsedMs <= 0 || expectedMs <= 0) return 0;
  return CAP * (1 - Math.exp((-K * elapsedMs) / expectedMs));
}

/** The newsletter drafter's phases, in order, and the share of the bar each one starts at. */
export const DRAFT_PHASES = ["starting", "gathering", "reading", "writing", "reviewing"] as const;
export type DraftPhaseName = (typeof DRAFT_PHASES)[number];
const PHASE_START: Record<DraftPhaseName, number> = { starting: 0.03, gathering: 0.1, reading: 0.25, writing: 0.55, reviewing: 0.72 };
const PHASE_END: Record<DraftPhaseName, number> = { starting: 0.1, gathering: 0.25, reading: 0.55, writing: 0.72, reviewing: 0.97 };

/**
 * A drafting run's bar: the phase it reported sets the floor, and time spent
 * in that phase eases it toward the next phase's start (never past it), so the
 * bar moves on its own between turns but only jumps ahead on real progress.
 * Pure; exported for tests.
 */
export function draftProgress(phase: DraftPhaseName | null, msInPhase: number, expectedPhaseMs = 60_000): number {
  const p = phase ?? "starting";
  const start = PHASE_START[p];
  const span = PHASE_END[p] - start;
  return start + span * (estimatedProgress(msInPhase, expectedPhaseMs) / 0.95);
}
