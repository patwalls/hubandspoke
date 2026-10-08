/**
 * Visual hook extractor — reads the on-screen text painted into the cover
 * image (Reels/IG posts/Shorts/TikTok/YT thumbnails) and also returns a
 * one-sentence description of the cover for search / training data.
 *
 * Why:
 * For short-form covers with designed overlay text ("Bro built 28 apps in 28
 * weeks and made $10,000") the on-screen text IS the hook. Neither the
 * transcript LLM sweep (sees the spoken opener) nor the title/body fallback
 * captures it. This sweep fills the gap.
 *
 * Cost:
 * Haiku 5.5 vision, well under $0.001/image. One call returns both fields. Gated on
 * visionExtractedAt IS NULL so it runs once per item.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";
import Anthropic from "@anthropic-ai/sdk";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

const MODEL = "claude-haiku-5-5";
export const VISION_EXTRACTOR_VERSION = `vision:${MODEL}:v1`;

/** Post types whose cover image is meaningful (designed overlay, thumbnail
 *  text, or at least visual context). Text-only platforms (tweets, threads,
 *  linkedin, newsletter) are skipped — nothing to look at. */
const VISION_POST_TYPES = [
  "instagram_reel",
  "instagram_post",
  "instagram_story",
  "tiktok",
  "youtube_shorts",
  "youtube_long",
];

export const VISION_SWEEP_BATCH_LIMIT = 50;

/** Match S3 keys the vision model will actually accept. The full set of
 *  "still image" extensions includes heic/heif/avif (iPhone-shot originals,
 *  modern web exports), but vision APIs (OpenAI then, Claude now) only take
 *  png / jpeg / gif / webp — see HUBANDSPOKE-V, 179 events in 8 min when an
 *  iPhone HEIC poster slipped through the old
 *  jpeg|png|webp|gif|heic|heif|avif allow-list. Any conversion step
 *  (Sharp / sips) would belong in enrichment, not here. */
export const IMAGE_KEY_RE = /\.(jpe?g|png|webp|gif)$/i;

export function isLikelyImageKey(key: string): boolean {
  // Strip query string just in case (presigned URLs aren't passed here, but
  // be safe).
  const base = key.split("?")[0] ?? key;
  return IMAGE_KEY_RE.test(base);
}

/** TTL for the presigned poster URL we download the image from. Short is
 *  fine — we fetch it immediately. */
const POSTER_URL_TTL_SECONDS = 5 * 60;

/** Claude's per-image cap. Larger posters are skipped, not retried. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_MEDIA_TYPES: Record<
  string,
  Anthropic.Base64ImageSource["media_type"]
> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Download a poster from S3 and wrap it as a base64 image block. We send
 * bytes rather than the presigned URL so the call doesn't depend on
 * Anthropic's fetcher reaching S3. Returns `{ skip }` for permanent
 * problems (unsupported extension, missing object, over the size cap) so
 * callers can stamp and move on; network/5xx errors throw for a retry.
 * Shared with `dispatcher.ts`.
 */
