// Scheduled newsletter SLOTS: one `newsletter_drafts` row (status "idea") per
// schedule group per upcoming send date, created 2 weeks ahead so the
// Newsletters tab works like a queue. Sunday Breakfast = Sundays, Daily
// Seinfeld = Tue/Thu, the Futurepedia How-To = Tuesdays (format-config.ts).
//
// How-To slots also get a SUGGESTED source video: the newest long-form video
// with a transcript, from any channel in the group (Futurepedia or Skill
// Leap), published in the 3 weeks before the send date and not already used
// by another slot. The slot sits on the format matching that video's channel
// (Kevin's Futurepedia format or Saj's Skill Leap format), so voice + template
// follow the video. Matches what the team actually shipped: one Tuesday
// How-To from the latest video of either channel.
//
// Idempotent: rows are keyed by slot_key "<group>:<YYYY-MM-DD>" (unique), so
// the daily sweep and every page load can call ensureSlots safely.

import { and, desc, eq, gte, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, formats, newsletterDrafts, productionItems, transcripts } from "@/lib/db/schema";
import { formatConfigFor, groupFormatNames, scheduledPrimaries, upcomingSendDates } from "./format-config";
import { findSpecial } from "./promo";

export const SLOT_HORIZON_DAYS = 14;
/** How far back a How-To slot looks for its suggested video. */
const SUGGEST_LOOKBACK_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

export function slotKeyFor(group: string, sendDate: string): string {
  return `${group}:${sendDate}`;
}

/** A roundup slot's window: the 7 days before its send date. Pure; exported for tests. */
export function slotWindow(sendDate: string): { start: Date; end: Date } {
  const end = new Date(`${sendDate}T00:00:00Z`);
  return { start: new Date(end.getTime() - 7 * DAY_MS), end };
}

interface GroupFormat {
  id: string;
  name: string;
  brand: string;
  accountId: string | null;
}

/** Every format row in a schedule group, with its source channel's account id. */
async function loadGroupFormats(group: string): Promise<GroupFormat[]> {
  const names = groupFormatNames(group);
  if (names.length === 0) return [];
  const rows = await db
    .select({ id: formats.id, name: formats.name, brand: formats.brand })
    .from(formats)
    .where(inArray(sql`lower(${formats.name})`, names));
  const out: GroupFormat[] = [];
  for (const r of rows) {
    const handle = formatConfigFor(r.name).sourceAccountHandle;
    let accountId: string | null = null;
    if (handle) {
      const [a] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.platform, "youtube"), sql`lower(${accounts.handle}) = lower(${handle})`))
        .limit(1);
      accountId = a?.id ?? null;
    }
    out.push({ ...r, accountId });
  }
  return out;
}

/**
 * Videos a group's slots have committed to (drafted, or hand-picked) — never
 * suggested again. Undrafted, un-pinned suggestions don't count: the sweep
 * re-deals those every run, earliest send date first.
 */
async function committedVideoIds(group: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: newsletterDrafts.sourceItemId })
    .from(newsletterDrafts)
    .where(
      and(
        like(newsletterDrafts.slotKey, `${group}:%`),
        isNotNull(newsletterDrafts.sourceItemId),
        sql`(${newsletterDrafts.status} <> 'idea' OR ${newsletterDrafts.sourcePinned})`,
      ),
    );
  return new Set(rows.map((r) => r.id!).filter(Boolean));
}

