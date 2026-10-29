import { describe, expect, it } from "vitest";
import {
  createTestContentDraft,
  createTestProductionItem,
} from "@/test/factories";
import { loadSourceCaption } from "./source-caption";

// Regression: cross-posting a clip to TikTok seeded its caption with the
// clip-idea notes ("Source: … / Timestamp: … / Angle: …") held in the clip's
// content_body, instead of the caption the editor wrote on the clip.
const NOTES =
  "Source: How to Earn Respect in Sales\nTimestamp: 02:46–03:15 (29s)\n\nAngle: x\n\nWhy: y";

describe("loadSourceCaption", () => {
  it("returns the clip's draft caption, not its clip-idea notes", async () => {
    const source = await createTestProductionItem({
      postType: "instagram_reel",
      contentBody: NOTES,
    });
    await createTestContentDraft({
      productionItemId: source.id,
      content: { caption: "Being relatable goes a long way in sales." },
    });
    expect(await loadSourceCaption(source)).toBe(
      "Being relatable goes a long way in sales.",
    );
  });

  it("returns null when the clip has no caption yet", async () => {
    const source = await createTestProductionItem({
      postType: "instagram_reel",
      contentBody: NOTES,
    });
    expect(await loadSourceCaption(source)).toBeNull();
  });

  it("keeps a synced post's real body", async () => {
    const source = await createTestProductionItem({
      postType: "x",
      contentBody: "original tweet caption",
    });
    await createTestContentDraft({
      productionItemId: source.id,
      content: { tweet: "something else" },
    });
    expect(await loadSourceCaption(source)).toBe("original tweet caption");
  });
});