export async function loadPosterImageBlock(
  posterS3Key: string
): Promise<{ block: Anthropic.ImageBlockParam } | { skip: string }> {
  const base = posterS3Key.split("?")[0] ?? posterS3Key;
  const mediaType = IMAGE_MEDIA_TYPES[base.split(".").pop()?.toLowerCase() ?? ""];
  if (!mediaType) return { skip: "non-image-poster" };

  const url = await getPresignedGetUrl(posterS3Key, POSTER_URL_TTL_SECONDS);
  const res = await fetch(url);
  if (res.status === 403 || res.status === 404) {
    return { skip: `poster-fetch-${res.status}` };
  }
  if (!res.ok) throw new Error(`poster fetch failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) return { skip: "poster-too-large" };

  return {
    block: {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
    },
  };
}

const MAX_HOOK_CHARS = 240;
const MAX_DESCRIPTION_CHARS = 400;

/** Sources that vision may OVERWRITE on the hook column — weaker signals
 *  the vision sweep is an upgrade over. LLM / clip_idea / manual sources
 *  remain untouched. */
const OVERWRITABLE_HOOK_SOURCES: Array<string | null> = [
  null,
  "title",
  "content_body",
];

export async function selectVisionCandidates(
  limit: number = VISION_SWEEP_BATCH_LIMIT
): Promise<string[]> {
  const rows = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNull(productionItems.visionExtractedAt),
        isNotNull(productionItems.posterS3Key),
        inArray(productionItems.postType, VISION_POST_TYPES)
      )
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(limit);

  return rows.map((r) => r.id);
}

const tools: Anthropic.Tool[] = [
  {
    name: "return_cover_analysis",
    description:
      "Return the on-screen hook text and a one-sentence description of the cover image.",
    input_schema: {
      type: "object" as const,
      properties: {
        hook: {
          type: ["string", "null"],
          description:
            "VERBATIM on-screen text from the cover — the bold overlay, bar text, or caption burn-in designed as the hook. Copy exactly what is painted on the image (keep punctuation/emojis but drop small platform chrome like view counts or handles). If there is no scroll-stopping overlay text, pass null. Never invent words that aren't visibly on the image.",
        },
        cover_description: {
          type: "string",
          description:
            "One sentence describing what the cover looks like: who/what is shown, composition (split-screen, close-up, text-only), any graphic treatment. Used for search + training data.",
        },
      },
      required: ["hook", "cover_description"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "no_clear_cover",
    description:
      "Use only when the image is unreadable / failed to load / is not a real content cover. Still describe whatever you can see.",
    input_schema: {
      type: "object" as const,
      properties: {
        cover_description: {
          type: "string",
          description: "Brief note on what's visible, even if low-quality.",
        },
        reason: {
          type: "string",
          description: "One sentence on why no hook is extractable.",
        },
      },
      required: ["cover_description", "reason"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const SYSTEM_PROMPT = `You analyze the cover image of a short-form social post.

Return TWO things via the return_cover_analysis tool:

1. hook: the verbatim on-screen hook text if the cover has designed overlay text (bold caption, bar text, burn-in). Copy exactly — do not paraphrase, do not fix typos, do not add punctuation. If there is no overlay text (plain talking-head, product photo with no words, platform UI only), pass null. Ignore small platform chrome like view counts, mute icons, handles at the corners. Hooks are typically 3–20 words.

2. cover_description: one sentence describing the cover — who/what is shown, composition (split-screen, close-up), any graphic treatment. 10–30 words.

Never respond with plain text. Always call exactly one tool.`;

export interface VisionResult {
  hook: string | null;
  coverDescription: string | null;
  skippedReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

function skipped(reason: string): VisionResult {
  return {
    hook: null,
    coverDescription: null,
    skippedReason: reason,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function callVisionLLM(
  image: Anthropic.ImageBlockParam
): Promise<VisionResult> {
  let response;
  try {
    response = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: "any" },
      messages: [
        {
          role: "user",
          content: [
            image,
            { type: "text", text: "Analyze this cover. Call exactly one tool." },
          ],
        },
      ],
    });
  } catch (err) {
    // 400s from vision are permanent (unsupported format, broken image,
    // dimensions out of range). Treat as a skipped extraction so the caller
    // stamps visionExtractedAt and we don't burn retries.
    if (err instanceof Anthropic.BadRequestError) {
      return skipped(`vision-400:${err.message.slice(0, 200)}`);
    }
    throw err;
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  for (const call of response.content) {
    if (call.type !== "tool_use") continue;
    const input = call.input as {
      hook?: string | null;
      cover_description?: string;
      reason?: string;
    };
    const description =
      typeof input.cover_description === "string"
        ? input.cover_description.trim().slice(0, MAX_DESCRIPTION_CHARS)
        : null;

    if (call.name === "return_cover_analysis") {
      const hookRaw =
        typeof input.hook === "string" ? input.hook.trim() : null;
      const hook =
        hookRaw && hookRaw.length > 0
          ? hookRaw.slice(0, MAX_HOOK_CHARS)
          : null;
      return {
        hook,
        coverDescription: description,
        skippedReason: hook ? null : "no-overlay-text",
        inputTokens,
        outputTokens,
      };
    }
    if (call.name === "no_clear_cover") {
      return {
        hook: null,
        coverDescription: description,
        skippedReason:
          typeof input.reason === "string" && input.reason.trim()
            ? input.reason.trim()
            : "no-clear-cover",
        inputTokens,
        outputTokens,
      };
    }
  }

  return {
    hook: null,
    coverDescription: null,
    skippedReason: "no-tool-call",
    inputTokens,
    outputTokens,
  };
}

/**
 * Extract and persist vision data for one production item. Idempotent on
 * `visionExtractedAt`. Always writes cover_description when the model
 * returns one. Writes hook only when the current hook_source is weaker
 * than 'vision' (null, 'title', 'content_body').
 */
export async function extractVisionForItem(
  productionItemId: string
): Promise<{
  status: "ok" | "skipped" | "no-poster";
  note?: string;
  upgradedHook?: boolean;
}> {
  const [existing] = await db
    .select({
      id: productionItems.id,
      posterS3Key: productionItems.posterS3Key,
      hookSource: productionItems.hookSource,
      hook: productionItems.hook,
      overlay: productionItems.overlay,
      coverDescription: productionItems.coverDescription,
      visionExtractedAt: productionItems.visionExtractedAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!existing) return { status: "skipped", note: "not-found" };
  if (existing.visionExtractedAt) {
    return { status: "skipped", note: "already-stamped" };
  }
  if (!existing.posterS3Key) {
    return { status: "no-poster" };
  }
  // Defensive: legacy rows can have a video key in posterS3Key (the media
  // route used to fall back to s3Key for video slides). Vision can't read an
  // mp4 — the vision API returns a 400 that the SDK auto-captures to Sentry — so
  // skip and stamp instead of burning the API call.
  if (!isLikelyImageKey(existing.posterS3Key)) {
    const now = new Date();
    await db
      .update(productionItems)
      .set({ visionExtractedAt: now, updatedAt: now })
      .where(eq(productionItems.id, productionItemId));
    return { status: "skipped", note: "non-image-poster" };
  }

  const image = await loadPosterImageBlock(existing.posterS3Key);
  const result =
    "block" in image ? await callVisionLLM(image.block) : skipped(image.skip);
  const now = new Date();

  const canUpgradeHook =
    OVERWRITABLE_HOOK_SOURCES.includes(existing.hookSource ?? null) &&
    !!result.hook;

  const updates: Partial<typeof productionItems.$inferInsert> = {
    visionExtractedAt: now,
    updatedAt: now,
  };
  if (result.coverDescription) {
    updates.coverDescription = result.coverDescription;
  }
  if (canUpgradeHook) {
    updates.hook = result.hook;
    updates.hookSource = "vision";
    updates.hookExtractor = VISION_EXTRACTOR_VERSION;
    updates.hookExtractedAt = now;
    // Vision-extracted hook IS overlay text by definition (we asked the LLM
    // for "VERBATIM on-screen text" only). Mirror to the dedicated column so
    // analytics/queries can find overlay-bearing clips without parsing
    // hook_source.
    updates.overlay = result.hook;
  }

  await db
    .update(productionItems)
    .set(updates)
    .where(eq(productionItems.id, productionItemId));

  // Audit hook / overlay / coverDescription changes from this vision pass.
  // Each emitted under the `vision-extractor` algorithm so the activity
  // feed can show "Vision Extractor wrote overlay text" alongside the
  // human edits. Best-effort.
  try {
    const visionChanges: ContentChange[] = [];
    if (updates.hook !== undefined && updates.hook !== existing.hook) {
      visionChanges.push({
        target: { kind: "production_item_field", field: "hook" },
        from: existing.hook ?? null,
        to: (updates.hook ?? null) as string | null,
      });
    }
    if (updates.overlay !== undefined && updates.overlay !== existing.overlay) {
      visionChanges.push({
        target: { kind: "production_item_field", field: "overlay" },
        from: existing.overlay ?? null,
        to: (updates.overlay ?? null) as string | null,
      });
    }
    if (
      updates.coverDescription !== undefined &&
      updates.coverDescription !== existing.coverDescription
    ) {
      visionChanges.push({
        target: { kind: "production_item_field", field: "coverDescription" },
        from: existing.coverDescription ?? null,
        to: (updates.coverDescription ?? null) as string | null,
      });
    }
    if (visionChanges.length > 0) {
      await recordContentChanges({
        tx: db,
        contentItemId: productionItemId,
        userId: null,
        source: { kind: "algorithm", name: "vision-extractor" },
        changes: visionChanges,
      });
    }
  } catch (err) {
    console.error(
      `[vision-extract] audit emit failed for item=${productionItemId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  if (canUpgradeHook) {
    return { status: "ok", upgradedHook: true };
  }
  if (result.hook && !canUpgradeHook) {
    return {
      status: "ok",
      note: `hook-kept-existing:${existing.hookSource}`,
      upgradedHook: false,
    };
  }
  return {
    status: "skipped",
    note: result.skippedReason ?? "no-hook",
    upgradedHook: false,
  };
}
