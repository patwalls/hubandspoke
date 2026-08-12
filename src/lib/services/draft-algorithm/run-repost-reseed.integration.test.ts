import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, productionItems } from "@/lib/db/schema";
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

// Regression guard for the cross-post caption bug (2026-08-07).
//
// Unlike reposts (which return "repost_kept_verbatim" before any guard runs),
// cross-posts have NO early-exit protection in runDraftAlgorithm. The
// idempotency guard explicitly ALLOWS overwriting "copy:source" drafts —
// `hasMeaningfulCaption && !isSeededCopy` is false when isSeededCopy=true,
// so the guard passes through.
//
// This means: if draft-algorithm-run is ever re-added to the cross-post route,
// the AI will silently overwrite the verbatim caption seed. The cross-post route
// intentionally does NOT enqueue that job (see the comment there). This test
// documents that removing the enqueue is necessary, not accidental.
describe("runDraftAlgorithm — cross-post copy:source guard (regression)", () => {
  it("cross-post copy:source draft does NOT trigger already_filled or repost_kept_verbatim", async () => {
    const accountId = await getTestAccountId();
    const source = await createTestProductionItem({ postType: "x", accountId });
    const crossPost = await createTestProductionItem({
      postType: "x",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      accountId,
    });

    // Remove all substrate-resolving text from both items so the algorithm
    // reaches no_substrate without calling the LLM. The idempotency guard
    // check runs BEFORE substrate loading, so a no_substrate result proves
    // the guard did NOT block execution (unlike already_filled or
    // repost_kept_verbatim, which return before substrate loading).
    await db
      .update(productionItems)
      .set({ title: null, contentBody: null })
      .where(eq(productionItems.id, source.id));
    await db
      .update(productionItems)
      .set({ title: null, contentBody: null })
      .where(eq(productionItems.id, crossPost.id));

    await db.insert(contentDrafts).values({
      productionItemId: crossPost.id,
      version: 1,
      isCurrent: true,
      content: { tweet: "copied source caption" },
      fieldSchemaSnapshot: PLATFORM_FIELD_SCHEMAS.x,
      generatedBy: "copy:source",
    });

    const result = await runDraftAlgorithm(crossPost.id);

    // If either of these pass, it means the algorithm NOW protects
    // copy:source cross-post drafts — the enqueue-removal comment in
    // the route would need revisiting.
    expect(result.reason).not.toBe("repost_kept_verbatim");
    expect(result.reason).not.toBe("already_filled");

    // The algorithm ran past the idempotency guard. It only stopped because
    // there was no substrate. With a real source body or title (which is
    // always the case for production cross-posts), it would reach
    // generateDraft and overwrite the caption.
    expect(result).toMatchObject({ status: "skipped", reason: "no_substrate" });
  });
});
