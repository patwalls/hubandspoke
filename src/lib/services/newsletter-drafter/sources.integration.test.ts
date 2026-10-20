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
});
