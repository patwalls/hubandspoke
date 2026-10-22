// Fill `newsletter_issue_history` with the stories past issues ran, so the
// drafter's no-repeat rule and the "N× before" badges see issues that never
// went through Hub & Spoke's drafter:
//   - HubSpot: published Starter Story emails (read-only list call), grouped by
//     the team's naming ("Starter Story | Newsletter | …" → Sunday Breakfast,
//     "Starter Story | Daily | …" → Daily Seinfeld)
//   - Klaviyo era: published `production_items` newsletter rows with HTML (all
//     of them — a few dozen rows, and old usage still counts toward "N× before")
//   - beehiiv (Futurepedia, read-only client): published How-To editions
//     (they carry "How We Did It" / "Watch The Full Video"), keyed by the
//     YouTube video they link, so a video never gets a second edition and the
//     drafter knows which topics ran recently. Other beehiiv issues (the news
//     roundup, announcements) are stored as group "futurepedia-other" so they
//     aren't re-read.
// Emails our own push created are skipped (the draft already counts them).
// Idempotent: upsert by external_id.
//
// Sent beehiiv How-To editions also become published "Futurepedia Newsletter"
// content items (importBeehiivHowToIssues), the way Starter Story's past issues
// live in production_items: the format page lists them, and the drafter reads
// the most recent ones (same voice) as example issues.

import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { formatChannels, formats, newsletterDrafts, newsletterIssueHistory, productionItems } from "@/lib/db/schema";
import { emailRichTextHtml, listEmailsCreatedAfter } from "@/lib/hubspot-marketing-email";
import { getFuturepediaPost, listFuturepediaPosts } from "@/lib/beehiiv";
import { extractStoryRefs, usageGroupFor, videoKeysForYoutubeIds } from "./usage";
import { resolveEditor } from "@/lib/services/assignees";
import { scheduledPrimaries } from "./format-config";
import { htmlToPlainText } from "./sources";

const STARTER_STORY_BUSINESS_UNIT = "4057751";

/** Schedule group from a hand-built Starter Story HubSpot email's name, else null. Pure; exported for tests. */
export function groupFromEmailName(name: string | null | undefined): string | null {
  const n = (name ?? "").toLowerCase();
  if (!n.startsWith("starter story |")) return null;
  if (n.includes("| daily |")) return "daily-seinfeld";
  if (n.includes("| newsletter |")) return "sunday-breakfast";
  return null;
}

async function keysFromHtml(html: string): Promise<string[]> {
  const refs = extractStoryRefs(html);
  return [...refs.caseKeys, ...(await videoKeysForYoutubeIds(refs.youtubeIds))];
}

async function upsert(row: typeof newsletterIssueHistory.$inferInsert) {
  await db
    .insert(newsletterIssueHistory)
    .values(row)
    .onConflictDoUpdate({
      target: newsletterIssueHistory.externalId,
      set: { sourceKeys: row.sourceKeys, name: row.name, subject: row.subject, sentDate: row.sentDate, syncedAt: new Date() },
    });
}

/** True for a Futurepedia How-To edition's HTML (its fixed card labels). Pure; exported for tests. */
export function isHowToEdition(html: string): boolean {
  return /How We Did It|Watch The Full Video/i.test(html);
}

/** YYYY-MM-DD (US Eastern) of a beehiiv unix timestamp. */
function beehiivDate(ts: number | null | undefined): string | null {
  return ts ? new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : null;
}

