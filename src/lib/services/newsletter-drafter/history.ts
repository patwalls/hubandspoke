// Fill `newsletter_issue_history` with the stories past issues ran, so the
// drafter's no-repeat rule and the "N× before" badges see issues that never
// went through Hub & Spoke's drafter:
//   - HubSpot: published Starter Story emails (read-only list call), grouped by
//     the team's naming ("Starter Story | Newsletter | …" → Sunday Breakfast,
//     "Starter Story | Daily | …" → Daily Seinfeld)
//   - Klaviyo era: published `production_items` newsletter rows with HTML (all
//     of them — a few dozen rows, and old usage still counts toward "N× before")
// Emails our own push created are skipped (the draft already counts them).
// Idempotent: upsert by external_id.

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts, newsletterIssueHistory, productionItems } from "@/lib/db/schema";
import { emailRichTextHtml, listEmailsCreatedAfter } from "@/lib/hubspot-marketing-email";
import { extractStoryRefs, usageGroupFor, videoKeysForYoutubeIds } from "./usage";

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

export async function syncNewsletterHistory(opts: { since: Date }): Promise<{ hubspot: number; items: number }> {
  let hubspot = 0;
  let items = 0;

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
  return { hubspot, items };
}
