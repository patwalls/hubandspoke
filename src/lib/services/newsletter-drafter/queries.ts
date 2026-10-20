// Reads + writes behind the newsletter drafter's API routes.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { computeWindow } from "./window";

export interface NewsletterFormatOption {
  id: string;
  name: string;
  hasSkill: boolean;
}

/**
 * The brand's newsletter formats: any format whose legacy `channels` include
 * "Newsletter", or that has published newsletter items (Daily Seinfeld,
 * Sunday Breakfast, … predate format_channels wiring).
 */
export async function listNewsletterFormats(brand: string): Promise<NewsletterFormatOption[]> {
  const rows = await db
    .select({ id: formats.id, name: formats.name, instructions: formats.instructions })
    .from(formats)
    .where(
      and(
        eq(formats.brand, brand),
        sql`(
          ${formats.channels} @> '["Newsletter"]'::jsonb
          OR EXISTS (
            SELECT 1 FROM ${productionItems}
            WHERE ${productionItems.brand} = ${brand}
              AND ${productionItems.postType} = 'newsletter'
              AND lower(${productionItems.format}) = lower(${formats.name})
          )
        )`,
      ),
    )
    .orderBy(formats.name);
  return rows.map((r) => ({ id: r.id, name: r.name, hasSkill: !!r.instructions?.trim() }));
}

const listColumns = {
  id: newsletterDrafts.id,
  formatId: newsletterDrafts.formatId,
  formatName: formats.name,
  status: newsletterDrafts.status,
  subject: newsletterDrafts.subject,
  windowStart: newsletterDrafts.windowStart,
  windowEnd: newsletterDrafts.windowEnd,
  hubspotStatus: newsletterDrafts.hubspotStatus,
  createdAt: newsletterDrafts.createdAt,
};

export async function listNewsletterDrafts(brand: string) {
  return db
    .select(listColumns)
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.brand, brand))
    .orderBy(desc(newsletterDrafts.createdAt))
    .limit(50);
}

export async function getNewsletterDraft(id: string) {
  const [row] = await db
    .select({
      ...listColumns,
      brand: newsletterDrafts.brand,
      sources: newsletterDrafts.sources,
      subjectOptions: newsletterDrafts.subjectOptions,
      previewText: newsletterDrafts.previewText,
      bodyMarkdown: newsletterDrafts.bodyMarkdown,
      notes: newsletterDrafts.notes,
      model: newsletterDrafts.model,
      error: newsletterDrafts.error,
      hubspotEmailId: newsletterDrafts.hubspotEmailId,
      hubspotEmailUrl: newsletterDrafts.hubspotEmailUrl,
      hubspotError: newsletterDrafts.hubspotError,
      updatedAt: newsletterDrafts.updatedAt,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, id))
    .limit(1);
  return row ?? null;
}

export async function createNewsletterDraft(args: {
  formatId: string;
  days?: number | null;
  notes?: string | null;
  userId: string | null;
}): Promise<{ id: string; brand: string } | null> {
  const [format] = await db
    .select({ id: formats.id, brand: formats.brand })
    .from(formats)
    .where(eq(formats.id, args.formatId))
    .limit(1);
  if (!format) return null;
  const w = computeWindow(args.days);
  const [created] = await db
    .insert(newsletterDrafts)
    .values({
      brand: format.brand,
      formatId: format.id,
      status: "drafting",
      windowStart: w.start,
      windowEnd: w.end,
      notes: args.notes?.trim() || null,
      createdByUserId: args.userId,
    })
    .returning({ id: newsletterDrafts.id });
  return { id: created.id, brand: format.brand };
}
