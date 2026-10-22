import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { createTestFormat, createTestProductionItem } from "@/test/factories";
import { editionsToCheck, syncNewsletterSendState, type SendState, type SendSyncDeps } from "./send-state";

const drafts: string[] = [];
afterEach(async () => {
  if (drafts.length) await db.delete(newsletterDrafts).where(inArray(newsletterDrafts.id, drafts.splice(0)));
});

const NOW = new Date("2026-10-25T14:00:00Z");

async function edition(status: string, ids: { hubspotEmailId?: string; beehiivPostId?: string } = { hubspotEmailId: "123" }, sendDate = "2026-10-25") {
  const fmt = await createTestFormat({ brand: "vitest-send" });
  const item = await createTestProductionItem({ postType: "newsletter", status });
  const [d] = await db
    .insert(newsletterDrafts)
    .values({ brand: "vitest-send", formatId: fmt.id, windowStart: NOW, windowEnd: NOW, productionItemId: item.id, status: "ready", sendDate, ...ids })
    .returning({ id: newsletterDrafts.id });
  drafts.push(d.id);
  return { draftId: d.id, itemId: item.id };
}
const itemOf = async (id: string) => (await db.select().from(productionItems).where(eq(productionItems.id, id)))[0];

function deps(state: SendState | null) {
  const scheduled: { id: string; at: Date }[] = [];
  const d: SendSyncDeps = { fetchState: async () => state, scheduleCheck: async (id, at) => void scheduled.push({ id, at }), now: () => NOW };
  return { d, scheduled };
}

describe("syncNewsletterSendState", () => {
  it("scheduled in the email tool → Scheduled, with the send time, and ONE check queued 10 minutes after it", async () => {
    const e = await edition("Ready To Publish");
    const sendAt = new Date("2026-10-25T16:00:00Z");
    const { d, scheduled } = deps({ phase: "scheduled", sendAt, link: null });
    expect(await syncNewsletterSendState(e.draftId, d)).toBe("scheduled");
    const item = await itemOf(e.itemId);
    expect(item.status).toBe("Scheduled");
    expect(item.expectedPublishAt?.toISOString()).toBe(sendAt.toISOString());
    expect(scheduled).toEqual([{ id: e.draftId, at: new Date("2026-10-25T16:10:00Z") }]);
  });

  it("sent → Published with the send time as publishedAt, its Eastern date, a link, and a status_change event", async () => {
    const e = await edition("Scheduled", { beehiivPostId: "post_1" });
    const sendAt = new Date("2026-10-25T12:00:00Z");
    const { d, scheduled } = deps({ phase: "sent", sendAt, link: "https://x.beehiiv.com/p/a" });
    expect(await syncNewsletterSendState(e.draftId, d)).toBe("published");
    const item = await itemOf(e.itemId);
    expect(item).toMatchObject({ status: "Published", publishedLink: "https://x.beehiiv.com/p/a", publishedDate: "2026-10-25" });
    expect(item.publishedAt?.toISOString()).toBe(sendAt.toISOString());
    expect(scheduled).toEqual([]);
    const events = await db.select().from(contentEvents).where(eq(contentEvents.contentItemId, e.itemId));
    expect(events.map((x) => x.payload)).toContainEqual({ type: "status_change", from: "Scheduled", to: "Published" });
  });

  it("sent before we ever saw it scheduled (sent right away) still goes Ready To Publish → Published", async () => {
    const e = await edition("Ready To Publish");
    const { d } = deps({ phase: "sent", sendAt: new Date("2026-10-25T13:00:00Z"), link: null });
    await syncNewsletterSendState(e.draftId, d);
    const item = await itemOf(e.itemId);
    expect(item.status).toBe("Published");
    expect(item.publishedLink).toContain("/email/"); // HubSpot editor link when there's no public page
  });

  it("unscheduled back to a draft → Ready To Publish; still-a-draft and hand-set stages are left alone", async () => {
    const e = await edition("Scheduled");
    expect(await syncNewsletterSendState(e.draftId, deps({ phase: "draft", sendAt: null, link: null }).d)).toBe("unscheduled");
    expect((await itemOf(e.itemId)).status).toBe("Ready To Publish");
    expect(await syncNewsletterSendState(e.draftId, deps({ phase: "draft", sendAt: null, link: null }).d)).toBe("waiting");
    const held = await edition("On Hold");
    expect(await syncNewsletterSendState(held.draftId, deps({ phase: "sent", sendAt: NOW, link: null }).d)).toBe("none");
    expect((await itemOf(held.itemId)).status).toBe("On Hold");
  });

  it("due but not out yet (mid-send): stays Scheduled and tries again in 10 minutes; gives up on the delayed check after 3 hours", async () => {
    const e = await edition("Scheduled");
    // Sent at 13:55, looked at 14:00: the check is due 14:05 (10 minutes after the send time).
    const first = deps({ phase: "sending", sendAt: new Date("2026-10-25T13:55:00Z"), link: null });
    expect(await syncNewsletterSendState(e.draftId, first.d)).toBe("waiting");
    expect(first.scheduled).toEqual([{ id: e.draftId, at: new Date("2026-10-25T14:05:00Z") }]);
    // Sent at 13:40, so the 10-minute mark already passed and it still isn't out: look again in 10 minutes.
    const slow = deps({ phase: "sending", sendAt: new Date("2026-10-25T13:40:00Z"), link: null });
    await syncNewsletterSendState(e.draftId, slow.d);
    expect(slow.scheduled).toEqual([{ id: e.draftId, at: new Date("2026-10-25T14:10:00Z") }]);
    const late = deps({ phase: "scheduled", sendAt: new Date("2026-10-25T09:00:00Z"), link: null });
    await syncNewsletterSendState(e.draftId, late.d);
    expect(late.scheduled).toEqual([]);
  });
});

describe("editionsToCheck", () => {
  it("picks pushed editions near their send date, and scheduled ones once their check time has passed — not the rest", async () => {
    const near = await edition("Ready To Publish", { hubspotEmailId: "1" }, "2026-10-27");
    const far = await edition("Ready To Publish", { hubspotEmailId: "2" }, "2026-12-30");
    const noEmail = await edition("Ready To Publish", {}, "2026-10-27");
    const due = await edition("Scheduled", { hubspotEmailId: "3" });
    await db.update(productionItems).set({ expectedPublishAt: new Date("2026-10-25T13:00:00Z") }).where(eq(productionItems.id, due.itemId));
    const notDue = await edition("Scheduled", { hubspotEmailId: "4" });
    await db.update(productionItems).set({ expectedPublishAt: new Date("2026-10-25T13:55:00Z") }).where(eq(productionItems.id, notDue.itemId));
    const ids = await editionsToCheck(NOW);
    expect(ids).toContain(near.draftId);
    expect(ids).toContain(due.draftId);
    for (const e of [far, noEmail, notDue]) expect(ids).not.toContain(e.draftId);
  });
});
