import { describe, it, expect } from "vitest";
import { isRecentIdea, matchesQueueAge, parseQueueAge } from "./queue-age";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("queue age filter", () => {
  it("splits at exactly 30 days", () => {
    expect(isRecentIdea(iso(30 * DAY - 1000), NOW)).toBe(true);
    expect(isRecentIdea(iso(30 * DAY), NOW)).toBe(false);
  });

  it("never hides a row whose age it can't read", () => {
    expect(isRecentIdea(null, NOW)).toBe(true);
    expect(isRecentIdea("not a date", NOW)).toBe(true);
    expect(matchesQueueAge(null, "older", NOW)).toBe(false);
  });

  it("recent and older partition the rows; any keeps all", () => {
    const rows = [iso(DAY), iso(29 * DAY), iso(31 * DAY), iso(400 * DAY)];
    const recent = rows.filter((r) => matchesQueueAge(r, "recent", NOW));
    const older = rows.filter((r) => matchesQueueAge(r, "older", NOW));
    expect(recent).toHaveLength(2);
    expect(older).toHaveLength(2);
    expect(rows.filter((r) => matchesQueueAge(r, "any", NOW))).toHaveLength(4);
  });

  it("defaults unknown URL values to recent", () => {
    expect(parseQueueAge(undefined)).toBe("recent");
    expect(parseQueueAge("bogus")).toBe("recent");
    expect(parseQueueAge("older")).toBe("older");
    expect(parseQueueAge("any")).toBe("any");
  });
});