/** Published Futurepedia editions since `since` (read-only). Already-stored posts aren't re-fetched. */
async function syncBeehiivHistory(since: Date): Promise<number> {
  if (!process.env.BEEHIIV_API_KEY) return 0;
  const have = new Set(
    (await db.select({ id: newsletterIssueHistory.externalId }).from(newsletterIssueHistory).where(sql`${newsletterIssueHistory.externalId} LIKE 'beehiiv:%'`)).map(
      (r) => r.id,
    ),
  );
  const ours = new Set(
    (await db.select({ id: newsletterDrafts.beehiivPostId }).from(newsletterDrafts).where(isNotNull(newsletterDrafts.beehiivPostId))).map((r) => r.id!),
  );
  let n = 0;
  // The team's own beehiiv DRAFTS too (their Claude-skill flow still runs in parallel): a video they're already
  // drafting must not get a second edition here, and the send date in its slug is taken. Stored once, as origin
  // "beehiiv-draft" with sent_date from the slug's -MM-DD-YYYY. Our own pushed drafts are skipped.
  for (let page = 1; page <= 4; page++) {
    const r = await listFuturepediaPosts({ page, limit: 50, status: "draft" });
    for (const p of r.data) {
      if (have.has(`beehiiv:${p.id}`) || ours.has(p.id)) continue;
      const html = (await getFuturepediaPost(p.id, ["free_email_content"])).content?.free?.email ?? "";
      if (!isHowToEdition(html)) continue;
      const m = (p.slug ?? "").match(/-(\d{2})-(\d{2})-(\d{4})$/);
      await upsert({
        brand: "futurepedia",
        scheduleGroup: "futurepedia-howto",
        externalId: `beehiiv:${p.id}`,
        origin: "beehiiv-draft",
        name: p.title ?? null,
        subject: (p.subject_line as string | undefined) ?? p.title ?? null,
        sentDate: m ? `${m[3]}-${m[1]}-${m[2]}` : null,
        sourceKeys: await videoKeysForYoutubeIds(extractStoryRefs(html).youtubeIds),
      });
      n++;
    }
    if (page >= r.total_pages) break;
  }
  for (let page = 1; page <= 20; page++) {
    const r = await listFuturepediaPosts({ page, limit: 50, status: "confirmed" });
    for (const p of r.data) {
      const ts = p.publish_date ?? p.displayed_date ?? null;
      if (ts && ts * 1000 < since.getTime()) return n;
      if (have.has(`beehiiv:${p.id}`) || ours.has(p.id)) continue;
      const full = await getFuturepediaPost(p.id, ["free_email_content"]);
      const html = full.content?.free?.email ?? "";
      const howTo = isHowToEdition(html);
      await upsert({
        brand: "futurepedia",
        scheduleGroup: howTo ? "futurepedia-howto" : "futurepedia-other",
        externalId: `beehiiv:${p.id}`,
        origin: "beehiiv",
        name: p.title ?? null,
        subject: (p.subject_line as string | undefined) ?? p.title ?? null,
        sentDate: beehiivDate(ts),
        sourceKeys: howTo ? await videoKeysForYoutubeIds(extractStoryRefs(html).youtubeIds) : [],
      });
      n++;
    }
    if (page >= r.total_pages) break;
  }
  return n;
}

/** Kevin or Saj from a beehiiv post's authors ("Kevin at Futurepedia", "Saj Adib"). Pure; exported for tests. */
export function voiceFromAuthors(authors: unknown): string | null {
  const names = Array.isArray(authors) ? authors.map((a) => (typeof a === "string" ? a : ((a as { name?: string })?.name ?? ""))) : [];
  const joined = names.join(" ").toLowerCase();
  if (/\bkevin\b/.test(joined)) return "Kevin";
  if (/\bsaj\b/.test(joined)) return "Saj";
  return names.find(Boolean) ?? null;
}

/**
 * Sent Futurepedia How-To editions (history group "futurepedia-howto", origin
 * "beehiiv", send date passed) → published content items in the group's
 * format, one per post (platform_content_id = the beehiiv post id), linked
 * to the video they cover. Read-only on beehiiv; only posts without an item
 * yet are fetched. The team's scheduled and draft posts are never imported.
 */
