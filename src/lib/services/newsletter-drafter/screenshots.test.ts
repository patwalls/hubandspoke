import { describe, expect, it } from "vitest";
import { frameCandidateSecs, placeholderVideos, sectionVideoId } from "./screenshots";

describe("frameCandidateSecs", () => {
  it("grabs just before, on, and just after the moment, never before 0:00", () => {
    expect(frameCandidateSecs(272)).toEqual([270, 272, 275]);
    expect(frameCandidateSecs(1)).toEqual([0, 1, 4]);
  });
});

describe("which video a screenshot comes from", () => {
  const video = { kind: "video" as const, key: "video:vid-1", title: null, url: null };
  const caseStudy = { kind: "case_study" as const, key: "case:/stories/x", title: null, url: null };

  it("uses the issue's video for single-video drafts, whatever the section's story", () => {
    expect(sectionVideoId({ sourceItemId: "issue-vid" }, { source: caseStudy })).toBe("issue-vid");
  });

  it("uses each section's story video in a roundup, and none for a case study", () => {
    expect(sectionVideoId({ sourceItemId: null }, { source: video })).toBe("vid-1");
    expect(sectionVideoId({ sourceItemId: null }, { source: caseStudy })).toBeNull();
    expect(sectionVideoId({ sourceItemId: null }, { source: null })).toBeNull();
  });

  it("maps every placeholder in a roundup to its own section's video and moment", () => {
    const m = placeholderVideos({
      sourceItemId: null,
      sections: [
        { key: "story", markdown: "Hi\n*[Screenshot @ 1:05: the dashboard]*", source: video },
        { key: "case", markdown: "*[Screenshot: the founder's site]*", source: caseStudy },
      ],
    });
    expect(m.get("story:the dashboard")).toEqual({ videoId: "vid-1", sec: 65 });
    expect(m.get("case:the founder's site")).toEqual({ videoId: null, sec: null });
  });
});
