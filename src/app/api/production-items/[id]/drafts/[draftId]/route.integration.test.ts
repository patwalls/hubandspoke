import { describe, it, expect } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  contentEvents,
  type ContentDraftContent,
  type FormatFieldSchema,
} from "@/lib/db/schema";
import {
  createTestProductionItem,
  getTestUserId,
} from "@/test/factories";
import { applyDraftPatch } from "@/lib/services/content-drafts/apply-patch";

// Pins the clone-on-write behavior for inline draft edits (the PUT
// /drafts/[draftId] route delegates to applyDraftPatch):
//   • each edit inserts a NEW version row instead of UPDATEing in place
//   • the old version stays around with isCurrent=false
//   • one `content_changed` event lands per field whose value moved
//   • concurrent autosaves chain instead of colliding on
//     uq_content_drafts_current (HUBANDSPOKE-15/19/1V/1S)

const SCHEMA: FormatFieldSchema = {
  fields: [
    {
      key: "caption",
      type: "longtext",
      label: "Caption",
      prompt: "The caption.",
      required: false,
    },
  ],
  version: 1,
};

async function seedInitialDraft(itemId: string, content: ContentDraftContent) {
  const [row] = await db
    .insert(contentDrafts)
    .values({
      productionItemId: itemId,
      version: 1,
      isCurrent: true,
      content,
      fieldSchemaSnapshot: SCHEMA,
      generatedBy: "test:seed",
      promptVersion: null,
      modelUsage: null,
      createdByUserId: null,
    })
    .returning();
  return row;
}

describe("clone-on-write draft edits + content_changed audit", () => {
  it("creates a new version row + emits draft_field event when caption changes", async () => {
    const item = await createTestProductionItem({});
    await seedInitialDraft(item.id, { caption: "First caption" });
    const userId = await getTestUserId();

    const next = await applyDraftPatch({
      itemId: item.id,
      validatedPatch: { caption: "Second caption" },
      actorUserId: userId,
    });

    // Both draft rows present, only the new one is current.
    const drafts = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.productionItemId, item.id))
      .orderBy(contentDrafts.version);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].version).toBe(1);
    expect(drafts[0].isCurrent).toBe(false);
    expect((drafts[0].content as { caption: string }).caption).toBe(
      "First caption",
    );
    expect(drafts[1].version).toBe(2);
    expect(drafts[1].isCurrent).toBe(true);
    expect((drafts[1].content as { caption: string }).caption).toBe(
      "Second caption",
    );
    expect(drafts[1].generatedBy).toBe("user:edit");
    expect(drafts[1].id).toBe(next.id);

    // One content_changed event landed for the caption move.
    const events = await db
      .select()
      .from(contentEvents)
      .where(
        and(
          eq(contentEvents.contentItemId, item.id),
          eq(contentEvents.eventType, "content_changed"),
        ),
      )
      .orderBy(desc(contentEvents.createdAt));
    expect(events).toHaveLength(1);
    const payload = events[0].payload as {
      type: string;
      target: { kind: string; draftId: string; version: number; field: string };
      source: { kind: string };
      from?: string;
      to?: string;
    };
    expect(payload.type).toBe("content_changed");
    expect(payload.source.kind).toBe("user");
    expect(payload.target.kind).toBe("draft_field");
    expect(payload.target.draftId).toBe(next.id);
    expect(payload.target.version).toBe(2);
    expect(payload.target.field).toBe("caption");
    expect(payload.from).toBe("First caption");
    expect(payload.to).toBe("Second caption");
    expect(events[0].userId).toBe(userId);
  });

  it("emits zero events when the new value equals the old (no-op edit)", async () => {
    const item = await createTestProductionItem({});
    await seedInitialDraft(item.id, { caption: "Same value" });
    const userId = await getTestUserId();

    await applyDraftPatch({
      itemId: item.id,
      validatedPatch: { caption: "Same value" },
      actorUserId: userId,
    });

    const events = await db
      .select()
      .from(contentEvents)
      .where(
        and(
          eq(contentEvents.contentItemId, item.id),
          eq(contentEvents.eventType, "content_changed"),
        ),
      );
    expect(events).toHaveLength(0);
  });

  it("serializes concurrent autosaves instead of colliding on uq_content_drafts_current", async () => {
    // Regression for HUBANDSPOKE-15/19/1V/1S: the editor autosave fired two
    // overlapping PUTs against the same current draft. Both read the same
    // current row, both demoted it, and both inserted a second is_current=true
    // row → duplicate-key violation. The per-item advisory lock must make them
    // chain (v1→v2→v3) with exactly one current row surviving.
    const item = await createTestProductionItem({});
    await seedInitialDraft(item.id, { caption: "v1" });
    const userId = await getTestUserId();

    // Fire both at once — with a pool of >1 connection these genuinely race.
    const results = await Promise.all([
      applyDraftPatch({
        itemId: item.id,
        validatedPatch: { caption: "edit-A" },
        actorUserId: userId,
      }),
      applyDraftPatch({
        itemId: item.id,
        validatedPatch: { caption: "edit-B" },
        actorUserId: userId,
      }),
    ]);

    // Neither call threw (the whole point) and both produced a row.
    expect(results.filter(Boolean)).toHaveLength(2);

    const drafts = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.productionItemId, item.id))
      .orderBy(contentDrafts.version);

    // Three rows total, distinct sequential versions, exactly one current.
    expect(drafts).toHaveLength(3);
    expect(drafts.map((d) => d.version)).toEqual([1, 2, 3]);
    expect(drafts.filter((d) => d.isCurrent)).toHaveLength(1);
    expect(drafts[2].isCurrent).toBe(true);
    // The winner's edit is the surviving current content (whichever ran last).
    expect((drafts[2].content as { caption: string }).caption).toMatch(
      /^edit-[AB]$/,
    );
  });
});
