import {
  addDays,
  addHours,
  addMinutes,
  addWeeks,
  set,
  isBefore,
} from "date-fns";

// Natural-language → Date for the scheduler. STRUCTURAL parsing only (numbers,
// units, am/pm) — this is a date-shape problem, not a content-meaning one, so
// regex is the right tool here. Returns null when the phrase can't be parsed;
// the UI falls back to an exact datetime picker.
//
// Handles: "in 2 hours" / "in 90 min" / "2h" / "tomorrow 9am" /
// "today 5pm" / "tonight" / "noon" / "9:30pm" / bare "3pm" (rolls to tomorrow
// if already past) / "next monday 8am".

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5,
  saturday: 6,
};

function num(token: string): number | null {
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return WORD_NUMBERS[token] ?? null;
}

/** Parse a clock time like "9pm", "9:30 pm", "21:00", "noon", "midnight".
 *  Returns {hours, minutes} in 24h, or null. */
function parseClock(raw: string): { hours: number; minutes: number } | null {
  const s = raw.trim().toLowerCase();
  if (s === "noon") return { hours: 12, minutes: 0 };
  if (s === "midnight") return { hours: 0, minutes: 0 };
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (hours > 23 || minutes > 59) return null;
  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;
  return { hours, minutes };
}

function atTime(
  base: Date,
  clock: { hours: number; minutes: number },
): Date {
  return set(base, {
    hours: clock.hours,
    minutes: clock.minutes,
    seconds: 0,
    milliseconds: 0,
  });
}

export function parseNaturalTime(
  input: string,
  now: Date = new Date(),
): Date | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;

  // Relative: "in 2 hours", "2 hours", "in 90 minutes", "3d", "1 week"
  const rel = s.match(
    /^(?:in\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(min(?:ute)?s?|m|h(?:ou)?rs?|hrs?|h|days?|d|weeks?|wks?|w)$/,
  );
  if (rel) {
    const n = num(rel[1]);
    if (n == null) return null;
    const unit = rel[2];
    if (/^m(in|ins|inute|inutes)?$/.test(unit) || unit === "m")
      return addMinutes(now, n);
    if (/^h/.test(unit)) return addHours(now, n);
    if (/^d/.test(unit)) return addDays(now, n);
    if (/^w/.test(unit)) return addWeeks(now, n);
  }

  // "tonight" → today 8pm (or tomorrow 8pm if already past)
  if (s === "tonight") {
    let d = atTime(now, { hours: 20, minutes: 0 });
    if (isBefore(d, now)) d = addDays(d, 1);
    return d;
  }

  // "tomorrow" [time], default 9am
  let m = s.match(/^tomorrow(?:\s+(?:at\s+)?(.+))?$/);
  if (m) {
    const clock = m[1] ? parseClock(m[1]) : { hours: 9, minutes: 0 };
    if (!clock) return null;
    return atTime(addDays(now, 1), clock);
  }

  // "today" [time]
  m = s.match(/^today(?:\s+(?:at\s+)?(.+))?$/);
  if (m) {
    const clock = m[1] ? parseClock(m[1]) : null;
    if (!clock) return null;
    return atTime(now, clock);
  }

  // "next? <weekday>" [time], default 9am
  m = s.match(
    /^(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:at\s+)?(.+))?$/,
  );
  if (m) {
    const target = WEEKDAYS[m[1]];
    const clock = m[2] ? parseClock(m[2]) : { hours: 9, minutes: 0 };
    if (!clock) return null;
    let d = atTime(now, clock);
    // advance to the next matching weekday (at least tomorrow if same day)
    do {
      d = addDays(d, 1);
    } while (d.getDay() !== target);
    return d;
  }

  // Bare clock time → today, rolling to tomorrow if already past.
  const clock = parseClock(s);
  if (clock) {
    let d = atTime(now, clock);
    if (isBefore(d, now)) d = addDays(d, 1);
    return d;
  }

  return null;
}

/** Format a resolved schedule time in the viewer's local zone, with the
 *  timezone abbreviation made explicit (the user asked for unambiguous tz). */
export function formatScheduledTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
