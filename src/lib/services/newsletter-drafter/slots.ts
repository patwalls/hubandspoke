// Scheduled newsletter SLOTS: one `newsletter_drafts` row (status "idea") per
// schedule group per upcoming send date, created 2 weeks ahead so the
// Newsletters tab works like a queue. Sunday Breakfast = Sundays, Daily
// Seinfeld = Tue/Thu. The Futurepedia How-To is VIDEO-TRIGGERED instead: each
// published video queues one edition on the next open Tue/Fri (≤3 a week; see
// videoSendDate and ensureVideoEditions), and no empty slots are made ahead.
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

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, formatChannels, formats, newsletterDrafts, newsletterIssueHistory, productionItems, transcripts } from "@/lib/db/schema";
import { formatConfigFor, groupFormatNames, scheduledPrimaries, upcomingSendDates, type NewsletterSchedule } from "./format-config";
import { findSpecial } from "./promo";
import { resolveEditor } from "@/lib/services/assignees";

export const SLOT_HORIZON_DAYS = 14;
/** How far back a How-To slot looks for its suggested video. */
const SUGGEST_LOOKBACK_DAYS = 21;
/** Video-triggered groups: videos published this recently with no edition get one (covers outages; older ones aren't backfilled). */
const VIDEO_LOOKBACK_DAYS = 7;
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
  /** The format's source channels (single_video): account id + handle. */
  channels: { accountId: string; handle: string }[];
}

/** Every format row in a schedule group, with its source channels' account ids. */
async function loadGroupFormats(group: string): Promise<GroupFormat[]> {
  const names = groupFormatNames(group);
  if (names.length === 0) return [];
  const rows = await db
    .select({ id: formats.id, name: formats.name, brand: formats.brand })
    .from(formats)
    .where(inArray(sql`lower(${formats.name})`, names));
  const out: GroupFormat[] = [];
  for (const r of rows) {
    const handles = (formatConfigFor(r.name).sources ?? []).map((x) => x.handle);
    const channels: GroupFormat["channels"] = [];
    for (const handle of handles) {
      const [a] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.platform, "youtube"), sql`lower(${accounts.handle}) = lower(${handle})`))
        .limit(1);
      if (a) channels.push({ accountId: a.id, handle });
    }
    out.push({ ...r, channels });
  }
  return out;
}

/**
 * account id → the format a video from it sits on. The group's primary format
 * wins when several formats share a channel.
 */
