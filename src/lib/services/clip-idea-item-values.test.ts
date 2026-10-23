import { describe, expect, it } from "vitest";
import { clipIdeaItemValues } from "./clip-idea-item-values";

describe("clipIdeaItemValues", () => {
  it("starts every generated idea unassigned, as an Idea", () => {
    // Before 2026-10-23 ideas took the Generate clicker or the pillar's owner,
    // which put 2,242 Ideas in Pat's name.
    const v = clipIdeaItemValues({
      hook: "A hook",
      body: "body",
      brand: "my-first-million",
      formatName: "Repackage Section With Hook",
      pillarId: "pillar",
      clipIdeaId: "idea",
      platform: ["Instagram"],
      postType: "instagram_reel",
      accountId: null,
      utmCampaign: "a-hook",
    });
    expect(v.editorUserId).toBeNull();
    expect(v.status).toBe("Idea");
    expect(v.pillarContentItemId).toBe("pillar");
  });
});
