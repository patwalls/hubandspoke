import { and, desc, eq, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import type { PostType } from "@/lib/platform-field-schemas";

/**
 * A real (source → target) cross-post pair pulled from the team's
 * publishing history. Injected into the draft-agent's per-call payload
 * as the strongest signal for "how much rewriting is appropriate" —
 * if the team's prior pairs are near-verbatim, the agent should match
 * that, regardless of what the past-caption exemplars suggest.
 */
export interface PriorCrossPostExample {
  /** Published body text on the source platform. */
  sourceText: string;
  /** Published body text on the target platform — the team's actual
   *  edit of the source for this (sourcePostType → targetPostType)
   *  direction. This is the post-human-edit final, not the raw AI draft.
   *  Good enough as a training signal; a separate revisions log would
   *  let us recover the AI-vs-human delta but isn't built yet. */
  targetText: string;
  /** ISO date for the prompt header — lets the agent prefer recent
   *  voice over stale exemplars when relevant. */
  targetPublishedAt: string | null;
}

interface LoadPriorCrossPostExamplesOpts {
  /** Account that owns the new cross-post. We only pull pairs from this
   *  same account — see plan question answered "Same brand only". Mixing
   *  voices across brands risks blurring @starter_story's style. */
  accountId: string;
  /** Source post type (where the original was published). */
  sourcePostType: PostType | string | null;
  /** Target post type (what we're drafting for). */
  targetPostType: PostType | string | null;
  /** Maximum number of pairs to return. Three is the default — enough
   *  for the agent to see a pattern without bloating the prompt. */
  limit?: number;
}

/**
 * Load the team's last N published cross-post pairs that match the
 * (sourcePostType, targetPostType) direction for the given account.
 * Returns at most `limit` rows ordered by the target post's publish
 * time, newest first. Returns [] when either post type is missing or
 * no pairs exist — caller should omit the prompt block in that case.
 *
 * Schema notes:
 * - `production_items.reposted_from_item_id` is the FK that links a
 *   cross-post target back to its source (set by the cross-post
 *   triage flow, indexed at `idx_production_items_reposted_from`).
 * - `source_type = 'cross_post'` distinguishes algorithm-generated
 *   targets from `repost` (same content reposted later) or `repurposed`.
 * - `content_body` is the body the upstream API returned at publish
 *   time — this is the *final, human-approved* text, post any editor
 *   edits. The draft text (pre-edit) lives in `content_drafts.content`
 *   but isn't what we want here.
 */
export async function loadPriorCrossPostExamples(
  opts: LoadPriorCrossPostExamplesOpts,
): Promise<PriorCrossPostExample[]> {
  if (!opts.sourcePostType || !opts.targetPostType) return [];
  const limit = opts.limit ?? 3;

  // Self-join: the same `productionItems` row pair as (target → source)
  // via reposted_from_item_id. Drizzle's `alias()` is the idiomatic
  // pattern for this in the repo — see `cross-post-feed-data.ts` for the
  // same shape (sourceItems vs target productionItems).
  const sourceItems = alias(productionItems, "source_items");
  const rows = await db
    .select({
      sourceText: sourceItems.contentBody,
      targetText: productionItems.contentBody,
      targetPublishedAt: productionItems.publishedAt,
    })
    .from(productionItems)
    .innerJoin(
      sourceItems,
      eq(sourceItems.id, productionItems.repostedFromItemId),
    )
    .where(
      and(
        eq(productionItems.sourceType, "cross_post"),
        eq(productionItems.status, "Published"),
        eq(productionItems.accountId, opts.accountId),
        eq(productionItems.postType, opts.targetPostType),
        eq(sourceItems.postType, opts.sourcePostType),
        isNotNull(productionItems.contentBody),
        isNotNull(sourceItems.contentBody),
      ),
    )
    .orderBy(desc(productionItems.publishedAt))
    .limit(limit);

  return rows
    .filter(
      (r): r is { sourceText: string; targetText: string; targetPublishedAt: Date | null } =>
        !!r.sourceText && !!r.targetText,
    )
    .map((r) => ({
      sourceText: r.sourceText.trim(),
      targetText: r.targetText.trim(),
      targetPublishedAt: r.targetPublishedAt
        ? r.targetPublishedAt.toISOString().slice(0, 10)
        : null,
    }));
}

/**
 * Render the loaded examples into the prompt block that lands in the
 * per-call payload. Returns null when there are no examples (caller
 * should omit the section entirely so the agent isn't told "no examples
 * exist" as an instruction it can't act on).
 */
export function renderPriorCrossPostExamples(
  examples: PriorCrossPostExample[],
  sourcePostType: string | null,
  targetPostType: string | null,
): string | null {
  if (examples.length === 0) return null;
  const directionLabel =
    sourcePostType && targetPostType
      ? `${sourcePostType} → ${targetPostType}`
      : "source → target";
  const header = `## PRIOR CROSS-POST EXAMPLES
Here are ${examples.length} real ${directionLabel} cross-posts the team has published. They are the team's own answer to how much editing this direction warrants. Match their level of editing: if these examples are near-verbatim, your output should be near-verbatim; if they restructure, you can restructure. These examples HARD-OVERRIDE the past-caption exemplars on rewrite aggressiveness — exemplars still teach voice and structure.`;
  const body = examples
    .map((ex, i) => {
      const dateMeta = ex.targetPublishedAt ? ` (${ex.targetPublishedAt})` : "";
      return `--- pair ${i + 1}${dateMeta} ---
SOURCE (${sourcePostType ?? "source"}):
${ex.sourceText}

ADAPTED TO (${targetPostType ?? "target"}):
${ex.targetText}`;
    })
    .join("\n\n");
  return `${header}\n\n${body}`;
}