function formatsByAccount(groupFormats: GroupFormat[]): Map<string, { formatId: string; formatName: string; handle: string }> {
  const out = new Map<string, { formatId: string; formatName: string; handle: string }>();
  const ordered = [...groupFormats].sort((a, b) => Number(!!formatConfigFor(b.name).schedule?.primary) - Number(!!formatConfigFor(a.name).schedule?.primary));
  for (const f of ordered) for (const c of f.channels) if (!out.has(c.accountId)) out.set(c.accountId, { formatId: f.id, formatName: f.name, handle: c.handle });
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

/** YYYY-MM-DD of an instant in US Eastern (sends go out 9:30am ET). */
export function easternDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const weekdayOf = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const mondayOf = (d: string) => addDays(d, -((weekdayOf(d) + 6) % 7));

/**
 * The send date for a video published (Eastern) on `publishedOn`, given the
 * dates that already have an edition. Sends start the next weekday after it
 * lands (and never before tomorrow): the first open `days` day (Tue/Fri) in
 * that week; if the week's Tue/Fri are taken, that next weekday itself as the
 * week's extra send (≤ maxPerWeek); else the next open Tue/Fri after. So a
 * Sunday and a Monday video both go Tuesday, a Wednesday video goes Friday.
 * Pure; exported for tests.
 */
export function videoSendDate(publishedOn: string, today: string, days: number[], maxPerWeek: number, taken: Set<string>): string {
  let start = addDays(publishedOn > today ? publishedOn : today, 1);
  while (weekdayOf(start) === 0 || weekdayOf(start) === 6) start = addDays(start, 1);
  const weekCount = (d: string) => {
    const m = mondayOf(d);
    let n = 0;
    for (let i = 0; i < 7; i++) if (taken.has(addDays(m, i))) n++;
    return n;
  };
  const open = (d: string) => !taken.has(d) && weekCount(d) < maxPerWeek;
  // 1) The first open Tue/Fri in the week the video lands in.
  for (let d = start; mondayOf(d) === mondayOf(start); d = addDays(d, 1)) if (days.includes(weekdayOf(d)) && open(d)) return d;
  // 2) That week's Tue/Fri are taken: the next weekday itself, as the week's extra send.
  if (open(start)) return start;
  // 3) Otherwise the next open Tue/Fri after it.
  for (let d = addDays(mondayOf(start), 7), i = 0; i < 7 * 52; d = addDays(d, 1), i++) if (days.includes(weekdayOf(d)) && open(d)) return d;
  return start;
}

/**
 * Queue one edition for every video published in the last VIDEO_LOOKBACK_DAYS
 * that has a transcript and no edition yet (here or in the beehiiv history).
 * Each is pinned to its video and sits on its channel's format (Kevin / Saj).
 */
async function ensureVideoEditions(
  schedule: NewsletterSchedule,
  groupFormats: GroupFormat[],
  primary: GroupFormat,
  now: Date,
): Promise<number> {
  const byAccount = new Map([...formatsByAccount(groupFormats)].map(([k, v]) => [k, v.formatId]));
  if (!schedule.trigger || byAccount.size === 0) return 0;
  const slotRows = await db
    .select({
      id: newsletterDrafts.id,
      sendDate: newsletterDrafts.sendDate,
      sourceItemId: newsletterDrafts.sourceItemId,
      status: newsletterDrafts.status,
      pinned: newsletterDrafts.sourcePinned,
    })
    .from(newsletterDrafts)
    .where(like(newsletterDrafts.slotKey, `${schedule.group}:%`));
  const today = easternDate(now);
  // Empty future slots from the old fixed-Tuesday schedule: nothing to send, so drop them.
  const history = await db
    .select({ sentDate: newsletterIssueHistory.sentDate, keys: newsletterIssueHistory.sourceKeys })
    .from(newsletterIssueHistory)
    .where(eq(newsletterIssueHistory.scheduleGroup, schedule.group));
  const historyVideos = new Set(history.flatMap((h) => h.keys).filter((k) => k.startsWith("video:")).map((k) => k.slice("video:".length)));
  // Drop undrafted future slots that have nothing to send: empty ones from the old fixed-Tuesday schedule, and
  // ones whose video the team already sent or is drafting in beehiiv (a hand-picked video is kept).
  const stale = slotRows
    .filter((r) => r.status === "idea" && r.sendDate && r.sendDate >= today && (!r.sourceItemId || (!r.pinned && historyVideos.has(r.sourceItemId))))
    .map((r) => r.id);
  if (stale.length) await db.delete(newsletterDrafts).where(inArray(newsletterDrafts.id, stale));
  const live = slotRows.filter((r) => !stale.includes(r.id));
  const used = new Set([...live.map((r) => r.sourceItemId!).filter(Boolean), ...historyVideos]);
  // Dates already taken: our editions, plus sends the team has (or is drafting) in beehiiv.
  const taken = new Set([
    ...live.filter((r) => r.sourceItemId && r.sendDate).map((r) => r.sendDate!),
    ...history.map((h) => h.sentDate!).filter((d) => d && d >= addDays(today, -7)),
  ]);

  const published = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  const videos = await db
    .select({ id: productionItems.id, accountId: productionItems.accountId, publishedAt: sql<string>`${published}` })
    .from(productionItems)
    .innerJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
    .where(
      and(
        inArray(productionItems.accountId, [...byAccount.keys()]),
        eq(productionItems.postType, "youtube_long"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${published} >= ${new Date(now.getTime() - VIDEO_LOOKBACK_DAYS * DAY_MS).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(published);
  let created = 0;
  for (const v of videos) {
    if (used.has(v.id) || !v.accountId) continue;
    const sendDate = videoSendDate(easternDate(v.publishedAt), today, schedule.days, schedule.trigger.maxPerWeek, taken);
    const w = slotWindow(sendDate);
    const inserted = await db
      .insert(newsletterDrafts)
      .values({
        brand: primary.brand,
        formatId: byAccount.get(v.accountId)!,
        status: "idea",
        slotKey: slotKeyFor(schedule.group, sendDate),
        sendDate,
        windowStart: w.start,
        windowEnd: w.end,
        sourceItemId: v.id,
        sourcePinned: true,
      })
      .onConflictDoNothing()
      .returning({ id: newsletterDrafts.id });
    taken.add(sendDate);
    used.add(v.id);
    if (inserted.length) created++;
  }
  return created;
}

/**
 * Queue-triggered newsletters (`trigger.kind === "queue"`): the regular queue's
 * threshold sweep creates the production item for a newly published video;
 * this says whether that video should get an edition and on which send date.
 * Skips videos the team already sent or is drafting in beehiiv, and videos
 * that already have an edition here. Read-only.
 */
export async function planVideoEdition(
  formatName: string,
  pillar: { id: string; publishedAt: Date | string | null },
  now: Date = new Date(),
): Promise<{ sendDate: string; group: string } | { skip: string }> {
  const schedule = formatConfigFor(formatName).schedule;
  if (!schedule?.trigger) return { skip: "not a video-triggered newsletter" };
  if (!pillar.publishedAt) return { skip: "no publish date" };
  if (new Date(pillar.publishedAt).getTime() < now.getTime() - VIDEO_LOOKBACK_DAYS * DAY_MS) return { skip: "published too long ago" };
  const slotRows = await db
    .select({ sendDate: newsletterDrafts.sendDate, sourceItemId: newsletterDrafts.sourceItemId })
    .from(newsletterDrafts)
    .where(like(newsletterDrafts.slotKey, `${schedule.group}:%`));
  const history = await db
    .select({ sentDate: newsletterIssueHistory.sentDate, keys: newsletterIssueHistory.sourceKeys })
    .from(newsletterIssueHistory)
    .where(eq(newsletterIssueHistory.scheduleGroup, schedule.group));
  const used = new Set([
    ...slotRows.map((r) => r.sourceItemId).filter(Boolean),
    ...history.flatMap((h) => h.keys).filter((k) => k.startsWith("video:")).map((k) => k.slice("video:".length)),
  ]);
  if (used.has(pillar.id)) return { skip: "this video already has an edition (here or in beehiiv)" };
  const today = easternDate(now);
  const taken = new Set([
    ...slotRows.filter((r) => r.sourceItemId && r.sendDate).map((r) => r.sendDate!),
    ...history.map((h) => h.sentDate!).filter((d) => d && d >= addDays(today, -7)),
  ]);
  return { sendDate: videoSendDate(easternDate(pillar.publishedAt), today, schedule.days, schedule.trigger.maxPerWeek, taken), group: schedule.group };
}

/** The edition (editor draft) for a queue item created by planVideoEdition's sweep. */
export async function insertVideoEdition(args: {
  group: string;
  sendDate: string;
  brand: string;
  formatId: string;
  pillarId: string;
  productionItemId: string;
}): Promise<boolean> {
  const w = slotWindow(args.sendDate);
  const inserted = await db
    .insert(newsletterDrafts)
    .values({
      brand: args.brand,
      formatId: args.formatId,
      status: "idea",
      slotKey: slotKeyFor(args.group, args.sendDate),
      sendDate: args.sendDate,
      windowStart: w.start,
      windowEnd: w.end,
      sourceItemId: args.pillarId,
      sourcePinned: true,
      productionItemId: args.productionItemId,
    })
    .onConflictDoNothing()
    .returning({ id: newsletterDrafts.id });
  return inserted.length > 0;
}

/** The newest unused long-form video with a transcript from the group's channels, before `sendDate`. */
async function suggestVideo(
  groupFormats: GroupFormat[],
  sendDate: string,
  used: Set<string>,
): Promise<{ itemId: string; formatId: string } | null> {
  const byAccount = new Map([...formatsByAccount(groupFormats)].map(([k, v]) => [k, v.formatId]));
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
export async function ensureSlots(now: Date = new Date()): Promise<{ created: number; suggested: number; queueItems: number }> {
  let created = 0;
  let suggested = 0;
  let queueItems = 0;
  for (const { formatName, schedule } of scheduledPrimaries()) {
    const groupFormats = await loadGroupFormats(schedule.group);
    const primary = groupFormats.find((f) => f.name.trim().toLowerCase() === formatName);
    if (!primary) continue; // the format doesn't exist in this DB
    const singleVideo = formatConfigFor(primary.name).kind === "single_video";
    // Queue-triggered newsletters are created by the regular queue's threshold sweep (planVideoEdition).
    if (schedule.trigger?.kind === "queue") continue;
    if (schedule.trigger?.kind === "video") {
      created += await ensureVideoEditions(schedule, groupFormats, primary, now);
      continue;
    }
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
    // Scheduled newsletters (Sunday Breakfast, Daily Seinfeld) live in the regular queue too.
    if (!singleVideo) queueItems += await ensureSlotQueueItems(schedule.group, primary, now);
  }
  return { created, suggested, queueItems };
}

/**
 * Each upcoming slot of a scheduled newsletter gets its queue item
 * (production_items: status Idea, format = the newsletter format, the format's
 * channel as account, no pillar — an issue covers several stories), linked
 * from the slot's `production_item_id`. Idempotent; a race with a concurrent
 * sweep drops the loser's item.
 */
async function ensureSlotQueueItems(group: string, format: GroupFormat, now: Date): Promise<number> {
  const today = easternDate(now);
  const rows = await db
    .select({ id: newsletterDrafts.id, sendDate: newsletterDrafts.sendDate })
    .from(newsletterDrafts)
    .where(and(like(newsletterDrafts.slotKey, `${group}:%`), isNull(newsletterDrafts.productionItemId), gte(newsletterDrafts.sendDate, today)));
  if (!rows.length) return 0;
  const [channel] = await db
    .select({ accountId: formatChannels.accountId, postType: formatChannels.postType })
    .from(formatChannels)
    .where(eq(formatChannels.formatId, format.id))
    .orderBy(asc(formatChannels.createdAt), asc(formatChannels.id))
    .limit(1);
  const editorUserId = await resolveEditor({ brand: format.brand, format: format.name });
  let n = 0;
  for (const r of rows) {
    const label = new Date(`${r.sendDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    const [item] = await db
      .insert(productionItems)
      .values({
        brand: format.brand,
        title: `${format.name} — ${label}`,
        status: "Idea",
        format: format.name,
        sourceType: "original",
        accountId: channel?.accountId ?? null,
        postType: channel?.postType ?? "newsletter",
        createdVia: "newsletter-slots-sweep",
        editorUserId,
      })
      .returning({ id: productionItems.id });
    const linked = await db
      .update(newsletterDrafts)
      .set({ productionItemId: item.id, updatedAt: new Date() })
      .where(and(eq(newsletterDrafts.id, r.id), isNull(newsletterDrafts.productionItemId)))
      .returning({ id: newsletterDrafts.id });
    if (linked.length) n++;
    else await db.delete(productionItems).where(eq(productionItems.id, item.id));
  }
  return n;
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
  const byAccount = formatsByAccount(groupFormats);
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
      channel: f.handle,
      formatId: f.formatId,
      usedBySlot: usedBy.get(r.id) && usedBy.get(r.id) !== row.slotKey ? usedBy.get(r.id)! : null,
    };
  });
}

async function formatNameOf(formatId: string): Promise<string | null> {
  const [f] = await db.select({ name: formats.name }).from(formats).where(eq(formats.id, formatId)).limit(1);
  return f?.name ?? null;
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
    .returning({ id: newsletterDrafts.id, productionItemId: newsletterDrafts.productionItemId });
  if (!row) return { error: "This draft can't change video while it's drafting" };
  // The queue item's pillar follows the edition's video.
  if (row.productionItemId) {
    await db
      .update(productionItems)
      .set({ pillarContentItemId: pick.id, format: (await formatNameOf(pick.formatId)) ?? undefined, updatedAt: new Date() })
      .where(eq(productionItems.id, row.productionItemId));
  }
  return { ok: true };
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

