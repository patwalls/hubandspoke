import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents } from "@/lib/db/schema";
import { createTestProductionItem } from "@/test/factories";
import { recordContentChanges } from "./content-revisions";

// recordContentChanges is the single writer of `content_changed` events.
// The atomicity (passing a tx through) is exercised at every caller's own
// integration test; this file pins the helper's own contract: no-op
// dropping, truncation, multi-row batching, the user_id pass-through.

describe("recordContentChanges", () => {
  it("inserts one event per real change", async () => {
    const item = await createTestProductionItem({});
    await recordContentChanges({
      tx: db,
      contentItemId: item.id,
      userId: null,
      source: { kind: "user" },
      changes: [
        {
          target: { kind: "production_item_field", field: "title" },
          from: "Old title",
          to: "New title",
        },
        {
          target: { kind: "production_item_field", field: "hook" },
          from: null,
          to: "Hook copy",
        },
      ],
    });
    const rows = await fetchEvents(item.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.payload as { target: { field: string } }).target.field)).toEqual(
      expect.arrayContaining(["title", "hook"]),
    );
  });

  it("drops no-op changes where from === to", async () => {
    const item = await createTestProductionItem({});
    await recordContentChanges({
      tx: db,
      contentItemId: item.id,
      userId: null,
      source: { kind: "user" },
      changes: [
        {
          target: { kind: "production_item_field", field: "title" },
          from: "same",
          to: "same",
        },
        {
          target: { kind: "production_item_field", field: "hook" },
          from: "",
          to: null,
        },
      ],
    });
    const rows = await fetchEvents(item.id);
    expect(rows).toHaveLength(0);
  });

  it("inserts media events even when from/to are omitted", async () => {
    const item = await createTestProductionItem({});
    await recordContentChanges({
      tx: db,
      contentItemId: item.id,
      userId: null,
      source: { kind: "tool", tool: "canva" },
      changes: [
        {
          target: {
            kind: "media_added",
            mediaId: "00000000-0000-0000-0000-000000000001",
            index: 0,
            mediaKind: "image",
            s3Key: "foo/bar.png",
            posterS3Key: null,
          },
        },
      ],
    });
    const rows = await fetchEvents(item.id);
    expect(rows).toHaveLength(1);
    const p = rows[0].payload as {
      source: { kind: string; tool?: string };
      target: { kind: string };
    };
    expect(p.target.kind).toBe("media_added");
    expect(p.source.kind).toBe("tool");
    expect(p.source.tool).toBe("canva");
  });

  it("truncates strings longer than 2000 chars and sets truncated:true", async () => {
    const item = await createTestProductionItem({});
    const longText = "x".repeat(2500);
    await recordContentChanges({
      tx: db,
      contentItemId: item.id,
      userId: null,
      source: { kind: "user" },
      changes: [
        {
          target: { kind: "production_item_field", field: "description" },
          from: null,
          to: longText,
        },
      ],
    });
    const rows = await fetchEvents(item.id);
    expect(rows).toHaveLength(1);
    const p = rows[0].payload as { to: string; truncated?: boolean };
    expect(p.truncated).toBe(true);
    expect(p.to.length).toBe(2000); // 1999 chars + the "…" replacement
    expect(p.to.endsWith("…")).toBe(true);
  });

  it("stores null userId for system writes", async () => {
    const item = await createTestProductionItem({});
    await recordContentChanges({
      tx: db,
      contentItemId: item.id,
      userId: null,
      source: { kind: "algorithm", name: "draft-algorithm" },
      changes: [
        {
          target: { kind: "production_item_field", field: "title" },
          from: "a",
          to: "b",
        },
      ],
    });
    const rows = await fetchEvents(item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    const p = rows[0].payload as {
      source: { kind: string; name?: string };
    };
    expect(p.source.kind).toBe("algorithm");
    expect(p.source.name).toBe("draft-algorithm");
  });

  it("does nothing when changes array is empty", async () => {
    const item = await createTestProductionItem({});
    await recordContentChanges({
      tx: db,
      contentItemId: item.id,
      userId: null,
      source: { kind: "user" },
      changes: [],
    });
    const rows = await fetchEvents(item.id);
    expect(rows).toHaveLength(0);
  });
});

async function fetchEvents(contentItemId: string) {
  return db
    .select()
    .from(contentEvents)
    .where(
      and(
        eq(contentEvents.contentItemId, contentItemId),
        eq(contentEvents.eventType, "content_changed"),
      ),
    );
}
