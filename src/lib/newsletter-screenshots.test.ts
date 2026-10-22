import { describe, expect, it } from "vitest";
import { applyScreenshots, formatTimestamp, parseScreenshotMarks, parseTimestamp, replaceScreenshotMarks, screenshotKey } from "./newsletter-screenshots";

describe("screenshot placeholders", () => {
  it("finds timestamped and untimed placeholders", () => {
    const md = "1. **Open Skills**\n*[Screenshot @ 4:32: the Skills page with Record selected]*\nThen _[Screenshot: the result]_";
    expect(parseScreenshotMarks("steps", md)).toEqual([
      { key: "steps:the skills page with record selected", sectionKey: "steps", sec: 272, label: "the Skills page with Record selected", raw: "*[Screenshot @ 4:32: the Skills page with Record selected]*" },
      { key: "steps:the result", sectionKey: "steps", sec: null, label: "the result", raw: "_[Screenshot: the result]_" },
    ]);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(formatTimestamp(272)).toBe("4:32");
  });

  it("swaps a chosen frame in as an image line and leaves the others", () => {
    const md = "Step\n*[Screenshot @ 4:32: the Skills page]*\n*[Screenshot @ 5:00: the result]*";
    const chosen = { [screenshotKey("steps", "the Skills page")]: { frameId: "f1", sec: 272, bucket: "b", key: "k.jpg" } };
    const out = applyScreenshots("steps", md, chosen, (c) => `https://img/${c.key}`);
    expect(out).toContain("\n![the Skills page](https://img/k.jpg)\n");
    expect(out).toContain("*[Screenshot @ 5:00: the result]*");
  });

  it("hands each placeholder's moment and label to replaceScreenshotMarks (zero-padded times too)", () => {
    const out = replaceScreenshotMarks("a\n*[Screenshot @ 03:39: the Connectors page]*\n[Screenshot: no time]", (sec, label) => `<${sec}|${label}>`);
    expect(out).toBe("a\n<219|the Connectors page>\n<null|no time>");
  });
});
