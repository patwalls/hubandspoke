// Orchestrates one newsletter draft: load the `newsletter_drafts` row + its
// format and brand, run the agent, and write the result back (ready | failed).
// Called by the `newsletter-draft` worker task. Idempotent: a row that is no
// longer `drafting` is left alone, so a retry after success is a no-op.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, formats, newsletterDrafts, type NewsletterDraftSource } from "@/lib/db/schema";
import { NEWSLETTER_MODEL, runNewsletterAgent, storyKeyOf, type NewsletterSubmission } from "./agent";
import { blockedKeys, loadUsage, usageGroupFor, withInferredSources } from "./usage";
import { composeIssue, templateFor, type NewsletterSection } from "@/lib/newsletter-template";
import { formatConfigFor } from "./format-config";
import { findSpecial } from "./promo";
import { SINGLE_VIDEO_TRANSCRIPT_BUDGET, getPastIssues, getSingleVideo, getVideoTranscript, youtubeThumbnailUrl } from "./sources";
import type { SourceVideo } from "./agent";

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

/** Agent sections → stored sections, each story resolved to its usage key. Pure; exported for tests. */
export function toStoredSections(sections: NonNullable<NewsletterSubmission["sections"]>): NewsletterSection[] {
  return sections.map((sec) => {
    const key = storyKeyOf(sec.source);
    return {
      key: sec.key,
      markdown: sec.markdown,
      source: key && sec.source ? { kind: sec.source.kind, key, title: sec.source.title ?? null, url: sec.source.url ?? null } : null,
    };
  });
}

/** The picked video + its full transcript for a single_video draft. Throws a readable error when unusable. */
export async function loadSourceVideo(sourceItemId: string | null): Promise<SourceVideo> {
  if (!sourceItemId) throw new Error("This format drafts from one video, but no video was picked.");
  const [v, t] = await Promise.all([
    getSingleVideo(sourceItemId),
    getVideoTranscript(sourceItemId, SINGLE_VIDEO_TRANSCRIPT_BUDGET),
  ]);
  if (!v) throw new Error("The picked video no longer exists.");
  if (!t) throw new Error(`"${v.title ?? "This video"}" has no transcript yet.`);
  return {
    productionItemId: v.productionItemId,
    title: v.title,
    url: v.url,
    thumbnailUrl: youtubeThumbnailUrl(v.youtubeId),
    publishedAt: v.publishedAt,
    transcript: t.text,
    truncated: t.truncated,
  };
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
      sourceItemId: newsletterDrafts.sourceItemId,
      formatName: formats.name,
      formatInstructions: formats.instructions,
      formatTemplate: formats.newsletterTemplate,
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

  const config = formatConfigFor(row.formatName);
  const template = templateFor(row.formatName, row.formatTemplate);
  try {
    const video = config.kind === "single_video" ? await loadSourceVideo(row.sourceItemId) : null;
    const usage = video ? undefined : await loadUsage(usageGroupFor(row.formatName), { excludeDraftId: row.id });
    const blocked = usage ? blockedKeys(usage, row.sendDate) : undefined;
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
      sponsoredLandingUrl: sponsored?.source.landingUrl ?? null,
      specialLabel: config.promo?.label ?? null,
      sponsoredPlaceholder: !sponsored && config.promo?.onMiss === "placeholder",
      video,
      template,
      usage,
      blocked,
      model: config.model,
      signal: opts.signal,
    });
    const s = result.submission;
    // The How-To's one source is the picked video, whatever the agent lists.
    const sources = video
      ? [{ kind: "video" as const, productionItemId: video.productionItemId, title: video.title, url: video.url }]
      : toStoredSources(s.sources);
    const sections = template ? withInferredSources(toStoredSections(s.sections ?? []), sources) : [];
    await db
      .update(newsletterDrafts)
      .set({
        status: "ready",
        subjectOptions: s.subject_options,
        subject: s.subject,
        previewText: s.preview_text,
        sections,
        // Templated: the composed issue (what the HubSpot push sends); free-form: the agent's body.
        bodyMarkdown: template
          ? composeIssue(template, sections, sponsored ? { copy: sponsored.copy, landingUrl: sponsored.source.landingUrl } : null)
          : (s.body_markdown ?? ""),
        revision: sql`${newsletterDrafts.revision} + 1`,
        regenerating: [],
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
      .set({ status: "failed", error: (err as Error).message.slice(0, 2000), model: config.model ?? NEWSLETTER_MODEL, updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    throw err;
  }
}
