import { describe, expect, it } from "vitest";
import { learnPointsToLines, linesToLearnPoints, linesToList } from "./form-text";

describe("academy form text", () => {
  it("splits one item per line, dropping blanks and bullet/checkbox prefixes", () => {
    expect(linesToList("Watch it\n\n- Get access\n• Define roles\n[ ] Book a call\n")).toEqual([
      "Watch it",
      "Get access",
      "Define roles",
      "Book a call",
    ]);
  });

  it("pulls a leading timestamp off learn points in any common style", () => {
    expect(linesToLearnPoints("0:18 What is Hub & Spoke\n(1:09) Metrics\n3:19 - Workflow\n1:02:03: Long one\nNo time")).toEqual([
      { time: "0:18", text: "What is Hub & Spoke" },
      { time: "1:09", text: "Metrics" },
      { time: "3:19", text: "Workflow" },
      { time: "1:02:03", text: "Long one" },
      { time: null, text: "No time" },
    ]);
  });

  it("round-trips back to editable text", () => {
    const points = [{ time: "0:18", text: "Intro" }, { time: null, text: "Outro" }];
    expect(linesToLearnPoints(learnPointsToLines(points))).toEqual(points);
  });
});
