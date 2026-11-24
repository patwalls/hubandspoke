import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, contentEvents } from "@/lib/db/schema";
import { clipIdeas, createTestClipEdit, createTestClipIdea, createTestProductionItem, productionItems } from "@/test/factories";
import {
  AUTO_CLOSE_REASON,
  autoCloseUntouchedIdeas,
  latestAutoClose,
  undoAutoClose,
} from "./idea-auto-close";

const DAY = 24 * 60 * 60 * 1000;
const brand = "starter-story";

async function clipIdeaRow(format: string, ageDays: number) {
  const pillar = await createTestProductionItem({ brand, status: "Published", format: `${format}-pillar` });
  const item = await createTestProductionItem({
    brand,
    status: "Idea",
    format,
    sourceType: "repurposed",
    createdAt: new Date(Date.now() - ageDays * DAY),
  });
  const idea = await createTestClipIdea({ sourceProductionItemId: pillar.id });
  await db.update(productionItems).set({ sourceClipIdeaId: idea.id }).where(eq(productionItems.id, item.id));
  return { item, idea };
}

const statusOf = async (id: string) =>
  (await db.select({ s: productionItems.status }).from(productionItems).where(eq(productionItems.id, id)))[0].s;
const ideaOf = async (id: string) => (await db.select().from(clipIdeas).where(eq(clipIdeas.id, id)))[0];

describe("autoCloseUntouchedIdeas", () => {
  it("closes only clip ideas untouched for 60 days, and Undo brings them back for good", async () => {
    const format = `vitest-autoclose-${Date.now()}`;
    const stale = await clipIdeaRow(format, 90);
    const young = await clipIdeaRow(format, 40);
    const touched = await clipIdeaRow(format, 90);
    await db.insert(contentEvents).values({
      contentItemId: touched.item.id,
      eventType: "content_changed",
      payload: { type: "content_changed", fields: ["title"] } as never,
      createdAt: new Date(Date.now() - 10 * DAY),
    });
    // A bulk editor sweep isn't a touch (2026-10-23: one unassign pass hit 1,296 old ideas).
    const swept = await clipIdeaRow(format, 90);
    await db.insert(contentEvents).values({
      contentItemId: swept.item.id,
      eventType: "editor_change",
      payload: { type: "editor_change", from: "Pat Walls", to: null },
      createdAt: new Date(Date.now() - 31 * DAY),
    });
    const handMade = await createTestProductionItem({ brand, status: "Idea", format, createdAt: new Date(Date.now() - 90 * DAY) });
    const assigned = await createTestProductionItem({
      brand,
      status: "Assigned",
      format,
      sourceType: "repurposed",
      createdAt: new Date(Date.now() - 90 * DAY),
    });

    const dry = await autoCloseUntouchedIdeas({ format, dryRun: true });
    expect(dry.byBrand[brand]).toBe(2);
    expect(await statusOf(stale.item.id)).toBe("Idea");

    const result = await autoCloseUntouchedIdeas({ format });
    expect(result.byBrand).toEqual({ [brand]: 2 });
    expect(await statusOf(stale.item.id)).toBe("Killed");
    expect(await statusOf(swept.item.id)).toBe("Killed");
    for (const id of [young.item.id, touched.item.id, handMade.id]) expect(await statusOf(id)).toBe("Idea");
    expect(await statusOf(assigned.id)).toBe("Assigned");

    const [ev] = await db
      .select({ payload: contentEvents.payload })
      .from(contentEvents)
      .where(and(eq(contentEvents.contentItemId, stale.item.id), eq(contentEvents.eventType, "killed")));
    expect(ev.payload).toMatchObject({ from: "Idea", reason: AUTO_CLOSE_REASON, bulk: "auto-close", run: result.run });
    expect((await ideaOf(stale.idea.id)).status).toBe("killed");

    // Idempotent: a retry the same day finds nothing.
    expect((await autoCloseUntouchedIdeas({ format })).total).toBe(0);

    const latest = await latestAutoClose(brand);
    expect(latest?.run).toBe(result.run);
    expect(latest?.undoable).toBeGreaterThanOrEqual(1);

    expect(await undoAutoClose({ brand, run: result.run, actorUserId: null })).toBeGreaterThanOrEqual(1);
    expect(await statusOf(stale.item.id)).toBe("Idea");
    const back = await ideaOf(stale.idea.id);
    expect(back.status).toBe("suggested");
    expect(back.killReason).toBeNull();

    // The restore is a touch: next week's run leaves it alone.
    const nextWeek = await autoCloseUntouchedIdeas({ format, now: Date.now() + 7 * DAY });
    expect(nextWeek.total).toBe(0);
    expect(await statusOf(stale.item.id)).toBe("Idea");
  });

  // 2026-11-24: the clip editor autosaves to clip_edits and writes no
  // content_event, so 73 ideas with a draft an editor had been working on
  // (one at revision 21) would have closed as "nobody touched it".
  it("leaves an idea alone when its clip-editor draft was saved inside the 60 days", async () => {
    const format = `vitest-autoclose-draft-${Date.now()}`;
    const drafted = await clipIdeaRow(format, 90);
    const draft = await createTestClipEdit({ clipIdeaId: drafted.idea.id, revision: 21 });
    await db.update(clipEdits).set({ updatedAt: new Date(Date.now() - 10 * DAY) }).where(eq(clipEdits.id, draft.id));
    const abandoned = await clipIdeaRow(format, 120);
    const oldDraft = await createTestClipEdit({ clipIdeaId: abandoned.idea.id });
    await db
      .update(clipEdits)
      .set({ createdAt: new Date(Date.now() - 100 * DAY), updatedAt: new Date(Date.now() - 100 * DAY) })
      .where(eq(clipEdits.id, oldDraft.id));

    const result = await autoCloseUntouchedIdeas({ format });
    expect(result.byBrand).toEqual({ [brand]: 1 });
    expect(await statusOf(drafted.item.id)).toBe("Idea");
    expect((await ideaOf(drafted.idea.id)).status).toBe("suggested");
    expect(await statusOf(abandoned.item.id)).toBe("Killed");
  });
});
