// Which stories a newsletter has already run, so the drafter doesn't repeat a
// video or case study from the last few issues (e.g. a video that went out
// last Sunday morning, which this Sunday's 7-day lookback would otherwise pick
// up again) and the editor can show "2× before · last Sep 14".
//
// A story is identified by a stable KEY:
//   video:<production_items.id>    (YouTube links resolve via youtube_id)
//   case:/stories/<slug>           (starterstory.com case-study paths)
// Usage = every issue of the same schedule group that actually went out:
//   - Hub & Spoke drafts pushed to the email tool, or ready with a past send date
//   - newsletter_issue_history (HubSpot hand-built issues + Klaviyo-era issues,
//     filled by the read-only `newsletter-history-sync` task)

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, newsletterDrafts, newsletterIssueHistory, productionItems, type NewsletterDraftSource } from "@/lib/db/schema";
import type { NewsletterSection } from "@/lib/newsletter-template";
import { formatConfigFor, groupFormatNames } from "./format-config";

/** Never reuse a story this newsletter ran within this many days of the new issue's send date. */
export const RECENT_BLOCK_DAYS = 21;
/** "Older story" backfill: only stories not run in this many days. */
export const EVERGREEN_MIN_DAYS = 90;

export interface StoryUsage {
  count: number;
  /** YYYY-MM-DD of the most recent issue that ran it. */
  lastDate: string | null;
}

// starterstory.com pages that aren't a story (footer links, landing pages).
const NON_STORY_PATHS = new Set(["/explore", "/about", "/share", "/join", "/micro", "/login", "/signup", "/pricing", "/ideas", "/data"]);
const NON_STORY_PREFIXES = ["/data/", "/explore/", "/lp/", "/l/", "/go/", "/account", "/settings"];

/** "case:<path>" for a starterstory.com story URL (/stories/<slug>, breakdowns…), else null. Pure; exported for tests. */
export function caseStudyKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.replace(/&amp;/g, "&"));
    if (!/(^|\.)starterstory\.com$/i.test(u.hostname)) return null;
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    if (!path || NON_STORY_PATHS.has(path) || NON_STORY_PREFIXES.some((p) => path.startsWith(p))) return null;
    return `case:${path}`;
  } catch {
    return null;
  }
}

