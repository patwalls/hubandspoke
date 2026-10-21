import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { sourceToolsFor } from "./agent";
import { singleVideoSourceNote } from "./format-config";
import { describeStoryPlan, newStoryGuidance, planStories, storySections, withPlanDates, type PlannedStory } from "./story-plan";

const v = (id: string, at: string): PlannedStory => ({ kind: "video", key: `video:${id}`, title: id, url: `https://youtu.be/${id}`, publishedAt: at, productionItemId: id });
const c = (slug: string, at: string): PlannedStory => ({ kind: "case_study", key: `case:/stories/${slug}`, title: slug, url: `https://www.starterstory.com/stories/${slug}`, publishedAt: at });

describe("story settings live on the template", () => {
  it("Sunday Breakfast's default: two newest videos, three case-study courses, no story in the intro / sponsor / sign-off", () => {
    expect(storySections(DEFAULT_TEMPLATES["sunday breakfast"])).toEqual([
      { key: "orange_juice", story: "newest_video" },
      { key: "coffee", story: "newest_video" },
      { key: "eggs", story: "case_study" },
      { key: "toast", story: "case_study" },
      { key: "pancakes", story: "case_study" },
    ]);
  });

  it("Daily Seinfeld picks ONE story (video or case study); the How-To has no per-section stories", () => {
    expect(storySections(DEFAULT_TEMPLATES["daily seinfeld"])).toEqual([{ key: "story", story: "any" }]);
    expect(singleVideoSourceNote("How-To Newsletter - Futurepedia (pilot)")).toMatch(/ONE video.*@futurepedia_io or @SkillLeapAI/);
    expect(singleVideoSourceNote("Sunday Breakfast")).toBeNull();
  });

  it("only brands with case studies get the Starter Story tools", () => {
    const names = (brand: string) => sourceToolsFor(brand).map((t) => ("name" in t ? t.name : ""));
    expect(names("starter-story")).toEqual(expect.arrayContaining(["list_recent_case_studies", "web_fetch"]));
    expect(names("futurepedia")).not.toContain("list_recent_case_studies");
    expect(names("futurepedia")).not.toContain("web_fetch");
    expect(names("futurepedia")).toContain("list_recent_videos");
  });
});

describe("the suggested lineup", () => {
  const sections = storySections(DEFAULT_TEMPLATES["sunday breakfast"]);
  // The Oct 25, 2026 week: one fresh video (Oct 18's ran last Sunday), two fresh case studies.
  const plan = planStories(sections, {
    weekVideos: [v("oct18", "2026-10-18"), v("oct21", "2026-10-21")],
    recentVideos: [v("oct21", "2026-10-21"), v("oct18", "2026-10-18"), v("oct15", "2026-10-15"), v("oct14", "2026-10-14")],
    caseStudies: [c("trysiteless", "2026-10-19"), c("invintory", "2026-10-20")],
    blocked: new Set(["video:oct18"]),
  });
  const pick = (k: string) => plan.sections.find((s) => s.sectionKey === k)?.pick?.key;

  it("deals the week's newest videos first, then case studies newest first, then a recent video", () => {
    expect(pick("orange_juice")).toBe("video:oct21");
    expect(pick("coffee")).toBe("video:oct15");
    expect(pick("eggs")).toBe("case:/stories/invintory");
    expect(pick("toast")).toBe("case:/stories/trysiteless");
    expect(pick("pancakes")).toBe("video:oct14");
  });

  it("hands it over as a suggestion, never the blocked story", () => {
    const text = describeStoryPlan(plan);
    expect(text).toMatch(/SUGGESTED STORY LINEUP/);
    expect(text).toMatch(/not a quota/);
    expect(text).toMatch(/"eggs": usually a case study/);
    expect(text).not.toMatch(/oct18/);
  });

  it("points Find new story at case studies for a case-study course and at videos for a video course", () => {
    const exclude = new Set(["case:/stories/invintory", "video:oct21"]);
    expect(newStoryGuidance(plan, "eggs", exclude)).toMatch(/case study[\s\S]*trysiteless/);
    expect(newStoryGuidance(plan, "eggs", exclude)).not.toMatch(/invintory/);
    expect(newStoryGuidance(plan, "orange_juice", exclude)).toMatch(/video[\s\S]*oct15/);
    expect(newStoryGuidance(plan, "intro", exclude)).toBeNull();
  });

  it("stamps the case study's publish date onto the section that used it", () => {
    const out = withPlanDates([{ key: "eggs", source: { key: "case:/stories/invintory", publishedAt: null } }, { key: "intro", source: null }], plan);
    expect(out[0].source?.publishedAt).toBe("2026-10-20");
    expect(out[1].source).toBeNull();
  });
});
