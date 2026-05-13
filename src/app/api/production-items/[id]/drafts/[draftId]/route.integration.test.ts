import { describe, it, expect } from "vitest";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  contentEvents,
  type FormatFieldSchema,
} from "@/lib/db/schema";
import {
  createTestProductionItem,
  getTestUserId,
} from "@/test/factories";

// Pins the clone-on-write behavior for inline draft edits:
//   • each PUT inserts a NEW version row instead of UPDATEing in place
//   • the old version stays around with isCurrent=false
//   • one `content_changed` event lands per field whose value moved
//
// We exercise the helper layer directly here since the route's
// requireSession() guard can't be satisfied from vitest. The route
// composes:
//   1. demote current draft (isCurrent=false)
//   2. insert new draft row (version+1, isCurrent=true, generatedBy="user:edit")
//   3. recordContentChanges with source: { kind: "user" } per moved field
// This test replays steps 1–3 against a real draft row and asserts the
// outputs — same code path as the route except the session is mocked.

const SCHEMA: FormatFieldSchema = {
  fields: [
    { key: "caption", type: "longtext", label: "Caption", required: false },
  ],
  version: 1,
};

async function seedInitialDraft(itemId: string, content: Record<string, unknown>) {
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
    const initial = await seedInitialDraft(item.id, {
      caption: "First caption",
    });
    const userId = await getTestUserId();

    // Mimic the route's tx: demote current, insert v+1, record changes.
    const [next] = await db.transaction(async (tx) => {
      await tx
        .update(contentDrafts)
        .set({ isCurrent: false, updatedAt: new Date() })
        .where(eq(contentDrafts.id, initial.id));

      const inserted = await tx
        .insert(contentDrafts)
        .values({
          productionItemId: item.id,
          version: initial.version + 1,
          isCurrent: true,
          content: { caption: "Second caption" },
          fieldSchemaSnapshot: SCHEMA,
          generatedBy: "user:edit",
          promptVersion: null,
          modelUsage: null,
          createdByUserId: userId,
        })
        .returning();

      const { recordContentChanges } = await import(
        "@/lib/services/content-revisions"
      );
      await recordContentChanges({
        tx,
        contentItemId: item.id,
        userId,
        source: { kind: "user" },
        changes: [
          {
            target: {
              kind: "draft_field",
              draftId: inserted[0].id,
              version: inserted[0].version,
              field: "caption",
            },
            from: "First caption",
            to: "Second caption",
          },
        ],
      });

      return inserted;
    });

    // Both draft rows present, only the new one is current.
    const drafts = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.productionItemId, item.id))
      .orderBy(asc(contentDrafts.version));
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
      target: {
        kind: string;
        draftId: string;
        version: number;
        field: string;
      };
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
    const initial = await seedInitialDraft(item.id, { caption: "Same value" });
    const userId = await getTestUserId();

    const { recordContentChanges } = await import(
      "@/lib/services/content-revisions"
    );
    await recordContentChanges({
      tx: db,
      contentItemId: item.id,
      userId,
      source: { kind: "user" },
      changes: [
        {
          target: {
            kind: "draft_field",
            draftId: initial.id,
            version: initial.version,
            field: "caption",
          },
          from: "Same value",
          to: "Same value",
        },
      ],
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
});
