// Pure date helpers for the newsletter drafter: the draft's lookback window
// and the "is this source inside it" check the agent's list tools share.

export const DEFAULT_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 31;

export interface DraftWindow {
  start: Date;
  end: Date;
}

/** Clamp a requested lookback to 1..MAX_WINDOW_DAYS (default 7). */
export function clampWindowDays(days: number | null | undefined): number {
  if (days == null || !Number.isFinite(days)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.round(days)));
}

/** The `days`-long window ending at `now`. */
export function computeWindow(days: number | null | undefined, now: Date = new Date()): DraftWindow {
  const d = clampWindowDays(days);
  return { start: new Date(now.getTime() - d * 24 * 60 * 60 * 1000), end: now };
}

/**
 * The window an agent tool call actually searches. The agent may ask for a
 * different lookback than the draft was created with (the format Skill owns
 * the cadence), so `days` re-anchors from the draft's END; omitted → the
 * draft's own window.
 */
export function toolWindow(draft: DraftWindow, days: number | null | undefined): DraftWindow {
  if (days == null) return draft;
  return computeWindow(days, draft.end);
}

/** True when an ISO timestamp falls inside [start, end]. Unparseable → false. */
export function isWithinWindow(iso: string | null | undefined, w: DraftWindow): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t >= w.start.getTime() && t <= w.end.getTime();
}
