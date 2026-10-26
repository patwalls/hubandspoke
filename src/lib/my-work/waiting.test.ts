import { describe, it, expect } from "vitest";
import { sortByLongestWait, waitingFor } from "./waiting";

const now = new Date("2026-10-26T12:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe("waitingFor", () => {
  it("is null when the start is unknown", () => {
    expect(waitingFor(null, now)).toBeNull();
    expect(waitingFor("not a date", now)).toBeNull();
  });

  it("shows minutes, then hours, then days after two days", () => {
    expect(waitingFor(ago(0.25), now)?.label).toBe("15m");
    expect(waitingFor(ago(0), now)?.label).toBe("1m");
    expect(waitingFor(ago(5.9), now)?.label).toBe("5h");
    expect(waitingFor(ago(47), now)?.label).toBe("47h");
    expect(waitingFor(ago(50), now)?.label).toBe("2d");
  });

  it("turns amber at 6 hours and red at a day", () => {
    expect(waitingFor(ago(5.99), now)?.tone).toBe("fresh");
    expect(waitingFor(ago(6), now)?.tone).toBe("due");
    expect(waitingFor(ago(23.9), now)?.tone).toBe("due");
    expect(waitingFor(ago(24), now)?.tone).toBe("late");
  });

  it("accepts ISO strings and never goes negative on clock skew", () => {
    expect(waitingFor(ago(30).toISOString(), now)?.label).toBe("30h");
    expect(waitingFor(new Date(now.getTime() + 60_000), now)).toMatchObject({ label: "1m", tone: "fresh" });
  });
});

describe("sortByLongestWait", () => {
  it("puts the longest wait first and unknown starts last, in their old order", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const since = new Map([
      ["b", ago(2)],
      ["d", ago(40)],
    ]);
    expect(sortByLongestWait(rows, since).map((r) => r.id)).toEqual(["d", "b", "a", "c"]);
  });
});
