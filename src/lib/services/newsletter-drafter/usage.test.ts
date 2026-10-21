import { describe, expect, it } from "vitest";
import { storyKeyOf, submissionProblem, type NewsletterSubmission } from "./agent";
import { groupFromEmailName } from "./history";
import { toStoredSections } from "./run";
import { newStoryExclusions } from "./section";
import { blockedKeys, caseStudyKey, extractStoryRefs, isEvergreenOk, publishedLabel, usageLabel, withInferredSources, youtubeIdFromUrl } from "./usage";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";

describe("story keys from links", () => {
  it("keys starterstory.com stories by path and ignores footer / landing pages", () => {
    expect(caseStudyKey("https://www.starterstory.com/stories/myzia-io?_kx=abc")).toBe("case:/stories/myzia-io");
    expect(caseStudyKey("https://starterstory.com/Stories/MyZia-io/")).toBe("case:/stories/myzia-io");
    expect(caseStudyKey("https://www.starterstory.com/explore?business_type=software")).toBeNull();
    expect(caseStudyKey("https://www.starterstory.com/data/micro-saas-ideas")).toBeNull();
    expect(caseStudyKey("https://www.hubspot.com/products/crm")).toBeNull();
  });

  it("reads YouTube ids from youtu.be, watch and shorts links", () => {
    expect(youtubeIdFromUrl("https://youtu.be/aLidq3_FwW0")).toBe("aLidq3_FwW0");
    expect(youtubeIdFromUrl("https://www.youtube.com/watch?v=Ge1B-Ok1Pfk&t=3")).toBe("Ge1B-Ok1Pfk");
    expect(youtubeIdFromUrl("https://youtube.com/shorts/abcdefghijk")).toBe("abcdefghijk");
    expect(youtubeIdFromUrl("https://example.com/watch?v=x")).toBeNull();
  });

  it("pulls every story link out of an issue's HTML once", () => {
    const html = `<a href="https://www.starterstory.com/stories/a">x</a> <a href="https://youtu.be/aLidq3_FwW0">v</a>
      <a href="https://www.starterstory.com/stories/a?_kx=1">again</a> <a href="https://www.starterstory.com/about">footer</a>`;
    expect(extractStoryRefs(html)).toEqual({ caseKeys: ["case:/stories/a"], youtubeIds: ["aLidq3_FwW0"] });
  });

  it("maps the team's HubSpot issue names to their newsletter", () => {
    expect(groupFromEmailName("Starter Story | Newsletter | Oct. 18")).toBe("sunday-breakfast");
    expect(groupFromEmailName("Starter Story | Daily | Oct. 15")).toBe("daily-seinfeld");
    expect(groupFromEmailName("(A) The Hustle | Marketing")).toBeNull();
  });
});

describe("recency rules", () => {
  const usage = new Map([
    ["case:/stories/last-week", { count: 1, lastDate: "2026-10-18" }],
    ["case:/stories/a-month-ago", { count: 2, lastDate: "2026-09-27" }],
    ["video:old", { count: 3, lastDate: "2026-05-10" }],
  ]);

  it("blocks stories run in the 3 weeks before the send date — including last Sunday's", () => {
    const blocked = blockedKeys(usage, "2026-10-25");
    expect(blocked.has("case:/stories/last-week")).toBe(true);
    expect(blocked.has("case:/stories/a-month-ago")).toBe(false);
  });

  it("only treats a story as an 'older' pick if it hasn't run in 90 days", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    expect(isEvergreenOk(usage.get("video:old"), now)).toBe(true);
    expect(isEvergreenOk(usage.get("case:/stories/a-month-ago"), now)).toBe(false);
    expect(isEvergreenOk(undefined, now)).toBe(true);
  });

  it("labels usage and publish dates in plain words", () => {
    expect(usageLabel(undefined)).toBe("Never featured");
    expect(usageLabel({ count: 2, lastDate: "2026-09-14" })).toBe("Featured 2× · last Sep 14");
    const now = new Date("2026-10-21T12:00:00Z");
    expect(publishedLabel("2026-10-20", now)).toBe("Published Oct 20");
    expect(publishedLabel("2025-04-19T14:01:18.000Z", now)).toBe("Published Apr 19, 2025");
    expect(publishedLabel(null, now)).toBeNull();
  });
});

