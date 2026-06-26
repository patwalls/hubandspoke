import { describe, it, expect } from "vitest";
import {
  evaluateGuardrails,
  type DraftContext,
  type TikTokDraftBlockCode,
} from "./send";

// A fully-valid, ready-to-send context. Each test overrides one field to
// prove that field's guardrail fires (or doesn't). This is the contract the
// route + scheduled task both rely on — the matrix encodes Pat's feared
// failures: wrong video, missing caption, slideshow-as-slide-1, double-send.
function validContext(over: Partial<DraftContext> = {}): DraftContext {
  return {
    itemId: "item-1",
    postType: "tiktok",
    accountId: "acct-1",
    zernioPostId: null,
    zernioStatus: null,
    editorUserId: "user-1",
    accountPlatform: "tiktok",
    accountHandle: "starterstory",
    zernioAccountId: "zernio-acct-1",
    mediaId: "media-1",
    mediaCount: 1,
    mediaKind: "video",
    mediaS3Key: "uploads/item-1/vid.mp4",
    mediaContentType: "video/mp4",
    mediaPosterS3Key: "uploads/item-1/poster.jpg",
    mediaSizeBytes: 20 * 1024 * 1024,
    caption: "First line hook\nthen the body",
    capUsed24h: 0,
    ...over,
  };
}

function codes(ctx: DraftContext, opts = {}): TikTokDraftBlockCode[] {
  return evaluateGuardrails(ctx, opts).blocks.map((b) => b.code);
}

describe("evaluateGuardrails", () => {
  it("passes a fully-valid TikTok video context with no blocks", () => {
    const { blocks, warnings } = evaluateGuardrails(validContext(), {});
    expect(blocks).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("blocks non-TikTok post types", () => {
    expect(codes(validContext({ postType: "instagram_reel" }))).toContain(
      "not_tiktok",
    );
    expect(codes(validContext({ postType: null }))).toContain("not_tiktok");
  });

  it("blocks when there is no media", () => {
    expect(
      codes(validContext({ mediaCount: 0, mediaId: null, mediaKind: null })),
    ).toContain("no_media");
  });

  // Pat's #1 fear: a slideshow must NEVER silently post as just slide 1.
  it("blocks multi-media items (slideshow guard)", () => {
    const got = codes(
      validContext({ mediaCount: 5, mediaId: null, mediaKind: null }),
    );
    expect(got).toContain("multiple_media");
  });

  it("blocks when the single media item isn't a video", () => {
    expect(
      codes(validContext({ mediaKind: "image", mediaContentType: "image/jpeg" })),
    ).toContain("not_video");
    // kind says video but contentType disagrees → still blocked.
    expect(
      codes(validContext({ mediaKind: "video", mediaContentType: "image/jpeg" })),
    ).toContain("not_video");
  });

  it("blocks an empty / whitespace caption", () => {
    expect(codes(validContext({ caption: "" }))).toContain("no_caption");
  });

  it("blocks when the account isn't connected to Zernio", () => {
    expect(codes(validContext({ zernioAccountId: null }))).toContain(
      "not_connected",
    );
    // Right column set but wrong platform → still blocked.
    expect(
      codes(validContext({ accountPlatform: "instagram" })),
    ).toContain("not_connected");
  });

  describe("idempotency / already-sent", () => {
    it("blocks once a post id exists", () => {
      expect(codes(validContext({ zernioPostId: "z-1" }))).toContain(
        "already_sent",
      );
    });

    it("blocks while sending or delivered", () => {
      expect(codes(validContext({ zernioStatus: "sending" }))).toContain(
        "already_sent",
      );
      expect(codes(validContext({ zernioStatus: "delivered" }))).toContain(
        "already_sent",
      );
    });

    it("blocks a send-now on a scheduled item", () => {
      expect(codes(validContext({ zernioStatus: "scheduled" }))).toContain(
        "already_sent",
      );
    });

    it("does NOT treat 'scheduled' as a block for the scheduled task", () => {
      // The task transitions scheduled → sending; 'scheduled' is its expected
      // starting state, not an already-sent error.
      const got = codes(validContext({ zernioStatus: "scheduled" }), {
        fromScheduledTask: true,
      });
      expect(got).not.toContain("already_sent");
    });
  });

  describe("staleness guards", () => {
    it("blocks when the media changed since preview", () => {
      expect(
        codes(validContext({ mediaId: "media-2" }), {
          expectedMediaId: "media-1",
        }),
      ).toContain("media_changed");
    });

    it("blocks when the caption changed since preview", () => {
      expect(
        codes(validContext({ caption: "new caption" }), {
          expectedCaption: "old caption",
        }),
      ).toContain("caption_changed");
    });

    it("does not block when expected values still match", () => {
      const ctx = validContext();
      expect(
        codes(ctx, { expectedMediaId: ctx.mediaId, expectedCaption: ctx.caption }),
      ).toEqual([]);
    });
  });

  describe("warnings (non-blocking)", () => {
    it("warns but does not block on an oversized video", () => {
      const { blocks, warnings } = evaluateGuardrails(
        validContext({ mediaSizeBytes: 400 * 1024 * 1024 }),
        {},
      );
      expect(blocks).toEqual([]);
      expect(warnings.map((w) => w.code)).toContain("size");
    });

    it("warns but does not block when the 24h cap is reached", () => {
      const { blocks, warnings } = evaluateGuardrails(
        validContext({ capUsed24h: 25 }),
        {},
      );
      expect(blocks).toEqual([]);
      expect(warnings.map((w) => w.code)).toContain("cap");
    });
  });

  it("reports every applicable block at once (not just the first)", () => {
    const got = codes(
      validContext({
        mediaCount: 3,
        mediaId: null,
        caption: "",
        zernioAccountId: null,
      }),
    );
    expect(got).toEqual(
      expect.arrayContaining([
        "multiple_media",
        "no_caption",
        "not_connected",
      ]),
    );
  });
});
