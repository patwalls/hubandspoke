// Orchestrates one newsletter draft: load the `newsletter_drafts` row + its
// format and brand, run the agent, and write the result back (ready | failed).
// Called by the `newsletter-draft` worker task. Idempotent: a row that is no
// longer `drafting` is left alone, so a retry after success is a no-op.

import { and, desc, eq, isNotNull, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, formats, newsletterDrafts, newsletterIssueHistory, type NewsletterDraftProgress } from "@/lib/db/schema";
import { newsletterModel, NewsletterCancelledError, runNewsletterAgent, storyKeyOf, type NewsletterSubmission } from "./agent";
import { blockedKeys, loadUsage, toStoredSources, usageGroupFor, withInferredSources } from "./usage";
import { buildStoryPlan, withPlanDates } from "./story-plan";
import { composeIssue, templateFor, type NewsletterSection } from "@/lib/newsletter-template";
import { formatConfigFor, voiceForChannel } from "./format-config";
import { findSpecial } from "./promo";
import { SINGLE_VIDEO_TRANSCRIPT_BUDGET, getPastIssues, getSingleVideo, getTimestampedTranscript, youtubeThumbnailUrl } from "./sources";
import type { SourceVideo } from "./agent";
import { syncNewsletterItemTitle } from "./queue-status";
import { autoPickScreenshotsSafely } from "./screenshots";
import { sectionExamples } from "./exemplars";

export type NewsletterDraftRunResult =
  | { ok: true; turns: number; sources: number }
  | { ok: false; skipped: string };

/** Normalize the agent's declared sources into the stored shape. Exported for tests. */
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

/**
 * A one-video newsletter's last 15 editions: sent ones (beehiiv / HubSpot
 * history) + Hub & Spoke drafts that are written, newest first.
 */
export async function loadRecentEditions(formatName: string, excludeDraftId: string): Promise<{ date: string | null; subject: string }[]> {
  const group = usageGroupFor(formatName);
  const hist = await db
    .select({ date: newsletterIssueHistory.sentDate, subject: newsletterIssueHistory.subject })
    .from(newsletterIssueHistory)
    .where(eq(newsletterIssueHistory.scheduleGroup, group))
    .orderBy(desc(newsletterIssueHistory.sentDate))
    .limit(15);
  const drafts = await db
    .select({ id: newsletterDrafts.id, date: newsletterDrafts.sendDate, subject: newsletterDrafts.subject })
    .from(newsletterDrafts)
    .where(and(like(newsletterDrafts.slotKey, `${group}:%`), eq(newsletterDrafts.status, "ready"), isNotNull(newsletterDrafts.subject)))
    .orderBy(desc(newsletterDrafts.sendDate))
    .limit(15);
  const all = [
    ...hist.filter((h) => h.subject).map((h) => ({ date: h.date, subject: h.subject! })),
    ...drafts.filter((d) => d.id !== excludeDraftId).map((d) => ({ date: d.date, subject: d.subject! })),
  ];
  const seen = new Set<string>();
  return all
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .filter((e) => !seen.has(e.subject.toLowerCase()) && seen.add(e.subject.toLowerCase()))
    .slice(0, 15);
}

/** The picked video + its full transcript for a single_video draft. Throws a readable error when unusable. */
export async function loadSourceVideo(sourceItemId: string | null, formatName?: string): Promise<SourceVideo> {
  if (!sourceItemId) throw new Error("This format drafts from one video, but no video was picked.");
  const [v, t] = await Promise.all([
    getSingleVideo(sourceItemId),
    getTimestampedTranscript(sourceItemId, SINGLE_VIDEO_TRANSCRIPT_BUDGET),
  ]);
  if (!v) throw new Error("The picked video no longer exists.");
  if (!t) throw new Error(`"${v.title ?? "This video"}" has no transcript yet.`);
  return {
    productionItemId: v.productionItemId,
    channelHandle: v.channelHandle,
    voiceName: formatName ? (voiceForChannel(formatName, v.channelHandle)?.voiceName ?? null) : null,
    title: v.title,
    url: v.url,
    thumbnailUrl: youtubeThumbnailUrl(v.youtubeId),
    publishedAt: v.publishedAt,
    transcript: t.text,
    truncated: t.truncated,
    timestamped: t.timestamped,
  };
}

