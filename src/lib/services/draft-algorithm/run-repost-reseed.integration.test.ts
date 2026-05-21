import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts } from "@/lib/db/schema";
import { PLATFORM_FIELD_SCHEMAS } from "@/lib/platform-field-schemas";
import {
  createTestProductionItem,
  getTestAccountId,
} from "@/test/factories";
import { runDraftAlgorithm } from "./run";

// Repost manual-Regenerate re-seed path. The auto-fire on repost
// creation never enqueues draft-algorithm-run (the repost route owns
// the initial seed); the only caller that hits this branch with
// force=true is the manual `POST /api/production-items/[id]/draft`
// route — i.e., Pat clicking Regenerate on a repost.
//
// Source bodies in these tests are intentionally <30 chars so
// `stripDateOpenerWithLLM`'s MIN_BODY_CHARS_FOR_LLM precheck skips the
// Haiku call. The re-seed path itself is what we're testing — the
// cleanup is unit-tested elsewhere.

describe("runDraftAlgorithm — repost re-seed (force=true)", () => {
  it("re-seeds the draft from source.contentBody and writes a new version", async () => {
    const accountId = await getTestAccountId();

    const source = await createTestProductionItem({
      postType: "x",
      contentBody: "fresh source body",
      accountId,
    });
    const repost = await createTestProductionItem({
      postType: "x",
      sourceType: "repost",
      repostedFromItemId: source.id,
      contentBody: null,
      accountId,
    });

    // Seed a v1 draft with an empty body — mirrors the failure mode in
    // the screenshot (initial seed had nothing to copy because the
    // source was unenriched at create time).
    await db.insert(contentDrafts).values({
      productionItemId: repost.id,
      version: 1,
      isCurrent: true,
      content: { tweet: "" },
      fieldSchemaSnapshot: PLATFORM_FIELD_SCHEMAS.x,
      generatedBy: "copy:source",
    });

    const result = await runDraftAlgorithm(repost.id, { force: true });
    expect(result.status).toBe("generated");
    expect(result.captionPreview).toBe("fresh source body");

    const drafts = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.productionItemId, repost.id))
      .orderBy(contentDrafts.version);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].isCurrent).toBe(false);
    expect(drafts[1].isCurrent).toBe(true);
    expect(drafts[1].generatedBy).toBe("copy:source:reseed");
    expect((drafts[1].content as Record<string, string>).tweet).toBe(
      "fresh source body",
    );
  });

  it("auto-fire (force=false) still skips with repost_kept_verbatim", async () => {
    // Auto-fire is the case where draft-algorithm-run gets enqueued by
    // a non-Regenerate path. The repost route doesn't enqueue today, so
    // this is mostly a defense-in-depth assertion: if anyone ever wires
    // up auto-fire on repost, it stays a no-op.
    const accountId = await getTestAccountId();
    const source = await createTestProductionItem({
      postType: "x",
      contentBody: "ignored body",
      accountId,
    });
    const repost = await createTestProductionItem({
      postType: "x",
      sourceType: "repost",
      repostedFromItemId: source.id,
      accountId,
    });

    const result = await runDraftAlgorithm(repost.id, { force: false });
    expect(result).toEqual({
      status: "skipped",
      reason: "repost_kept_verbatim",
    });
  });

  it("skips with source_body_empty when the source row has no contentBody", async () => {
    const accountId = await getTestAccountId();
    const source = await createTestProductionItem({
      postType: "x",
      contentBody: null,
      accountId,
    });
    const repost = await createTestProductionItem({
      postType: "x",
      sourceType: "repost",
      repostedFromItemId: source.id,
      accountId,
    });

    const result = await runDraftAlgorithm(repost.id, { force: true });
    expect(result).toEqual({
      status: "skipped",
      reason: "source_body_empty",
    });
  });

  it("skips with no_source_for_reseed when repostedFromItemId is null", async () => {
    // Defensive — repost-creation enforces the FK, but a hand-edited row
    // (or test fixture) could land here. Should not crash.
    const accountId = await getTestAccountId();
    const repost = await createTestProductionItem({
      postType: "x",
      sourceType: "repost",
      repostedFromItemId: null,
      accountId,
    });

    const result = await runDraftAlgorithm(repost.id, { force: true });
    expect(result).toEqual({
      status: "skipped",
      reason: "no_source_for_reseed",
    });
  });
});
