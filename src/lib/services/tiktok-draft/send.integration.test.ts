import { describe, it, expect } from "vitest";
import {
  createTestAccount,
  createTestProductionItem,
  createTestMedia,
  createTestContentDraft,
} from "@/test/factories";
import { buildTikTokDraftPreview } from "./send";

// Real-DB proof that the preview's guardrails read the carousel table (not the
// legacy mirror) and wire up account-connection + caption correctly. The
// pure-logic matrix lives in send.test.ts; this verifies the DB gather.

describe("buildTikTokDraftPreview (integration)", () => {
  async function tiktokItem(opts: { connected?: boolean } = {}) {
    const account = await createTestAccount({
      platform: "tiktok",
      zernioAccountId: opts.connected ? "zernio-acct-test" : null,
    });
    const item = await createTestProductionItem({
      postType: "tiktok",
      accountId: account.id,
      platform: ["TikTok"],
      status: "Ready To Publish",
      publishedAt: null,
    });
    return { account, item };
  }

  it("is ready (no blocks) for a connected account with one video + caption", async () => {
    const { item } = await tiktokItem({ connected: true });
    await createTestMedia({ productionItemId: item.id, kind: "video" });
    await createTestContentDraft({
      productionItemId: item.id,
      content: { caption: "A real caption" },
    });

    const preview = await buildTikTokDraftPreview(item.id);
    expect(preview.blockingReasons).toEqual([]);
    expect(preview.accountConnected).toBe(true);
    expect(preview.caption).toBe("A real caption");
    expect(preview.mediaCount).toBe(1);
  });

  // The headline guard: a multi-slide item must surface multiple_media, proving
  // we count production_item_media rows rather than trusting the index-0 mirror.
  it("blocks a multi-media (slideshow) item", async () => {
    const { item } = await tiktokItem({ connected: true });
    await createTestMedia({ productionItemId: item.id, index: 0, kind: "image" });
    await createTestMedia({ productionItemId: item.id, index: 1, kind: "image" });
    await createTestMedia({ productionItemId: item.id, index: 2, kind: "image" });
    await createTestContentDraft({
      productionItemId: item.id,
      content: { caption: "caption" },
    });

    const preview = await buildTikTokDraftPreview(item.id);
    expect(preview.mediaCount).toBe(3);
    expect(preview.blockingReasons.map((b) => b.code)).toContain(
      "multiple_media",
    );
  });

  it("blocks when the account isn't connected to Zernio", async () => {
    const { item } = await tiktokItem({ connected: false });
    await createTestMedia({ productionItemId: item.id, kind: "video" });
    await createTestContentDraft({
      productionItemId: item.id,
      content: { caption: "caption" },
    });

    const preview = await buildTikTokDraftPreview(item.id);
    expect(preview.accountConnected).toBe(false);
    expect(preview.blockingReasons.map((b) => b.code)).toContain(
      "not_connected",
    );
  });

  it("blocks when there is no caption", async () => {
    const { item } = await tiktokItem({ connected: true });
    await createTestMedia({ productionItemId: item.id, kind: "video" });
    // no content draft → no caption

    const preview = await buildTikTokDraftPreview(item.id);
    expect(preview.blockingReasons.map((b) => b.code)).toContain("no_caption");
  });
});
