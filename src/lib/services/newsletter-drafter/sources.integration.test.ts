import { describe, expect, it } from "vitest";
import { createTestFormat, createTestProductionItem, createTestTranscript } from "@/test/factories";
import { getPastIssues, listRecentVideos } from "./sources";
import { listNewsletterFormats } from "./queries";

// A window far in the past so real rows in the dev DB never land in it.
const W = { start: new Date("2001-03-01T00:00:00Z"), end: new Date("2001-03-08T00:00:00Z") };

describe("listRecentVideos", () => {
  it("returns only published, non-deleted long-form videos inside the window, flagging transcripts", async () => {
    const inside = await createTestProductionItem({ postType: "youtube_long", publishedAt: new Date("2001-03-05T00:00:00Z"), publishedLink: "https://youtu.be/in" });
    await createTestTranscript({ productionItemId: inside.id, segments: [{ startSec: 0, endSec: 5, text: "hello" }] });
    const noTranscript = await createTestProductionItem({ postType: "youtube_long", publishedAt: new Date("2001-03-06T00:00:00Z") });
    await createTestProductionItem({ postType: "youtube_long", publishedAt: new Date("2001-02-20T00:00:00Z") }); // before window
    await createTestProductionItem({ postType: "youtube_shorts", publishedAt: new Date("2001-03-05T00:00:00Z") }); // wrong type
    await createTestProductionItem({ postType: "youtube_long", publishedAt: new Date("2001-03-05T00:00:00Z"), deletedAt: new Date() });
    await createTestProductionItem({ postType: "youtube_long", status: "Assigned", publishedAt: new Date("2001-03-05T00:00:00Z") });

    const videos = await listRecentVideos("starter-story", W);
    expect(videos.map((v) => v.productionItemId)).toEqual([noTranscript.id, inside.id]);
    expect(videos.find((v) => v.productionItemId === inside.id)).toMatchObject({ hasTranscript: true, url: "https://youtu.be/in" });
    expect(videos.find((v) => v.productionItemId === noTranscript.id)?.hasTranscript).toBe(false);
  });
});

describe("newsletter formats + past issues", () => {
  it("finds a format by its published newsletter items and reads their bodies as exemplars", async () => {
    const fmt = await createTestFormat({ instructions: "Be punchy." });
    await createTestProductionItem({ postType: "newsletter", format: fmt.name, contentBody: "Issue body one", title: "Subject one" });
    await createTestProductionItem({ postType: "newsletter", format: fmt.name, contentBody: null }); // no body → not an exemplar
    const other = await createTestFormat();

    const formats = await listNewsletterFormats("starter-story");
    expect(formats.find((f) => f.id === fmt.id)).toMatchObject({ hasSkill: true });
    expect(formats.some((f) => f.id === other.id)).toBe(false);

    const issues = await getPastIssues("starter-story", fmt.name.toUpperCase());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ subject: "Subject one", body: "Issue body one" });
  });

  it("prefers same-voice issues for a two-voice format, and falls back to all when that voice has too few", async () => {
    const fmt = await createTestFormat();
    const at = (d: string) => new Date(`2031-0${d}T12:00:00Z`);
    await createTestProductionItem({ postType: "newsletter", format: fmt.name, contentBody: "K1", title: "Kevin one", authorDisplayName: "Kevin", publishedAt: at("1-01") });
    await createTestProductionItem({ postType: "newsletter", format: fmt.name, contentBody: "K2", title: "Kevin two", authorDisplayName: "Kevin", publishedAt: at("1-02") });
    await createTestProductionItem({ postType: "newsletter", format: fmt.name, contentBody: "S1", title: "Saj one", authorDisplayName: "Saj", publishedAt: at("1-03") });
    const kevin = await getPastIssues("starter-story", fmt.name, "Kevin");
    expect(kevin.map((i) => i.subject)).toEqual(["Kevin two", "Kevin one"]);
    // Only one Saj issue: not enough to stand alone, so every issue is an example.
    expect((await getPastIssues("starter-story", fmt.name, "Saj")).map((i) => i.subject)).toEqual(["Saj one", "Kevin two", "Kevin one"]);
    expect(await getPastIssues("starter-story", fmt.name)).toHaveLength(3);
    // Unattributed issues (no byline) fill in after the voice's own, ahead of nothing from the other voice.
    await createTestProductionItem({ postType: "newsletter", format: fmt.name, contentBody: "U1", title: "No byline", authorDisplayName: null, publishedAt: at("1-04") });
    expect((await getPastIssues("starter-story", fmt.name, "Kevin")).map((i) => i.subject)).toEqual(["Kevin two", "Kevin one", "No byline"]);
    expect((await getPastIssues("starter-story", fmt.name, "Saj")).map((i) => i.subject)).toEqual(["Saj one", "No byline"]);
  });
});
