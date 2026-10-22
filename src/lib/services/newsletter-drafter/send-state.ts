// A pushed newsletter's life after the unsent draft lands in the email tool:
// Ready To Publish → Scheduled (someone schedules it there) → Published (it
// went out). We only READ the email's state (HubSpot: state + publishDate;
// beehiiv: status + publish_date), never its numbers, and only when it can
// matter: while it waits to be scheduled (cheap hourly look at the few
// drafts near their send date) and once, ~10 minutes after its scheduled send
// time (a delayed job per edition; the hourly sweep is the safety net).
//
// Queue statuses it sets: Scheduled (expectedPublishAt = the send time),
// back to Ready To Publish if unscheduled, Published (publishedAt = send
// time, publishedDate = its Eastern date, publishedLink = the post's page —
// beehiiv — or the email's HubSpot editor link) so the edition shows in the
// Content tab like any other post. No velocity snapshots: nothing to count.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { getFuturepediaPost } from "@/lib/beehiiv";
import { emailEditUrl, getHubspotEmail } from "@/lib/hubspot-marketing-email";
import { easternDate } from "./slots";

/** How long after the scheduled send time we look once. */
export const SEND_CHECK_DELAY_MS = 10 * 60_000;
/** Past this long after the send time with no sign of it going out, stop re-checking (the hourly sweep still looks for 2 days). */
const GIVE_UP_AFTER_MS = 3 * 3600_000;

export type SendPhase = "draft" | "scheduled" | "sending" | "sent" | "unknown";
export interface SendState {
  phase: SendPhase;
  sendAt: Date | null;
  link: string | null;
}

