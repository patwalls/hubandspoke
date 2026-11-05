import { describe, expect, it } from "vitest";
import { featurePassages, parseFeatureDoc, rankPassages, searchFeatureDocs } from "./help-search";

const DOC = `# Features
## Content
| Feature | Status | Notes |
|---|---|---|
| Cross-posts | Active | Repost a clip from one platform to another from the Queue. |
| Scheduling | Active | Schedule or Publish Now from the content page. |
## Cleanup backlog (the "things we want to remove" list)
| Old cross-post thing | Deprecated | remove me |
`;

describe("help search", () => {
  it("parses table rows under their section, skipping headers and the cleanup backlog", () => {
    const rows = parseFeatureDoc(DOC);
    expect(rows.map((r) => `${r.section}/${r.title}`)).toEqual(["Content/Cross-posts", "Content/Scheduling"]);
  });

  it("ranks by keyword overlap with a title boost", () => {
    const rows = parseFeatureDoc(DOC);
    expect(rankPassages(rows, "how do I cross-post a clip?", 3)[0].title).toBe("Cross-posts");
    expect(rankPassages(rows, "schedule a post", 3)[0].title).toBe("Scheduling");
    expect(rankPassages(rows, "the and of", 3)).toEqual([]);
  });

  it("reads the real docs/features.md and finds the Academy row", () => {
    expect(featurePassages().length).toBeGreaterThan(50);
    expect(searchFeatureDocs("academy training videos").some((p) => /academy/i.test(p.title))).toBe(true);
  });
});
