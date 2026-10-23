// The newsletter editor's per-section Regenerate: rewrite ONE section of a
// ready draft (optionally steered by the editor's instruction), splice it into
// `sections`, recompose the body and bump the revision. Runs on the worker
// (`newsletter-section-regenerate`) because a grounded rewrite can outlast
// Heroku's 30s router limit; the editor polls the draft until the key leaves
// `regenerating`.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, formats, newsletterDrafts } from "@/lib/db/schema";
import { composeIssue, templateFor, type NewsletterSection } from "@/lib/newsletter-template";
import { NewsletterCancelledError, regenerateSection, storyKeyOf } from "./agent";
import { blockedKeys, loadUsage, usageGroupFor, withInferredSources } from "./usage";
import { formatConfigFor } from "./format-config";
import { loadSourceVideo } from "./run";
import { buildStoryPlan, withPlanDates } from "./story-plan";
import { autoPickScreenshotsSafely, dropSectionScreenshots } from "./screenshots";
import { sectionExamples } from "./exemplars";
import { getPastIssues } from "./sources";
import { voiceForChannel } from "./format-config";

/** Replace one section (or append it), keeping its other fields. Pure; exported for tests. */
export function spliceSection(sections: NewsletterSection[], key: string, markdown: string, patch: Partial<NewsletterSection> = {}): NewsletterSection[] {
  return sections.some((x) => x.key === key)
    ? sections.map((x) => (x.key === key ? { ...x, ...patch, key, markdown } : x))
    : [...sections, { key, markdown, ...patch }];
}

/** "Find new story" exclusions: this section's current + already-offered stories, and every other section's story. Pure; exported for tests. */
export function newStoryExclusions(sections: NewsletterSection[], key: string): Set<string> {
  const out = new Set<string>();
  for (const sec of sections) {
    if (sec.source?.key) out.add(sec.source.key);
    if (sec.key === key) for (const t of sec.tried ?? []) out.add(t);
  }
  return out;
}

/** The section is still waiting on this run (Cancel removes it from `regenerating`). */
async function stillWanted(id: string, key: string): Promise<boolean> {
  const [cur] = await db
    .select({ id: newsletterDrafts.id })
    .from(newsletterDrafts)
    .where(and(eq(newsletterDrafts.id, id), sql`jsonb_exists(${newsletterDrafts.regenerating}, ${key})`))
    .limit(1);
  return !!cur;
}

async function clearRegenerating(id: string, key: string, error: string | null) {
  await db
    .update(newsletterDrafts)
    .set({
      regenerating: sql`COALESCE((SELECT jsonb_agg(k) FROM jsonb_array_elements_text(${newsletterDrafts.regenerating}) k WHERE k <> ${key}), '[]'::jsonb)`,
      error,
      updatedAt: new Date(),
    })
    .where(eq(newsletterDrafts.id, id));
}