export async function runNewsletterDraft(
  newsletterDraftId: string,
  opts: { signal?: AbortSignal; log?: (msg: string) => void } = {},
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
      updatedAt: newsletterDrafts.updatedAt,
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
  // This run owns the row only while it's still `drafting` with the same
  // updated_at it started from: Cancel (and a later Redraft) both move it.
  const ours = and(eq(newsletterDrafts.id, row.id), eq(newsletterDrafts.status, "drafting"), eq(newsletterDrafts.updatedAt, row.updatedAt));
  const shouldStop = async () => {
    const [cur] = await db.select({ id: newsletterDrafts.id }).from(newsletterDrafts).where(ours).limit(1);
    return !cur;
  };
  const startedAt = new Date().toISOString();
  // The editor's progress bar reads this (each turn); only while this run still owns the row.
  const progress = async (p: { phase: NewsletterDraftProgress["phase"]; turn: number; detail: string | null }) => {
    await db.update(newsletterDrafts).set({ progress: { ...p, startedAt, at: new Date().toISOString() } }).where(ours);
  };
  try {
    await progress({ phase: "starting", turn: 0, detail: "Loading the template and past issues" }).catch(() => undefined);
    const video = config.kind === "single_video" ? await loadSourceVideo(row.sourceItemId, row.formatName) : null;
    // A roundup about ONE piece of pillar content (the editor picked it in New → Newsletter).
    const pillar = config.kind === "roundup" && row.sourceItemId ? await loadSourceVideo(row.sourceItemId) : null;
    const usage = video ? undefined : await loadUsage(usageGroupFor(row.formatName), { excludeDraftId: row.id });
    const blocked = usage ? blockedKeys(usage, row.sendDate) : undefined;
    if (pillar) blocked?.delete(`video:${pillar.productionItemId}`);
    const [pastIssues, special] = await Promise.all([
      // Same-voice past issues for two-voice formats (Kevin / Saj by the video's channel).
      // Only issues in the current template count as examples (never a retired layout).
      getPastIssues(row.brand, row.formatName, video?.voiceName ?? null, template?.sections.map((s) => s.heading ?? "").filter(Boolean) ?? []),
      findSpecial(row.formatName, row.sendDate),
    ]);
    const sponsored = special?.ok ? special : null;
    // The suggested lineup (a hint for the agent; a content-API hiccup just drops it).
    const recentEditions = video ? await loadRecentEditions(row.formatName, row.id) : undefined;
    const storyPlan =
      !video && !pillar
        ? await buildStoryPlan({ brand: row.brand, window: { start: row.windowStart, end: row.windowEnd }, template, blocked }).catch(
            (err) => (opts.log?.(`newsletter-draft: story plan skipped (${(err as Error).message})`), null),
          )
        : null;
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
      pillar,
      template,
      usage,
      blocked,
      storyPlan,
      recentEditions,
      // How each section read in the past issues: examples next to the instructions (exemplars.ts).
      sectionExamples: template ? sectionExamples(pastIssues, template) : null,
      model: config.model,
      log: opts.log,
      onProgress: progress,
      shouldStop,
      signal: opts.signal,
    });
    const s = result.submission;
    // The How-To's one source is the picked video, whatever the agent lists.
    const sources = video
      ? [{ kind: "video" as const, productionItemId: video.productionItemId, title: video.title, url: video.url }]
      : pillar
        ? [{ kind: "video" as const, productionItemId: pillar.productionItemId, title: pillar.title, url: pillar.url }, ...toStoredSources(s.sources).filter((x) => !(x.kind === "video" && x.productionItemId === pillar.productionItemId))]
        : toStoredSources(s.sources);
    const sections = template ? withPlanDates(withInferredSources(toStoredSections(s.sections ?? []), sources), storyPlan) : [];
    const saved = await db
      .update(newsletterDrafts)
      .set({
        status: "ready",
        subjectOptions: s.subject_options,
        subject: s.subject,
        previewText: s.preview_text,
        sections,
        // A fresh issue: earlier screenshot picks belong to the old text (autoPick below makes new ones).
        screenshots: {},
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
        progress: null,
        updatedAt: new Date(),
      })
      .where(ours)
      .returning({ id: newsletterDrafts.id });
    if (!saved.length) return { ok: false, skipped: "cancelled" };
    await autoPickScreenshotsSafely(row.id, opts.log);
    await syncNewsletterItemTitle(row.id).catch(() => undefined); // cosmetic: never fail a written draft over the queue name
    return { ok: true, turns: result.turns, sources: sources.length };
  } catch (err) {
    if (err instanceof NewsletterCancelledError) return { ok: false, skipped: "cancelled" };
    // An abort (deploy SIGTERM) leaves the row `drafting` so graphile's retry
    // picks it up; any other failure is final and shown on the page.
    if (opts.signal?.aborted) throw err;
    await db
      .update(newsletterDrafts)
      .set({ status: "failed", error: (err as Error).message.slice(0, 2000), model: newsletterModel(config.model), progress: null, updatedAt: new Date() })
      .where(ours);
    throw err;
  }
}