const date = (v: unknown): Date | null => {
  const d = typeof v === "string" ? new Date(v) : typeof v === "number" ? new Date(v * 1000) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** HubSpot marketing email → send phase. `publishDate` is only meaningful once scheduled/sent (a draft can carry a stale one). Pure. */
export function classifyHubspot(email: { state?: unknown; publishDate?: unknown }, now: Date = new Date()): SendState {
  const state = String(email.state ?? "").toUpperCase();
  const sendAt = date(email.publishDate);
  if (state === "DRAFT" || state === "AUTOMATED_DRAFT") return { phase: "draft", sendAt: null, link: null };
  if (state.startsWith("SCHEDULED")) return { phase: "scheduled", sendAt, link: null };
  if (state === "PROCESSING") return { phase: "sending", sendAt, link: null };
  if (state === "PUBLISHED_OR_SCHEDULED") return { phase: sendAt && sendAt > now ? "scheduled" : "sent", sendAt, link: null };
  if (state.startsWith("PUBLISHED")) return { phase: "sent", sendAt, link: null };
  return { phase: "unknown", sendAt: null, link: null };
}

/** beehiiv post → send phase: `confirmed` with a future `publish_date` is scheduled, with a past one it went out. Pure. */
export function classifyBeehiiv(post: { status?: unknown; publish_date?: unknown; web_url?: unknown }, now: Date = new Date()): SendState {
  const status = String(post.status ?? "").toLowerCase();
  const sendAt = typeof post.publish_date === "number" ? date(post.publish_date) : null;
  const link = typeof post.web_url === "string" && post.web_url ? post.web_url : null;
  if (status === "draft") return { phase: "draft", sendAt: null, link: null };
  if (status !== "confirmed" || !sendAt) return { phase: "unknown", sendAt: null, link: null };
  return { phase: sendAt > now ? "scheduled" : "sent", sendAt, link };
}

export interface SendSyncDeps {
  fetchState: (d: { hubspotEmailId: string | null; beehiivPostId: string | null }) => Promise<SendState | null>;
  /** Run the one-time check for this edition at `at` (replaces any earlier one). */
  scheduleCheck: (draftId: string, at: Date) => Promise<void>;
  now: () => Date;
}

const defaultDeps: SendSyncDeps = {
  async fetchState(d) {
    if (d.beehiivPostId) return classifyBeehiiv((await getFuturepediaPost(d.beehiivPostId)) as never);
    if (d.hubspotEmailId) return classifyHubspot((await getHubspotEmail(d.hubspotEmailId)) as { state?: unknown; publishDate?: unknown });
    return null;
  },
  async scheduleCheck(draftId, at) {
    await enqueue("newsletter-send-check", { newsletterDraftId: draftId }, { jobKey: `newsletter-send-check:${draftId}`, jobKeyMode: "replace", runAt: at, maxAttempts: 2 });
  },
  now: () => new Date(),
};

export type SendSyncResult = "scheduled" | "unscheduled" | "published" | "waiting" | "none";

/**
 * Read the edition's email state and move its queue item to match. Idempotent;
 * safe to call from the sweep and from the delayed check.
 */
export async function syncNewsletterSendState(draftId: string, deps: SendSyncDeps = defaultDeps): Promise<SendSyncResult> {
  const [d] = await db
    .select({
      itemId: newsletterDrafts.productionItemId,
      hubspotEmailId: newsletterDrafts.hubspotEmailId,
      beehiivPostId: newsletterDrafts.beehiivPostId,
      status: productionItems.status,
      expectedPublishAt: productionItems.expectedPublishAt,
    })
    .from(newsletterDrafts)
    .innerJoin(productionItems, eq(productionItems.id, newsletterDrafts.productionItemId))
    .where(eq(newsletterDrafts.id, draftId))
    .limit(1);
  if (!d || (!d.hubspotEmailId && !d.beehiivPostId)) return "none";
  // Only editions that are in this pipeline; never touch one set by hand to On Hold / Killed / a custom stage.
  if (d.status !== "Ready To Publish" && d.status !== "Scheduled") return "none";

  const now = deps.now();
  const state = await deps.fetchState({ hubspotEmailId: d.hubspotEmailId, beehiivPostId: d.beehiivPostId });
  if (!state) return "none";

  const move = async (to: string, set: Partial<typeof productionItems.$inferInsert>) => {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(productionItems)
        .set({ status: to, updatedAt: now, ...set })
        .where(and(eq(productionItems.id, d.itemId!), inArray(productionItems.status, ["Ready To Publish", "Scheduled"])))
        .returning({ id: productionItems.id });
      if (moved.length && d.status !== to) {
        await tx.insert(contentEvents).values({ contentItemId: d.itemId!, userId: null, eventType: "status_change", payload: { type: "status_change", from: d.status, to } });
      }
    });
  };

  if (state.phase === "sent") {
    await move("Published", {
      publishedAt: state.sendAt ?? now,
      publishedDate: easternDate(state.sendAt ?? now),
      publishedLink: state.link ?? (d.hubspotEmailId ? emailEditUrl(d.hubspotEmailId) : null),
      scheduleNeedsAttentionAt: null,
    });
    return "published";
  }

  if ((state.phase === "scheduled" || state.phase === "sending") && state.sendAt) {
    const dueAt = new Date(state.sendAt.getTime() + SEND_CHECK_DELAY_MS);
    const overdue = now.getTime() - state.sendAt.getTime();
    // One look ~10 minutes after the send time; if it's later than that and still not out, try again in 10 minutes for a few hours.
    if (overdue < GIVE_UP_AFTER_MS) await deps.scheduleCheck(draftId, dueAt > now ? dueAt : new Date(now.getTime() + SEND_CHECK_DELAY_MS));
    if (d.status === "Ready To Publish") {
      await move("Scheduled", { scheduledAt: now, expectedPublishAt: state.sendAt, scheduledNoDate: false });
      return "scheduled";
    }
    if (d.expectedPublishAt?.getTime() !== state.sendAt.getTime()) await db.update(productionItems).set({ expectedPublishAt: state.sendAt, updatedAt: now }).where(eq(productionItems.id, d.itemId!));
    return "waiting";
  }

  if (state.phase === "draft" && d.status === "Scheduled") {
    await move("Ready To Publish", { expectedPublishAt: null, scheduledAt: null });
    return "unscheduled";
  }
  return "waiting";
}

/** Editions worth looking at now: waiting to be scheduled near their send date, or scheduled and past their check time. */
export async function editionsToCheck(now: Date = new Date()): Promise<string[]> {
  const plus = (days: number) => easternDate(new Date(now.getTime() + days * 86400_000));
  const rows = await db
    .select({
      id: newsletterDrafts.id,
      sendDate: newsletterDrafts.sendDate,
      status: productionItems.status,
      expectedPublishAt: productionItems.expectedPublishAt,
      hubspotEmailId: newsletterDrafts.hubspotEmailId,
      beehiivPostId: newsletterDrafts.beehiivPostId,
    })
    .from(newsletterDrafts)
    .innerJoin(productionItems, eq(productionItems.id, newsletterDrafts.productionItemId))
    .where(and(eq(newsletterDrafts.status, "ready"), inArray(productionItems.status, ["Ready To Publish", "Scheduled"])));
  const from = plus(-3);
  const to = plus(14);
  const dueFloor = now.getTime() - 2 * 86400_000;
  return rows
    .filter((r) => r.hubspotEmailId || r.beehiivPostId)
    .filter((r) => {
      if (r.status === "Scheduled") {
        const t = r.expectedPublishAt?.getTime();
        return !!t && t + SEND_CHECK_DELAY_MS <= now.getTime() && t > dueFloor; // due, and the delayed check hasn't landed it
      }
      return !r.sendDate || (r.sendDate >= from && r.sendDate <= to);
    })
    .map((r) => r.id);
}
