/**
 * Timecoded review notes: a comment can carry the moment of the video it is
 * about (`content_comments.at_seconds`). These helpers format that moment for
 * the chip ("0:12", "1:02:03") and validate what a client posts.
 */

/** Longest video we accept a timecode for (6 h); anything past is a bad value. */
export const MAX_AT_SECONDS = 6 * 60 * 60;

/** 12 → "0:12", 75.9 → "1:15", 3723 → "1:02:03". Floors to the second. */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Validate a posted `atSeconds`. Returns the value rounded to 0.1 s, `null`
 * when absent, or `undefined` when present but invalid (caller answers 400).
 */
export function parseAtSeconds(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (raw < 0 || raw > MAX_AT_SECONDS) return undefined;
  return Math.round(raw * 10) / 10;
}
