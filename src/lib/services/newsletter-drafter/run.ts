// Orchestrates one newsletter draft: load the `newsletter_drafts` row + its
// format and brand, run the agent, and write the result back (ready | failed).
// Called by the `newsletter-draft` worker task. Idempotent: a row that is no
// longer `drafting` is left alone, so a retry after success is a no-op.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, formats, newsletterDrafts, type NewsletterDraftSource } from "@/lib/db/schema";
import { NEWSLETTER_MODEL, runNewsletterAgent, type NewsletterSubmission } from "./agent";
import { findSpecial } from "./promo";
import { getPastIssues } from "./sources";

export type NewsletterDraftRunResult =
  | { ok: true; turns: number; sources: number }
  | { ok: false; skipped: string };

/** Normalize the agent's declared sources into the stored shape. Exported for tests. */
export function toStoredSources(sources: NewsletterSubmission["sources"]): NewsletterDraftSource[] {
  const out: NewsletterDraftSource[] = [];
  for (const s of sources) {
    if (s.kind === "video" && s.production_item_id) {
      out.push({ kind: "video", productionItemId: s.production_item_id, title: s.title ?? null, url: s.url ?? null });
    } else if (s.kind === "case_study" && s.url) {
      out.push({ kind: "case_study", url: s.url, title: s.title ?? null });
    }
  }
  return out;
}

export async function runNewsletterDraft(
  newsletterDraftId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<NewsletterDraftRunResult> {
  const [row] = await db
    .select({
      id: newsletterDrafts.id,
      brand: newsletterDrafts.brand,
      status: newsletterDrafts.status,
      windowStart: newsletterDrafts.windowStart,
      windowEnd: newsletterDrafts.windowEnd,
      notes: newsletterDrafts.notes,
      sendDate: newsletterDrafts.sendDate,
      formatName: formats.name,
      formatInstructions: formats.instructions,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, newsletterDraftId))
    .limit(1);

  if (!row) return { ok: false, skipped: "not_found" };
  if (row.status !== "drafting") return { ok: false, skipped: `status_${row.status}` };

  const [brand] = await db
    .select({ label: brands.label, guidelines: brands.brandGuidelines })
    .from(brands)
    .where(eq(brands.slug, row.brand))
    .limit(1);

  try {
    const [pastIssues, special] = await Promise.all([
      getPastIssues(row.brand, row.formatName),
      findSpecial(row.formatName, row.sendDate),
    ]);
    const sponsored = special?.ok ? special : null;
    const result = await runNewsletterAgent({
      brand: row.brand,
      brandLabel: brand?.label ?? row.brand,
      brandGuidelines: brand?.guidelines ?? null,
      formatName: row.formatName,
      formatInstructions: row.formatInstructions,
      pastIssues,
      window: { start: row.windowStart, end: row.windowEnd },
      notes: row.notes,
      sendDate: row.sendDate,
      sponsoredCopy: sponsored?.copy ?? null,
      signal: opts.signal,
    });
    const s = result.submission;
    const sources = toStoredSources(s.sources);
    await db
      .update(newsletterDrafts)
      .set({
        status: "ready",
        subjectOptions: s.subject_options,
        subject: s.subject,
        previewText: s.preview_text,
        bodyMarkdown: s.body_markdown,
        sources,
        specialCopy: sponsored?.copy ?? null,
        specialOriginal: sponsored?.copy ?? null,
        specialMode: sponsored ? "verbatim" : null,
        specialSource: sponsored?.source ?? null,
        specialError: special && !special.ok ? special.error : null,
        model: result.model,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(newsletterDrafts.id, row.id));
    return { ok: true, turns: result.turns, sources: sources.length };
  } catch (err) {
    // An abort (deploy SIGTERM) leaves the row `drafting` so graphile's retry
    // picks it up; any other failure is final and shown on the page.
    if (opts.signal?.aborted) throw err;
    await db
      .update(newsletterDrafts)
      .set({ status: "failed", error: (err as Error).message.slice(0, 2000), model: NEWSLETTER_MODEL, updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    throw err;
  }
}
