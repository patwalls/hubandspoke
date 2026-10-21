import { describe, expect, it } from "vitest";
import { describeStoryPlan, newStoryGuidance, planStories, withPlanDates, type PlannedStory } from "./story-plan";

const cfg = { leadVideos: ["orange_juice", "coffee"], flex: ["eggs", "toast", "pancakes"] };
const v = (id: string, at: string): PlannedStory => ({ kind: "video", key: `video:${id}`, title: id, url: `https://youtu.be/${id}`, publishedAt: at, productionItemId: id });
const c = (slug: string, at: string): PlannedStory => ({ kind: "case_study", key: `case:/stories/${slug}`, title: slug, url: `https://www.starterstory.com/stories/${slug}`, publishedAt: at });

describe("the suggested Sunday Breakfast lineup", () => {
  // The Oct 25, 2026 week: one fresh video (Oct 18's ran last Sunday), two fresh case studies.
  const plan = planStories(cfg, {
    weekVideos: [v("oct18", "2026-10-18"), v("oct21", "2026-10-21")],
    recentVideos: [v("oct21", "2026-10-21"), v("oct18", "2026-10-18"), v("oct15", "2026-10-15"), v("oct14", "2026-10-14")],
    caseStudies: [c("trysiteless", "2026-10-19"), c("invintory", "2026-10-20")],
    blocked: new Set(["video:oct18"]),
  });

  it("leads with the week's newest videos, topping up with the newest recent one when the week is short", () => {
    expect(plan.lead.map((l) => l.story?.key)).toEqual(["video:oct21", "video:oct15"]);
    expect(plan.videos.map((x) => x.key)).toEqual(["video:oct14"]);
  });

  it("offers the week's case studies newest first, then a recent video, as a suggestion (not a quota)", () => {
    expect(plan.caseStudies.map((x) => x.key)).toEqual(["case:/stories/invintory", "case:/stories/trysiteless"]);
    const text = describeStoryPlan(plan);
    expect(text).toMatch(/SUGGESTED STORY LINEUP/);
    expect(text).toMatch(/not a quota/);
    expect(text.indexOf("invintory")).toBeLessThan(text.indexOf("trysiteless"));
    expect(text).toMatch(/Otherwise a recently published video/);
    expect(text).not.toMatch(/oct18/);
  });

  it("points Find new story at case studies for a flex course and at videos for a lead course", () => {
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