/** The 11-char YouTube id in a watch / youtu.be / shorts URL, else null. Pure; exported for tests. */
export function youtubeIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.replace(/&amp;/g, "&"));
    const host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    if (host === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (host === "youtube.com") {
      if (u.searchParams.get("v")) return u.searchParams.get("v")!.slice(0, 11);
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
      return m ? m[1] : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Every href in an issue's HTML split into case-study keys and YouTube ids (structural parse). Pure; exported for tests. */
export function extractStoryRefs(html: string): { caseKeys: string[]; youtubeIds: string[] } {
  const hrefs = [...html.matchAll(/href\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  const caseKeys = new Set<string>();
  const youtubeIds = new Set<string>();
  for (const h of hrefs) {
    const c = caseStudyKey(h);
    if (c) caseKeys.add(c);
    const y = youtubeIdFromUrl(h);
    if (y) youtubeIds.add(y);
  }
  return { caseKeys: [...caseKeys], youtubeIds: [...youtubeIds] };
}

/**
 * Sections with no `source` get one from the story link in their Markdown, matched
 * against the issue's `sources` (videos by YouTube id, case studies by path; a
 * starterstory.com story link not in `sources` still counts). The agent doesn't
 * always fill `source`, but every course links its story. A story linked from
 * several sections (an intro teasing the main video) stays with the longest one.
 * Pure; exported for tests.
 */
export function withInferredSources(sections: NewsletterSection[], sources: NewsletterDraftSource[]): NewsletterSection[] {
  const inferred = new Map<string, NewsletterSection["source"]>();
  for (const sec of sections) {
    if (sec.source?.key) continue;
    const links = [...sec.markdown.matchAll(/https?:\/\/[^\s)\]>"]+/g)].map((m) => m[0]);
    for (const link of links) {
      const yt = youtubeIdFromUrl(link);
      const video = yt ? sources.find((x) => x.kind === "video" && youtubeIdFromUrl(x.url) === yt) : undefined;
      if (video?.kind === "video") {
        inferred.set(sec.key, { kind: "video", key: `video:${video.productionItemId}`, title: video.title ?? null, url: video.url ?? null });
        break;
      }
      const ck = caseStudyKey(link);
      if (ck) {
        const cs = sources.find((x) => x.kind === "case_study" && caseStudyKey(x.url) === ck);
        inferred.set(sec.key, { kind: "case_study", key: ck, title: cs?.title ?? null, url: cs?.url ?? link });
        break;
      }
    }
  }
  const claimed = new Set(sections.map((x) => x.source?.key).filter(Boolean));
  const owner = new Map<string, NewsletterSection>();
  for (const sec of sections) {
    const k = inferred.get(sec.key)?.key;
    if (!k || claimed.has(k)) continue;
    const cur = owner.get(k);
    if (!cur || sec.markdown.length > cur.markdown.length) owner.set(k, sec);
  }
  return sections.map((sec) => {
    const src = inferred.get(sec.key);
    return src && owner.get(src.key) === sec ? { ...sec, source: src } : sec;
  });
}

/** YouTube ids → "video:<production item id>" keys (ids with no matching item are dropped). */
export async function videoKeysForYoutubeIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: productionItems.id }).from(productionItems).where(inArray(productionItems.youtubeId, ids));
  return rows.map((r) => `video:${r.id}`);
}

/** The usage group for a format: its schedule group, else the format itself. */
export function usageGroupFor(formatName: string): string {
  return formatConfigFor(formatName).schedule?.group ?? `format:${formatName.trim().toLowerCase()}`;
}

function bump(map: Map<string, StoryUsage>, key: string, date: string | null) {
  const cur = map.get(key) ?? { count: 0, lastDate: null };
  cur.count++;
  if (date && (!cur.lastDate || date > cur.lastDate)) cur.lastDate = date;
  map.set(key, cur);
}

/**
 * Story usage for a group: key → how many issues ran it and when last.
 * `excludeDraftId` leaves the draft being edited out of its own counts.
 */
export async function loadUsage(group: string, opts: { excludeDraftId?: string; now?: Date } = {}): Promise<Map<string, StoryUsage>> {
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const usage = new Map<string, StoryUsage>();

  // Hub & Spoke drafts that went out (pushed to the email tool, or ready and past their send date).
  const names = group.startsWith("format:") ? [group.slice("format:".length)] : groupFormatNames(group);
  if (names.length) {
    const drafts = await db
      .select({ id: newsletterDrafts.id, sendDate: newsletterDrafts.sendDate, sections: newsletterDrafts.sections, sources: newsletterDrafts.sources })
      .from(newsletterDrafts)
      .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
      .where(
        and(
          inArray(sql`lower(${formats.name})`, names),
          or(eq(newsletterDrafts.hubspotStatus, "created"), and(eq(newsletterDrafts.status, "ready"), sql`${newsletterDrafts.sendDate} < ${today}`)),
        ),
      );
    for (const d of drafts) {
      if (d.id === opts.excludeDraftId) continue;
      const keys = new Set<string>();
      for (const s of d.sections) if (s.source?.key) keys.add(s.source.key);
      for (const s of d.sources) {
        if (s.kind === "video") keys.add(`video:${s.productionItemId}`);
        else {
          const k = caseStudyKey(s.url);
          if (k) keys.add(k);
        }
      }
      for (const k of keys) bump(usage, k, d.sendDate);
    }
  }

  // Issues sent outside the drafter (HubSpot by hand, Klaviyo era).
  const history = await db
    .select({ sentDate: newsletterIssueHistory.sentDate, keys: newsletterIssueHistory.sourceKeys })
    .from(newsletterIssueHistory)
    .where(eq(newsletterIssueHistory.scheduleGroup, group));
  for (const h of history) for (const k of new Set(h.keys)) bump(usage, k, h.sentDate);

  return usage;
}

/** Keys run within RECENT_BLOCK_DAYS before `sendDate` (or today) — never reused. Pure; exported for tests. */
export function blockedKeys(usage: Map<string, StoryUsage>, sendDate: string | null, now: Date = new Date()): Set<string> {
  const anchor = sendDate ? new Date(`${sendDate}T00:00:00Z`) : now;
  const cutoff = new Date(anchor.getTime() - RECENT_BLOCK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const out = new Set<string>();
  for (const [k, u] of usage) if (u.lastDate && u.lastDate >= cutoff) out.add(k);
  return out;
}

/** True when a story is fair game as an "older" pick (not run within EVERGREEN_MIN_DAYS). Pure. */
export function isEvergreenOk(u: StoryUsage | undefined, now: Date = new Date()): boolean {
  if (!u?.lastDate) return true;
  const cutoff = new Date(now.getTime() - EVERGREEN_MIN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return u.lastDate < cutoff;
}

/** Short label for a usage badge: "New" or "2× before · last Sep 14". Pure; exported for tests. */
export function usageLabel(u: StoryUsage | undefined): string {
  if (!u || u.count === 0) return "New";
  const last = u.lastDate ? new Date(`${u.lastDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
  return `${u.count}× before${last ? ` · last ${last}` : ""}`;
}

