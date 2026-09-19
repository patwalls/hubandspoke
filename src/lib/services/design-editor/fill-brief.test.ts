import { describe, expect, it } from "vitest";
import { buildTechStackTemplate } from "@/lib/design-editor/tech-stack-template";
import { listSlots } from "@/lib/design-editor/template-fill";
import { coerceFill, describeSlots, parseTimestamp } from "./fill-brief";
import { snapClipToWords } from "./session";

const slots = listSlots(buildTechStackTemplate());
const key = (name: string) => slots.find((s) => s.name === name)!.key;

describe("coerceFill", () => {
  it("keeps known slots only, trims text, drops disallowed highlight colours, clamps clips to 12–75s, parses MM:SS", () => {
    const fill = coerceFill(
      {
        caption: "  cap ",
        values: [
          { key: key("Headline"), text: " This guy makes $40K/mo. ", highlights: [{ phrase: "$40K", color: "green" }] },
          { key: key("Clip"), startSec: "10:00", endSec: "10:05" },
          { key: "nope", text: "x" },
          { key: key("Total"), text: "" },
        ],
      },
      slots,
    )!;
    expect(fill.caption).toBe("cap");
    expect(fill.values).toEqual([
      { key: key("Headline"), text: "This guy makes $40K/mo.", highlights: [] }, // the sample has no colours → none allowed
      { key: key("Clip"), startSec: 600, endSec: 612 },
    ]);
  });
  it("returns null when nothing usable came back", () => {
    expect(coerceFill({ values: [] }, slots)).toBeNull();
    expect(parseTimestamp("1:02:03")).toBe(3723);
  });
  it("describes slots for the prompt with their room and hints", () => {
    const text = describeSlots(slots);
    expect(text).toContain(`key "${key("Stack")}" — TEXT (slide 2)`);
    expect(text).toContain("maxChars:");
    expect(text).toContain(`key "${key("Clip")}" — CLIP (slide 3)`);
  });
});

describe("snapClipToWords", () => {
  const words = ["one", "two", "three", "four", "five"].map((text, i) => ({ index: i, text, startSec: 10 + i * 2, endSec: 10 + i * 2 + 1.5 }));
  it("moves the edges onto nearby word boundaries with a little air", () => {
    expect(snapClipToWords({ startSec: 11.2, endSec: 17.2, label: "l" }, words)).toEqual({ startSec: 11.85, endSec: 17.75, label: "l" });
  });
  it("leaves a clip alone when no word is near its edges", () => {
    expect(snapClipToWords({ startSec: 100, endSec: 130, label: "l" }, words)).toEqual({ startSec: 100, endSec: 130, label: "l" });
  });
});
