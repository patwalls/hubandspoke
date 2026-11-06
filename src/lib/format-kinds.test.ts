import { describe, it, expect } from "vitest";
import { FORMAT_PLATFORMS, clipTargetForPostType, defaultClipAspectFor, familyForFormat, formatPlatform, kindForExistingFormat, kindLabelForFormat } from "./format-kinds";
import { SKILL_EXAMPLE, SKILL_QUESTIONS } from "./format-skill-guide";

const allKinds = FORMAT_PLATFORMS.flatMap((p) => p.kinds);

describe("format kinds", () => {
  it("only clip kinds are clippable, and every clip kind has a full clip target", () => {
    for (const k of allKinds) {
      expect(k.isClippableFormat).toBe(k.family === "clip");
      if (k.family === "clip") {
        expect(k.clipTargetPostType).toBe(k.postType);
        expect(k.clipTargetPlatform?.length).toBeGreaterThan(0);
        expect(k.clipAspectRatio).not.toBeNull();
      } else {
        expect(k.clipTargetPostType).toBeNull();
      }
    }
  });

  it("pillar is the only original root; clips and posts must have a pillar", () => {
    for (const k of allKinds) {
      expect(k.labelsAsOriginal).toBe(k.family === "pillar");
      if (k.family === "pillar") expect(k.parent).toBe("none");
      if (k.family === "clip" || k.family === "design") expect(k.parent).toBe("required");
    }
  });

  it("every social platform offers Clip, then Carousel / image", () => {
    for (const key of ["instagram", "youtube", "x", "linkedin", "threads", "facebook"]) {
      const kinds = formatPlatform(key)!.kinds;
      expect(kinds.map((k) => k.toggleLabel)).toEqual(["Clip", "Carousel / image"]);
      expect(kinds.map((k) => k.family)).toEqual(["clip", "design"]);
    }
  });

  it("newsletter is listed but not pickable yet", () => {
    expect(formatPlatform("newsletter")!.comingSoon).toBe(true);
  });

  it("kind keys are unique", () => {
    expect(new Set(allKinds.map((k) => k.key)).size).toBe(allKinds.length);
  });
});

describe("familyForFormat", () => {
  const base = { isClippableFormat: false, labelsAsOriginal: false, parentFormatId: "p", postTypes: [] as string[] };
  it("clippable wins over everything", () => {
    expect(familyForFormat({ ...base, isClippableFormat: true, postTypes: ["newsletter"] })).toBe("clip");
  });
  it("newsletter channel → newsletter", () => {
    expect(familyForFormat({ ...base, postTypes: ["newsletter"] })).toBe("newsletter");
  });
  it("root original → pillar; derivative post → design", () => {
    expect(familyForFormat({ ...base, parentFormatId: null, labelsAsOriginal: true })).toBe("pillar");
    expect(familyForFormat({ ...base, postTypes: ["x"] })).toBe("design");
  });
});

describe("skill guide", () => {
  it("every family has questions and a markdown-free example", () => {
    for (const fam of ["clip", "design", "pillar", "newsletter"] as const) {
      expect(SKILL_QUESTIONS[fam].length).toBeGreaterThan(0);
      expect(SKILL_EXAMPLE[fam]).not.toMatch(/##|\[/);
    }
  });

  it("asks only what the Skill steers — not what the editors own", () => {
    expect(SKILL_QUESTIONS.clip.map((q) => q.id)).toEqual(["moments", "caption", "rules"]);
    expect(SKILL_QUESTIONS.design.map((q) => q.id)).toEqual(["caption", "rules"]);
  });
});

describe("kindLabelForFormat", () => {
  it("names an existing format by its channel", () => {
    expect(kindLabelForFormat("clip", ["youtube_shorts"])).toBe("YouTube Short");
    expect(kindLabelForFormat("design", ["instagram_post"])).toBe("Instagram carousel / image post");
    expect(kindLabelForFormat("clip", [])).toBe("video clip");
  });
});

describe("clipTargetForPostType", () => {
  it("follows the account's post type, with the platform label clip ideas carry", () => {
    expect(clipTargetForPostType("x")).toEqual({ clipTargetPostType: "x", clipTargetPlatform: ["X"] });
    expect(clipTargetForPostType("instagram_reel")?.clipTargetPlatform).toEqual(["Instagram Reel"]);
  });
  it("every clip kind agrees with it", () => {
    for (const k of FORMAT_PLATFORMS.flatMap((p) => p.kinds).filter((k) => k.family === "clip")) {
      expect(clipTargetForPostType(k.postType)).toEqual({ clipTargetPostType: k.clipTargetPostType, clipTargetPlatform: k.clipTargetPlatform });
    }
  });
  it("null for post types clips don't target", () => {
    expect(clipTargetForPostType("instagram_post")).toBeNull();
    expect(clipTargetForPostType(null)).toBeNull();
  });
});

describe("kindForExistingFormat", () => {
  const base = { labelsAsOriginal: false, parentFormatId: "p" };
  it("an X clip opens on X → Clip; an X text post on X → Carousel / image", () => {
    expect(kindForExistingFormat({ ...base, isClippableFormat: true, postTypes: ["x"] })).toEqual({ platformKey: "x", kindKey: "x_clip" });
    expect(kindForExistingFormat({ ...base, isClippableFormat: false, postTypes: ["x"] })).toEqual({ platformKey: "x", kindKey: "x_carousel" });
  });
  it("a root original opens as a pillar", () => {
    expect(kindForExistingFormat({ isClippableFormat: false, labelsAsOriginal: true, parentFormatId: null, postTypes: ["youtube_long"] })).toEqual({ platformKey: "pillar", kindKey: "pillar" });
  });
  it("a clip with no account yet falls back to the first clip kind", () => {
    expect(kindForExistingFormat({ ...base, isClippableFormat: true, postTypes: [] })).toEqual({ platformKey: "instagram", kindKey: "instagram_clip" });
  });
});

describe("defaultClipAspectFor", () => {
  it("landscape feeds are horizontal, everything else vertical — and every clip kind agrees", () => {
    expect(defaultClipAspectFor("x")).toBe("16:9");
    expect(defaultClipAspectFor("linkedin")).toBe("16:9");
    expect(defaultClipAspectFor("instagram_reel")).toBe("9:16");
    for (const k of FORMAT_PLATFORMS.flatMap((p) => p.kinds).filter((k) => k.family === "clip")) {
      expect(defaultClipAspectFor(k.postType)).toBe(k.clipAspectRatio);
    }
  });
});
