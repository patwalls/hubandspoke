/** Where the `design-screens` scan samples a video for dashboard / revenue
 *  screenshots: evenly, every `stepSec`, skipping the intro, capped. Pure. */
export function screenSampleTimes(durationSec: number, opts: { stepSec?: number; max?: number; skipStartSec?: number } = {}): number[] {
  const step = opts.stepSec ?? 20;
  const max = opts.max ?? 60;
  const start = Math.min(opts.skipStartSec ?? 8, Math.max(0, durationSec / 4));
  if (!(durationSec > 1)) return [];
  const usable = Math.max(1, durationSec - 1 - start);
  const n = Math.max(1, Math.min(max, Math.floor(usable / step) + 1));
  const pitch = n > 1 ? usable / (n - 1) : 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round((start + i * pitch) * 100) / 100);
  return out;
}
