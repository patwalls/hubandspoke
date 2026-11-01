import { describe, it, expect } from "vitest";
import { onlyWaiting, waitingInStatus, WAITING_AFTER_DAYS } from "./waiting";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe("waitingInStatus", () => {
  it("flags a post in Review for 3+ days, with when it got there", () => {
    expect(waitingInStatus("Review", daysAgo(5), NOW)).toEqual({
      days: 5,
      title: "In Review for 5 days, since Oct 27",
    });
    expect(waitingInStatus("Ready To Publish", daysAgo(WAITING_AFTER_DAYS), NOW)?.days).toBe(3);
  });

  it("stays quiet under the threshold", () => {
    expect(waitingInStatus("Review", daysAgo(2.9), NOW)).toBeNull();
    expect(waitingInStatus("Review", daysAgo(0), NOW)).toBeNull();
  });

  it("never flags statuses where waiting is normal", () => {
    // Assigned = editing backlog, Scheduled = waiting for its date by design.
    expect(waitingInStatus("Assigned", daysAgo(30), NOW)).toBeNull();
    expect(waitingInStatus("Scheduled", daysAgo(30), NOW)).toBeNull();
    expect(waitingInStatus("Idea", daysAgo(30), NOW)).toBeNull();
  });

  it("never flags without a usable time", () => {
    expect(waitingInStatus("Review", null, NOW)).toBeNull();
    expect(waitingInStatus("Review", "not a date", NOW)).toBeNull();
    expect(waitingInStatus(null, daysAgo(9), NOW)).toBeNull();
  });
});

describe("onlyWaiting", () => {
  it("keeps just the stuck hand-offs, in their original order", () => {
    const rows = [
      { id: "a", status: "Review", statusSince: daysAgo(4) },
      { id: "b", status: "Review", statusSince: daysAgo(1) },
      { id: "c", status: "Assigned", statusSince: daysAgo(20) },
      { id: "d", status: "Ready To Publish", statusSince: daysAgo(3) },
      { id: "e", status: "Review", statusSince: null },
    ];
    expect(onlyWaiting(rows, NOW).map((r) => r.id)).toEqual(["a", "d"]);
  });
});
