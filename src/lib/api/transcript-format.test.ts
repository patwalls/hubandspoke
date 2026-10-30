import { describe, expect, it } from "vitest";
import { formatTimestamp, toPlainText, toSrt, toVtt } from "./transcript-format";

const segs = [
  { startSec: 0, endSec: 4.25, text: "So the first thing.", speaker: "Pat" },
  { startSec: 4.25, endSec: 9.8, text: "They think it's writing.", speaker: "Guest" },
  { startSec: 9.8, endSec: 3661.5, text: " It isn't. ", speaker: "Guest" },
];

describe("formatTimestamp", () => {
  it("renders hours, minutes, seconds and millis with the right separator", () => {
    expect(formatTimestamp(0)).toBe("00:00:00.000");
    expect(formatTimestamp(4.25)).toBe("00:00:04.250");
    expect(formatTimestamp(3661.5, ",")).toBe("01:01:01,500");
  });
  it("never goes negative", () => {
    expect(formatTimestamp(-2)).toBe("00:00:00.000");
  });
});

describe("renderers", () => {
  it("VTT starts with the magic header and labels speakers", () => {
    const vtt = toVtt(segs);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:04.250\nPat: So the first thing.");
  });
  it("SRT numbers cues and uses comma millis", () => {
    const srt = toSrt(segs);
    expect(srt.startsWith("1\n00:00:00,000 --> 00:00:04,250\nPat: So the first thing.\n\n2\n")).toBe(true);
    expect(srt).toContain("01:01:01,500");
  });
  it("plain text names a speaker only when it changes and trims cue text", () => {
    expect(toPlainText(segs)).toBe("Pat: So the first thing.\nGuest: They think it's writing.\nIt isn't.");
  });
  it("plain text without speakers is just the lines", () => {
    expect(toPlainText([{ startSec: 0, endSec: 1, text: "a" }, { startSec: 1, endSec: 2, text: "b" }])).toBe("a\nb");
  });
});