describe("enforcing the rules on a submission", () => {
  const t = DEFAULT_TEMPLATES["sunday breakfast"];
  const base = t.sections.map((s) => ({ key: s.key, markdown: `copy for ${s.key}`, source: null as NewsletterSubmission["sections"] extends Array<infer S> | undefined ? S extends { source?: infer X } ? X : never : never }));
  const sub = (overrides: Record<string, { url: string }>): NewsletterSubmission => ({
    subject_options: ["a", "b", "c"],
    subject: "a",
    preview_text: "p",
    sources: [],
    sections: base.map((s) => (overrides[s.key] ? { ...s, source: { kind: "case_study" as const, url: overrides[s.key].url, title: "t" } } : s)),
  });

  it("rejects a recently-run story and the same story in two sections, accepts fresh ones", () => {
    const blocked = new Set(["case:/stories/last-week"]);
    expect(submissionProblem(sub({ coffee: { url: "https://www.starterstory.com/stories/last-week" } }), t, false, blocked)).toMatch(/ran in the last 21 days/);
    expect(
      submissionProblem(sub({ coffee: { url: "https://www.starterstory.com/stories/x" }, eggs: { url: "https://starterstory.com/stories/x/" } }), t, false, blocked),
    ).toMatch(/same story/);
    expect(submissionProblem(sub({ coffee: { url: "https://www.starterstory.com/stories/x" }, eggs: { url: "https://www.starterstory.com/stories/y" } }), t, false, blocked)).toBeNull();
  });

  it("stores each section's story under its usage key", () => {
    const stored = toStoredSections([
      { key: "coffee", markdown: "m", source: { kind: "case_study", url: "https://www.starterstory.com/stories/x", title: "X" } },
      { key: "orange_juice", markdown: "m", source: { kind: "video", production_item_id: "abc", url: "https://youtu.be/1", title: "V" } },
      { key: "intro", markdown: "m", source: null },
    ]);
    expect(stored.map((s) => s.source?.key ?? null)).toEqual(["case:/stories/x", "video:abc", null]);
    expect(storyKeyOf({ kind: "video", production_item_id: null })).toBeNull();
  });

  it("Find new story never re-offers this section's current or past stories, or another section's", () => {
    const sections = [
      { key: "coffee", markdown: "", source: { kind: "case_study" as const, key: "case:/stories/now", title: null, url: null }, tried: ["case:/stories/before"] },
      { key: "eggs", markdown: "", source: { kind: "case_study" as const, key: "case:/stories/eggs", title: null, url: null } },
    ];
    expect([...newStoryExclusions(sections, "coffee")].sort()).toEqual(["case:/stories/before", "case:/stories/eggs", "case:/stories/now"]);
  });
});

describe("withInferredSources", () => {
  const sources = [
    { kind: "video" as const, productionItemId: "v1", title: "Main video", url: "https://www.youtube.com/watch?v=RSlhgyAXsBI" },
    { kind: "video" as const, productionItemId: "v2", title: "Second", url: "https://youtu.be/uvIcGuN2iO8" },
  ];

  it("fills a course's story from its link, matching youtu.be to watch links and case studies by path", () => {
    const out = withInferredSources(
      [
        { key: "orange_juice", markdown: "**Hook**\n\n[Watch the whole story here](https://youtu.be/RSlhgyAXsBI)" },
        { key: "coffee", markdown: "[Check it out](https://www.youtube.com/watch?v=uvIcGuN2iO8&t=4)" },
        { key: "eggs", markdown: "[Read it](https://www.starterstory.com/stories/myzia-io?_kx=1)" },
        { key: "signoff", markdown: "That's it!" },
      ],
      sources,
    );
    expect(out.map((s) => s.source?.key ?? null)).toEqual(["video:v1", "video:v2", "case:/stories/myzia-io", null]);
    expect(out[0].source?.title).toBe("Main video");
  });

  it("keeps an explicit source, and gives a story teased in the intro to its full section", () => {
    const explicit = { kind: "case_study" as const, key: "case:/stories/x", title: "X", url: null };
    const out = withInferredSources(
      [
        { key: "intro", markdown: "This week's [episode](https://youtu.be/RSlhgyAXsBI)." },
        { key: "orange_juice", markdown: "A much longer write-up of the episode, with the link at the end. [Watch](https://youtu.be/RSlhgyAXsBI)" },
        { key: "coffee", markdown: "[Watch](https://youtu.be/uvIcGuN2iO8)", source: explicit },
      ],
      sources,
    );
    expect(out.map((s) => s.source?.key ?? null)).toEqual([null, "video:v1", "case:/stories/x"]);
  });
});
