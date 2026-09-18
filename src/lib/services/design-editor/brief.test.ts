import { describe, expect, it } from "vitest";
import { coerceBrief, parseTimestamp } from "./brief";
import { snapClipToWords } from "./session";

const base = {
  stat: "$720K", statUnit: "/year", headline: "h", highlights: [], footer: "See his 3-Phase playbook->", notesTitle: "t",
  phases: [{ heading: "a", body: "b" }, { heading: "c", body: "d" }], caption: "c", pillLabel: "customer calls playbook",
};

describe("coerceBrief clips", () => {
  it("accepts numbers or MM:SS, clamps length to 12–75s, sorts, and keeps two", () => {
    const brief = coerceBrief({ ...base, clips: [
      { startSec: "10:00", endSec: "10:05", label: "too short" },
      { startSec: 60, endSec: 300, label: "too long" },
      { startSec: 900, endSec: 930, label: "third" },
    ] })!;
    expect(brief.clips).toEqual([
      { startSec: 60, endSec: 135, label: "too long" },
      { startSec: 600, endSec: 612, label: "too short" },
    ]);
    expect(brief.pillLabel).toBe("CUSTOMER CALLS PLAYBOOK");
    expect(brief.footer).toBe("See his 3-Phase playbook→");
  });
  it("drops clips without usable times and survives no clips at all", () => {
    expect(coerceBrief({ ...base, clips: [{ startSec: "abc", endSec: 5 }] })!.clips).toEqual([]);
    expect(coerceBrief({ ...base })!.clips).toEqual([]);
  });
  it("parseTimestamp", () => {
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("83")).toBe(83);
    expect(parseTimestamp("x")).toBeNull();
  });
});

describe("snapClipToWords", () => {
  const words = ["one", "two", "three", "four", "five"].map((text, i) => ({ index: i, text, startSec: 10 + i * 2, endSec: 10 + i * 2 + 1.5 }));
  it("moves the edges onto nearby word boundaries with a little air", () => {
    expect(snapClipToWords({ startSec: 11.2, endSec: 17.2, label: "l" }, words)).toEqual({ startSec: 11.85, endSec: 17.75, label: "l" });
  });
  it("leaves a clip alone when no word is near its edges, and never runs past the transcript", () => {
    expect(snapClipToWords({ startSec: 100, endSec: 130, label: "l" }, words)).toEqual({ startSec: 100, endSec: 130, label: "l" });
    const late = snapClipToWords({ startSec: 12, endSec: 19.6, label: "l" }, words);
    expect(late.endSec).toBeLessThanOrEqual(words[4].endSec + 0.5);
  });
});
