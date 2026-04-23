/**
 * Fallback hook populator for post types the LLM sweep doesn't cover (or for
 * short-form items that lack a transcript the LLM sweep needs). The LLM
 * orchestrator in `./orchestrator.ts` handles Shorts/Reels/TikTok with a
 * transcript; this fills in the rest using title or first-sentence-of-body.
 *
 * Writes `hookSource='title' | 'content_body'` and `hookExtractor='fallback:v1'`
 * so the coverage page can show per-source breakdown. Gated on
 * `hookExtractedAt IS NULL` so we never override an LLM/manual/clip-idea hook.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";

export const FALLBACK_EXTRACTOR = "fallback:v1";

/** Post types where the title IS the hook (YouTube thumbnail title,
 *  newsletter subject line). */
const TITLE_POST_TYPES = ["youtube_long", "youtube_community", "newsletter"];

/** Post types where the first sentence of the post body is the hook, with
 *  title as a fallback if the body is empty. Shorts/reel/tiktok are here so
 *  items lacking a transcript (skipped by the LLM sweep) still get a hook
 *  from their caption. */
const BODY_POST_TYPES = [
  "x",
  "tiktok",
  "threads",
  "linkedin",
  "instagram_post",
  "instagram_story",
  "instagram_reel",
  "youtube_shorts",
];

const FALLBACK_POST_TYPES = [...TITLE_POST_TYPES, ...BODY_POST_TYPES];

export const FALLBACK_SWEEP_BATCH_LIMIT = 200;

const MAX_HOOK_CHARS = 240;

export async function selectHookFallbackCandidates(
  limit: number = FALLBACK_SWEEP_BATCH_LIMIT
): Promise<string[]> {
  const rows = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNull(productionItems.hook),
        isNull(productionItems.hookExtractedAt),
        inArray(productionItems.postType, FALLBACK_POST_TYPES)
      )
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(limit);

  return rows.map((r) => r.id);
}

/** First 1–2 sentences of `text`, capped at MAX_HOOK_CHARS. Splits on
 *  sentence boundaries; if the first sentence already exceeds the cap, hard
 *  slices. */
export function firstSentences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= MAX_HOOK_CHARS) return trimmed;
  const parts = trimmed.split(/(?<=[.!?])\s+/);
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    if (out.length + parts[i].length + 1 > MAX_HOOK_CHARS) break;
    out = `${out} ${parts[i]}`;
  }
  return out.length > MAX_HOOK_CHARS ? out.slice(0, MAX_HOOK_CHARS).trim() : out;
}

export async function applyFallbackHookForItem(
  productionItemId: string
): Promise<{
  status: "ok" | "skipped";
  source: "title" | "content_body" | null;
  note?: string;
}> {
  const [row] = await db
    .select({
      id: productionItems.id,
      postType: productionItems.postType,
      title: productionItems.title,
      contentBody: productionItems.contentBody,
      hook: productionItems.hook,
      hookExtractedAt: productionItems.hookExtractedAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!row) return { status: "skipped", source: null, note: "not-found" };
  if (row.hook || row.hookExtractedAt) {
    return { status: "skipped", source: null, note: "already-stamped" };
  }

  const preferBody = BODY_POST_TYPES.includes(row.postType ?? "");
  let hook: string | null = null;
  let source: "title" | "content_body" | null = null;

  if (preferBody && row.contentBody && row.contentBody.trim().length > 0) {
    hook = firstSentences(row.contentBody);
    source = "content_body";
  }
  if (!hook && row.title && row.title.trim().length > 0) {
    hook = row.title.trim().slice(0, MAX_HOOK_CHARS);
    source = "title";
  }

  const now = new Date();
  if (!hook) {
    await db
      .update(productionItems)
      .set({
        hookExtractedAt: now,
        hookExtractor: FALLBACK_EXTRACTOR,
        updatedAt: now,
      })
      .where(eq(productionItems.id, productionItemId));
    return { status: "skipped", source: null, note: "no-text" };
  }

  await db
    .update(productionItems)
    .set({
      hook,
      hookSource: source,
      hookExtractor: FALLBACK_EXTRACTOR,
      hookExtractedAt: now,
      updatedAt: now,
    })
    .where(eq(productionItems.id, productionItemId));

  return { status: "ok", source };
}
