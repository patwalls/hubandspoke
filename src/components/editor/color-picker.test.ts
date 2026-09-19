import { describe, expect, it } from "vitest";
import { normalizeColor } from "./color-picker";
import { colorsInDesignDoc } from "@/lib/design-editor/colors";
import { colorsInClipDoc } from "@/lib/clip-editor/colors";
import { buildPlaybookTemplate } from "@/lib/design-editor/playbook-template";
import { createDefaultDoc } from "@/lib/clip-editor/doc";

describe("colour picker", () => {
  it("normalises what people paste", () => {
    expect(normalizeColor("#abc")).toBe("#AABBCC");
    expect(normalizeColor("ff3b3b")).toBe("#FF3B3B");
    expect(normalizeColor(" rgb(34, 224, 122) ")).toBe("#22E07A");
    expect(normalizeColor("red")).toBeNull();
  });
  it("lists a design's colours most-used first, and a clip's", () => {
    const design = colorsInDesignDoc(buildPlaybookTemplate());
    expect(design.slice(0, 2)).toEqual(expect.arrayContaining(["#FFFFFF", "#1C1C1E"])); // the two text inks lead
    expect(design).toContain("#FF3B3B");
    expect(design).toContain("#F7F5EF");
    const clip = colorsInClipDoc(createDefaultDoc({ startSec: 0, endSec: 10, hook: "h" }));
    expect(clip).toEqual(expect.arrayContaining(["#000000", "#FFFFFF", "#FFE14D"]));
  });
});