export async function regenerateDraftSection(
  newsletterDraftId: string,
  sectionKey: string,
  instruction: string | null,
  opts: { signal?: AbortSignal; newStory?: boolean; log?: (msg: string) => void } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const [row] = await db
    .select({
      id: newsletterDrafts.id,
      brand: newsletterDrafts.brand,
      status: newsletterDrafts.status,
      windowStart: newsletterDrafts.windowStart,
      windowEnd: newsletterDrafts.windowEnd,
      sendDate: newsletterDrafts.sendDate,
      notes: newsletterDrafts.notes,
      sections: newsletterDrafts.sections,
      sources: newsletterDrafts.sources,
      regenerating: newsletterDrafts.regenerating,
      sourceItemId: newsletterDrafts.sourceItemId,
      specialCopy: newsletterDrafts.specialCopy,
      specialSource: newsletterDrafts.specialSource,
      formatName: formats.name,
      formatInstructions: formats.instructions,
      formatTemplate: formats.newsletterTemplate,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, newsletterDraftId))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  // Cancelled before it started (the editor took the key out of `regenerating`).
  if (!row.regenerating.includes(sectionKey)) return { ok: false, reason: "cancelled" };
  const template = templateFor(row.formatName, row.formatTemplate);
  if (!template || row.status !== "ready") {
    await clearRegenerating(row.id, sectionKey, null);
    return { ok: false, reason: "not_ready" };
  }

  try {
    const config = formatConfigFor(row.formatName);
    // Drafts written before the agent filled `source` get it from their links (and keep it on save).
    if (config.kind === "roundup") row.sections = withInferredSources(row.sections, row.sources);
    const [brand] = await db
      .select({ label: brands.label, guidelines: brands.brandGuidelines })
      .from(brands)
      .where(eq(brands.slug, row.brand))
      .limit(1);
    const video = config.kind === "single_video" ? await loadSourceVideo(row.sourceItemId, row.formatName) : null;
    const pillar = config.kind === "roundup" && row.sourceItemId ? await loadSourceVideo(row.sourceItemId).catch(() => null) : null;
    const sponsor = row.specialCopy ? { copy: row.specialCopy, landingUrl: row.specialSource?.landingUrl ?? null } : null;
    const usage = video ? undefined : await loadUsage(usageGroupFor(row.formatName), { excludeDraftId: row.id });
    const blocked = usage ? blockedKeys(usage, row.sendDate) : undefined;
    if (pillar) blocked?.delete(`video:${pillar.productionItemId}`);
    const exclude = opts.newStory ? newStoryExclusions(row.sections, sectionKey) : null;
    // Find new story: the same suggested lineup as the draft, so the swap looks in the right place.
    const storyPlan =
      exclude && !video
        ? await buildStoryPlan({ brand: row.brand, window: { start: row.windowStart, end: row.windowEnd }, template, blocked }).catch(
            () => null,
          )
        : null;
    // How this section has read before (same voice for two-voice formats): examples for the rewrite.
    const pastIssues = await getPastIssues(
      row.brand,
      row.formatName,
      video ? (voiceForChannel(row.formatName, video.channelHandle)?.voiceName ?? null) : null,
      template.sections.map((s) => s.heading ?? "").filter(Boolean),
    ).catch(() => []);
    const result = await regenerateSection({
      brand: row.brand,
      brandLabel: brand?.label ?? row.brand,
      brandGuidelines: brand?.guidelines ?? null,
      formatName: row.formatName,
      formatInstructions: row.formatInstructions,
      pastIssues: [],
      sectionExamples: sectionExamples(pastIssues, template),
      window: { start: row.windowStart, end: row.windowEnd },
      sendDate: row.sendDate,
      notes: row.notes,
      specialLabel: config.promo?.label ?? null,
      video,
      pillar,
      model: config.model,
      template,
      sections: row.sections,
      sectionKey,
      instruction,
      usage,
      blocked,
      newStoryExclude: exclude,
      storyPlan,
      log: opts.log,
      shouldStop: async () => !(await stillWanted(row.id, sectionKey)),
      currentIssue: composeIssue(template, row.sections, sponsor),
      sourcesNote: video ? null : row.sources.map((x) => `- ${x.kind}: ${x.title ?? ""} ${x.url ?? ""}`).join("\n") || null,
      signal: opts.signal,
    });
    const prev = row.sections.find((x) => x.key === sectionKey);
    const newKey = storyKeyOf(result.source);
    const source =
      newKey && result.source
        ? { kind: result.source.kind, key: newKey, title: result.source.title ?? null, url: result.source.url ?? null }
        : (prev?.source ?? null);
    const tried = opts.newStory && prev?.source?.key ? [...new Set([...(prev.tried ?? []), prev.source.key])] : prev?.tried;
    const sections = withPlanDates(spliceSection(row.sections, sectionKey, result.markdown, { source, ...(tried ? { tried } : {}) }), storyPlan);
    await db
      .update(newsletterDrafts)
      .set({
        sections,
        bodyMarkdown: composeIssue(template, sections, sponsor),
        revision: sql`${newsletterDrafts.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(newsletterDrafts.id, row.id), sql`jsonb_exists(${newsletterDrafts.regenerating}, ${sectionKey})`));
    await clearRegenerating(row.id, sectionKey, null);
    // New placeholders get frames picked; a new story means a new video, so its old picks go.
    if (opts.newStory) await dropSectionScreenshots(row.id, sectionKey);
    await autoPickScreenshotsSafely(row.id, opts.log);
    return { ok: true };
  } catch (err) {
    if (err instanceof NewsletterCancelledError) return { ok: false, reason: "cancelled" };
    if (opts.signal?.aborted) throw err;
    await clearRegenerating(row.id, sectionKey, `Regenerating "${sectionKey}" failed: ${(err as Error).message}`.slice(0, 2000));
    return { ok: false, reason: (err as Error).message };
  }
}