/** The newest unused long-form video with a transcript from the group's channels, before `sendDate`. */
async function suggestVideo(
  groupFormats: GroupFormat[],
  sendDate: string,
  used: Set<string>,
): Promise<{ itemId: string; formatId: string } | null> {
  const byAccount = new Map(groupFormats.filter((f) => f.accountId).map((f) => [f.accountId!, f.id]));
  if (byAccount.size === 0) return null;
  const end = new Date(`${sendDate}T00:00:00Z`);
  const start = new Date(end.getTime() - SUGGEST_LOOKBACK_DAYS * DAY_MS);
  const published = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  const rows = await db
    .select({ id: productionItems.id, accountId: productionItems.accountId })
    .from(productionItems)
    .innerJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
    .where(
      and(
        inArray(productionItems.accountId, [...byAccount.keys()]),
        eq(productionItems.postType, "youtube_long"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${published} >= ${start.toISOString()}::timestamptz`,
        sql`${published} < ${end.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(published))
    .limit(20);
  const pick = rows.find((r) => !used.has(r.id));
  return pick?.accountId ? { itemId: pick.id, formatId: byAccount.get(pick.accountId)! } : null;
}

/** Create any missing slots for the next SLOT_HORIZON_DAYS, and suggest videos for How-To slots without one. */
export async function ensureSlots(now: Date = new Date()): Promise<{ created: number; suggested: number }> {
  let created = 0;
  let suggested = 0;
  for (const { formatName, schedule } of scheduledPrimaries()) {
    const groupFormats = await loadGroupFormats(schedule.group);
    const primary = groupFormats.find((f) => f.name.trim().toLowerCase() === formatName);
    if (!primary) continue; // the format doesn't exist in this DB
    const singleVideo = formatConfigFor(primary.name).kind === "single_video";
    const used = singleVideo ? await committedVideoIds(schedule.group) : new Set<string>();

    for (const sendDate of upcomingSendDates(schedule.days, SLOT_HORIZON_DAYS, now)) {
      const slotKey = slotKeyFor(schedule.group, sendDate);
      const pick = singleVideo ? await suggestVideo(groupFormats, sendDate, used) : null;
      const w = slotWindow(sendDate);
      const inserted = await db
        .insert(newsletterDrafts)
        .values({
          brand: primary.brand,
          formatId: pick?.formatId ?? primary.id,
          status: "idea",
          slotKey,
          sendDate,
          windowStart: w.start,
          windowEnd: w.end,
          sourceItemId: pick?.itemId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: newsletterDrafts.id });
      if (inserted.length) {
        created++;
        if (pick) used.add(pick.itemId);
        continue;
      }
      // Existing slot: while it's an undrafted, un-pinned idea, keep its
      // suggestion current (a newer video may have landed since yesterday).
      if (singleVideo) {
        const [existing] = await db
          .select({ id: newsletterDrafts.id, status: newsletterDrafts.status, pinned: newsletterDrafts.sourcePinned, sourceItemId: newsletterDrafts.sourceItemId })
          .from(newsletterDrafts)
          .where(eq(newsletterDrafts.slotKey, slotKey))
          .limit(1);
        if (!existing || existing.status !== "idea" || existing.pinned) {
          if (existing?.sourceItemId) used.add(existing.sourceItemId);
          continue;
        }
        if (pick && pick.itemId !== existing.sourceItemId) {
          await db
            .update(newsletterDrafts)
            .set({ sourceItemId: pick.itemId, formatId: pick.formatId, updatedAt: new Date() })
            .where(eq(newsletterDrafts.id, existing.id));
          suggested++;
        }
        if (pick) used.add(pick.itemId);
      }
    }
  }
  return { created, suggested };
}

/** Re-check the Asana promo for every upcoming idea slot, so cards show sponsor status ahead of drafting. */
export async function refreshSlotSponsors(now: Date = new Date()): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const rows = await db
    .select({ id: newsletterDrafts.id, sendDate: newsletterDrafts.sendDate, formatName: formats.name })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(and(eq(newsletterDrafts.status, "idea"), isNotNull(newsletterDrafts.slotKey), gte(newsletterDrafts.sendDate, today)));
  let updated = 0;
  for (const r of rows) {
    const special = await findSpecial(r.formatName, r.sendDate);
    if (!special) continue;
    await db
      .update(newsletterDrafts)
      .set(
        special.ok
          ? {
              specialCopy: special.copy,
              specialOriginal: special.copy,
              specialMode: "verbatim",
              specialSource: special.source,
              specialError: null,
              updatedAt: new Date(),
            }
          : { specialCopy: null, specialOriginal: null, specialMode: null, specialSource: null, specialError: special.error, updatedAt: new Date() },
      )
      .where(eq(newsletterDrafts.id, r.id));
    updated++;
  }
  return updated;
}

export interface SlotVideoOption {
  id: string;
  title: string | null;
  url: string | null;
  publishedAt: string | null;
  channel: string;
  formatId: string;
  usedBySlot: string | null;
}

/** Videos a How-To slot can switch to: both channels, last 6 weeks, with a transcript. */
export async function listSlotVideoOptions(draftId: string): Promise<SlotVideoOption[] | null> {
  const [row] = await db
    .select({ formatName: formats.name, slotKey: newsletterDrafts.slotKey })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, draftId))
    .limit(1);
  if (!row) return null;
  const group = formatConfigFor(row.formatName).schedule?.group;
  if (!group) return [];
  const groupFormats = await loadGroupFormats(group);
  const byAccount = new Map(groupFormats.filter((f) => f.accountId).map((f) => [f.accountId!, f]));
  if (byAccount.size === 0) return [];
  const published = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      publishedAt: sql<string | null>`${published}`,
      accountId: productionItems.accountId,
    })
    .from(productionItems)
    .innerJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
    .where(
      and(
        inArray(productionItems.accountId, [...byAccount.keys()]),
        eq(productionItems.postType, "youtube_long"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${published} > now() - interval '42 days'`,
      ),
    )
    .orderBy(desc(published))
    .limit(40);
  const used = await db
    .select({ id: newsletterDrafts.sourceItemId, slotKey: newsletterDrafts.slotKey })
    .from(newsletterDrafts)
    .where(and(like(newsletterDrafts.slotKey, `${group}:%`), isNotNull(newsletterDrafts.sourceItemId)));
  const usedBy = new Map(used.map((u) => [u.id!, u.slotKey]));
  return rows.map((r) => {
    const f = byAccount.get(r.accountId!)!;
    return {
      id: r.id,
      title: r.title,
      url: r.publishedLink ?? r.youtubeUrl,
      publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
      channel: formatConfigFor(f.name).sourceAccountHandle ?? f.name,
      formatId: f.id,
      usedBySlot: usedBy.get(r.id) && usedBy.get(r.id) !== row.slotKey ? usedBy.get(r.id)! : null,
    };
  });
}

/** Point a How-To slot at another video; the slot moves to that video's channel's format. */
export async function setSlotVideo(draftId: string, itemId: string): Promise<{ ok: true } | { error: string }> {
  const options = await listSlotVideoOptions(draftId);
  const pick = options?.find((o) => o.id === itemId);
  if (!pick) return { error: "That video isn't one of this newsletter's channels' recent videos" };
  const [row] = await db
    .update(newsletterDrafts)
    .set({ sourceItemId: pick.id, formatId: pick.formatId, sourcePinned: true, updatedAt: new Date() })
    .where(and(eq(newsletterDrafts.id, draftId), inArray(newsletterDrafts.status, ["idea", "failed", "ready"])))
    .returning({ id: newsletterDrafts.id });
  return row ? { ok: true } : { error: "This draft can't change video while it's drafting" };
}

/** Upcoming slots + recent ad-hoc/past drafts for the board. */
export async function listBoard(brand: string, now: Date = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const sourceTitle = sql<string | null>`(SELECT ${productionItems.title} FROM ${productionItems} WHERE ${productionItems.id} = ${newsletterDrafts.sourceItemId})`;
  const cols = {
    id: newsletterDrafts.id,
    status: newsletterDrafts.status,
    slotKey: newsletterDrafts.slotKey,
    sendDate: newsletterDrafts.sendDate,
    subject: newsletterDrafts.subject,
    formatId: newsletterDrafts.formatId,
    formatName: formats.name,
    sourceItemId: newsletterDrafts.sourceItemId,
    sourceTitle,
    specialSource: newsletterDrafts.specialSource,
    specialError: newsletterDrafts.specialError,
    hubspotStatus: newsletterDrafts.hubspotStatus,
    updatedAt: newsletterDrafts.updatedAt,
  };
  const upcoming = await db
    .select(cols)
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(and(eq(newsletterDrafts.brand, brand), isNotNull(newsletterDrafts.slotKey), gte(newsletterDrafts.sendDate, today)))
    .orderBy(newsletterDrafts.sendDate, formats.name);
  const past = await db
    .select(cols)
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(
      and(
        eq(newsletterDrafts.brand, brand),
        sql`(${newsletterDrafts.slotKey} IS NULL OR ${newsletterDrafts.sendDate} < ${today})`,
        sql`${newsletterDrafts.status} <> 'idea'`,
      ),
    )
    .orderBy(desc(newsletterDrafts.updatedAt))
    .limit(30);
  return { upcoming, past };
}

