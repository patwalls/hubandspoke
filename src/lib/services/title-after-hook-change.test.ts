import { describe, it, expect } from "vitest";
import { titleAfterHookChange } from "@/lib/services/title-after-hook-change";

describe("titleAfterHookChange", () => {
  it("keeps a title someone typed when the clip is re-exported", () => {
    // The 2026-10-23 bug: the post was renamed, then a re-export put the
    // on-screen hook back as its title.
    expect(
      titleAfterHookChange({
        currentTitle: "Claude video generator is a game changer",
        priorHooks: ["Google AI Studio can turn a script into a voiceover", "Google AI Studio can turn a script into a voiceover"],
        newHook: "Google AI Studio can turn a script into a voiceover",
      }),
    ).toBe("Claude video generator is a game changer");
  });

  it("follows the hook while the title is still the old hook", () => {
    expect(
      titleAfterHookChange({ currentTitle: "old hook", priorHooks: ["old hook", null], newHook: "new hook" }),
    ).toBe("new hook");
  });

  it("follows the idea's hook on first export, when the item has no hook stored yet", () => {
    expect(
      titleAfterHookChange({ currentTitle: "idea hook ", priorHooks: [null, "idea hook"], newHook: "edited hook" }),
    ).toBe("edited hook");
  });

  it("fills a blank title with the hook", () => {
    expect(titleAfterHookChange({ currentTitle: null, priorHooks: [], newHook: "hook" })).toBe("hook");
    expect(titleAfterHookChange({ currentTitle: "  ", priorHooks: ["x"], newHook: "hook" })).toBe("hook");
  });
});
