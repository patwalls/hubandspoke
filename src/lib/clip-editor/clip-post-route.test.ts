import { describe, it, expect } from "vitest";
import { routeFormat } from "./clip-post-route";

describe("routeFormat", () => {
  it("a clip Skill opens the editor with no history at all", () => {
    expect(routeFormat({ check: { verdict: "clip", reason: "The Skill cuts the intro." }, published: 0, withVideo: 0 })).toEqual({
      editor: "clip",
      because: "The Skill cuts the intro.",
    });
  });

  it("video history opens the editor when the Skill doesn't say — or couldn't be read", () => {
    expect(routeFormat({ check: { verdict: "none", reason: "" }, published: 10, withVideo: 5 }).editor).toBe("clip");
    expect(routeFormat({ check: null, published: 3, withVideo: 2 }).editor).toBe("clip");
  });

  it("history needs both the share and the minimum count", () => {
    expect(routeFormat({ check: null, published: 10, withVideo: 4 }).editor).toBe("classic");
    expect(routeFormat({ check: null, published: 2, withVideo: 2 }).editor).toBe("classic");
  });

  it("a whole-video Skill stays classic even with all-video history", () => {
    const r = routeFormat({ check: { verdict: "whole_video", reason: "The Skill posts the full episode." }, published: 20, withVideo: 20 });
    expect(r.editor).toBe("classic");
    expect(r.because).toContain("full episode");
  });

  it("a design template outranks both signals — never the clip editor", () => {
    expect(routeFormat({ check: { verdict: "clip", reason: "Cuts a clip." }, published: 20, withVideo: 20, hasDesignTemplate: true })).toEqual({
      editor: "design",
      because: "It has a design template.",
    });
  });
});
