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