export async function importBeehiivHowToIssues(now: Date = new Date()): Promise<number> {
  if (!process.env.BEEHIIV_API_KEY) return 0;
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const sent = await db
    .select({ externalId: newsletterIssueHistory.externalId, sourceKeys: newsletterIssueHistory.sourceKeys, sentDate: newsletterIssueHistory.sentDate })
    .from(newsletterIssueHistory)
    .where(and(eq(newsletterIssueHistory.scheduleGroup, "futurepedia-howto"), eq(newsletterIssueHistory.origin, "beehiiv"), lte(newsletterIssueHistory.sentDate, today)));
  if (!sent.length) return 0;
  const postIds = sent.map((r) => r.externalId.replace(/^beehiiv:/, ""));
  const imported = new Set(
    (
      await db
        .select({ id: productionItems.platformContentId })
        .from(productionItems)
        .where(and(eq(productionItems.brand, "futurepedia"), eq(productionItems.postType, "newsletter"), inArray(productionItems.platformContentId, postIds)))
    ).map((r) => r.id),
  );
  const todo = sent.filter((r) => !imported.has(r.externalId.replace(/^beehiiv:/, "")));
  if (!todo.length) return 0;

  // The group's format (the Futurepedia Newsletter) and its newsletter account.
  const formatName = scheduledPrimaries().find((p) => p.schedule.group === "futurepedia-howto")?.formatName;
  if (!formatName) return 0;
  const [format] = await db
    .select({ id: formats.id, name: formats.name })
    .from(formats)
    .where(and(eq(formats.brand, "futurepedia"), sql`lower(${formats.name}) = ${formatName}`))
    .limit(1);
  if (!format) return 0;
  const [channel] = await db
    .select({ accountId: formatChannels.accountId })
    .from(formatChannels)
    .where(and(eq(formatChannels.formatId, format.id), eq(formatChannels.postType, "newsletter")))
    .limit(1);

  // Owner like any synced item: the format's default editor, else the brand's.
  const editorUserId = await resolveEditor({ brand: "futurepedia", format: format.name });

  let n = 0;
  for (const row of todo) {
    const postId = row.externalId.replace(/^beehiiv:/, "");
    const p = await getFuturepediaPost(postId, ["free_web_content"]);
    if (p.status !== "confirmed") continue;
    const ts = p.publish_date ?? p.displayed_date ?? null;
    if (!ts || ts * 1000 > now.getTime()) continue; // scheduled, not sent yet
    const html = p.content?.free?.web ?? "";
    const video = (row.sourceKeys ?? []).find((k) => k.startsWith("video:"))?.slice("video:".length) ?? null;
    await db.insert(productionItems).values({
      brand: "futurepedia",
      title: (p.subject_line as string | undefined) ?? p.title ?? null,
      postType: "newsletter",
      status: "Published",
      format: format.name,
      accountId: channel?.accountId ?? null,
      platformContentId: postId,
      publishedAt: new Date(ts * 1000),
      publishedDate: beehiivDate(ts),
      publishedLink: p.web_url ?? null,
      newsletterPreviewText: (p.preview_text as string | undefined) ?? p.subtitle ?? null,
      newsletterBodyHtml: html || null,
      contentBody: html ? htmlToPlainText(html) : null,
      authorDisplayName: voiceFromAuthors(p.authors),
      pillarContentItemId: video,
      sourceType: "original",
      editorUserId,
      createdVia: "sync:beehiiv",
    });
    n++;
  }
  return n;
}

export async function syncNewsletterHistory(opts: { since: Date }): Promise<{ hubspot: number; items: number; beehiiv: number; beehiivImported: number }> {
  let hubspot = 0;
  let items = 0;
  const beehiiv = await syncBeehiivHistory(opts.since);
  const beehiivImported = await importBeehiivHowToIssues();

  const pushed = await db
    .select({ id: newsletterDrafts.hubspotEmailId })
    .from(newsletterDrafts)
    .where(isNotNull(newsletterDrafts.hubspotEmailId));
  const ours = new Set(pushed.map((p) => p.id!));

  for await (const e of listEmailsCreatedAfter(opts.since.toISOString())) {
    if (e.state !== "PUBLISHED" || ours.has(String(e.id))) continue;
    if (e.businessUnitId != null && String(e.businessUnitId) !== STARTER_STORY_BUSINESS_UNIT) continue;
    const group = groupFromEmailName(e.name);
    if (!group) continue;
    await upsert({
      brand: "starter-story",
      scheduleGroup: group,
      externalId: `hubspot:${e.id}`,
      origin: "hubspot",
      name: e.name ?? null,
      subject: e.subject ?? null,
      // publishDate = the scheduled send ("Oct. 18" is scheduled on the 15th, sent the 18th).
      sentDate: (e.publishDate ?? e.publishedAt ?? "").slice(0, 10) || null,
      sourceKeys: await keysFromHtml(emailRichTextHtml(e)),
    });
    hubspot++;
  }

  const rows = await db
    .select({
      id: productionItems.id,
      format: productionItems.format,
      title: productionItems.title,
      html: productionItems.newsletterBodyHtml,
      publishedAt: productionItems.publishedAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, "starter-story"),
        eq(productionItems.postType, "newsletter"),
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.newsletterBodyHtml),
        isNotNull(productionItems.format),
      ),
    );
  for (const r of rows) {
    await upsert({
      brand: "starter-story",
      scheduleGroup: usageGroupFor(r.format!),
      externalId: `item:${r.id}`,
      origin: "klaviyo",
      name: r.title,
      subject: r.title,
      sentDate: r.publishedAt ? r.publishedAt.toISOString().slice(0, 10) : null,
      sourceKeys: await keysFromHtml(r.html!),
    });
    items++;
  }
  return { hubspot, items, beehiiv, beehiivImported };
}
