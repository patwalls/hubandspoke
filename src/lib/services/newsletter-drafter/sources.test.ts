import { describe, expect, it } from "vitest";
import { usesCurrentTemplate } from "./sources";

describe("usesCurrentTemplate", () => {
  const futurepedia = ["How We Did It", "Free Resource", "How We Did It (continued)", "Use Cases", "Bonus Tips"];

  it("keeps Kevin/Saj-template issues and drops the retired Step-by-Step Guide layout", () => {
    expect(usesCurrentTemplate("Claude Guide\nHow We Did It\nFree Resource\nUse Cases\nBonus Tips", futurepedia)).toBe(true);
    expect(usesCurrentTemplate("How We Did It\n💫 Level Up\nOther Use Cases\n💡 Pro Tips\n⏭️ What's Next", futurepedia)).toBe(false);
  });

  it("matches headings with emoji and punctuation, and accepts everything when the template has none", () => {
    expect(usesCurrentTemplate("THE ORANGE JUICE 🍊 ... the coffee ☕ ... The Special 🍽️", ["The Orange Juice 🍊", "The Coffee ☕", "The Special 🍽️"])).toBe(true);
    expect(usesCurrentTemplate("anything", [])).toBe(true);
  });
});
