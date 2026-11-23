import { describe, it, expect } from "vitest";
import { isRecentIdea, matchesQueueAge, olderHiddenFromCounts, parseQueueAge, queueAgeCutoff } from "./queue-age";

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

describe("olderHiddenFromCounts — the recent-only report's 'N older ideas not shown'", () => {
  const counts = {
    total: 120,
    byFormat: { "Podcast clip": 100, "Hot take": 15 },
    clipByFormat: { "Podcast clip": 90 },
  };

  it("All tab: every older idea, or the filtered format's", () => {
    expect(olderHiddenFromCounts(counts, { tab: "all", format: "all", filtered: false })).toBe(120);
    expect(olderHiddenFromCounts(counts, { tab: "all", format: "Hot take", filtered: false })).toBe(15);
    expect(olderHiddenFromCounts(counts, { tab: "all", format: "Nope", filtered: false })).toBe(0);
  });

  it("a clip-format tab counts only that format's clip ideas, not originals of the same format", () => {
    const tab = { clipFormat: "Podcast clip" };
    expect(olderHiddenFromCounts(counts, { tab, format: "all", filtered: false })).toBe(90);
    expect(olderHiddenFromCounts(counts, { tab, format: "Hot take", filtered: false })).toBe(0);
  });

  it("names no number it can't know (channel/search filter, other tabs)", () => {
    expect(olderHiddenFromCounts(counts, { tab: "all", format: "all", filtered: true })).toBeNull();
    expect(olderHiddenFromCounts(counts, { tab: "other", format: "all", filtered: false })).toBeNull();
  });
});

describe("queueAgeCutoff", () => {
  it("is 30 days before now, the same line isRecentIdea draws", () => {
    const cutoff = queueAgeCutoff(NOW).getTime();
    expect(isRecentIdea(new Date(cutoff + 1000).toISOString(), NOW)).toBe(true);
    expect(isRecentIdea(new Date(cutoff - 1000).toISOString(), NOW)).toBe(false);
  });
});
