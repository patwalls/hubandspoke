/**
 * Unified hook dispatcher. ONE Haiku call per item sees every signal we have
 * (title, caption/body, transcript opener, poster image) and picks the best
 * hook with explicit source reasoning.
 *
 * Why:
 * Previously three sweeps ran in sequence (transcript LLM at :40, title/body
 * fallback at :50, vision overlay at :55) with a priority ladder. The ladder
 * got the wrong answer on Reels with designed overlay text — the transcript
 * sweep ran first and claimed the source, and the vision sweep's guard rails
 * refused to overwrite `hook_source='llm'`. Collapsing to one call lets the
 * model weigh all signals at once: for a Reel with "Bro built 28 apps in 28
 * weeks" painted on the cover, the overlay clearly wins.
 *
 * Write policy:
 * - `hook_source IN ('clip_idea','manual')` rows are untouchable (human picks
 *   always win)
 * - For everything else, the dispatcher is authoritative on first run
 *   (gated on `hook_extracted_at IS NULL`). Re-running requires clearing the
 *   timestamp, intentional.
 *
 * Cost:
 * ~$0.001/item (Haiku vision for items with a poster; Haiku text for text-
 * only posts). One call per item, cover description is a free side-effect
 * of the same call when vision-mode.
 */

import { and, eq, isNull, not, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";
import { openai } from "@/lib/openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

const MODEL = "gpt-4.1-mini";
export const DISPATCHER_VERSION = `dispatcher:${MODEL}:v1`;

export const DISPATCHER_BATCH_LIMIT = 50;

const POSTER_URL_TTL_SECONDS = 60 * 60;

const MAX_HOOK_CHARS = 240;
const MAX_DESCRIPTION_CHARS = 400;
/** Opening window we feed to the model. Enough for a verbatim hook but not
 *  so much that Haiku loses focus in a long transcript. */
const TRANSCRIPT_PREVIEW_CHARS = 600;
const TRANSCRIPT_SEGMENT_WINDOW_SEC = 20;
const BODY_PREVIEW_CHARS = 500;

/** Source the model chose; maps to the existing `hook_source` column
 *  vocabulary below so coverage/UI keep working unchanged. */
type DispatcherSource = "overlay" | "transcript" | "caption" | "title" | "none";

const SOURCE_TO_COLUMN: Record<Exclude<DispatcherSource, "none">, string> = {
  overlay: "overlay",
  transcript: "llm",
  caption: "content_body",
  title: "title",
};

export async function selectDispatcherCandidates(
  limit: number = DISPATCHER_BATCH_LIMIT
): Promise<string[]> {
  const rows = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNull(productionItems.hookExtractedAt),
        or(
          isNull(productionItems.hookSource),
          not(
            sql`${productionItems.hookSource} IN ('clip_idea', 'manual')`
          )
        )
      )
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(limit);

  return rows.map((r) => r.id);
}

function formatTranscriptSegments(
  segments: Array<{ startSec: number; endSec: number; text: string; speaker?: string }>,
  windowSec: number
): string {
  return segments
    .filter((s) => s.startSec < windowSec)
    .map((s) => {
      const mm = Math.floor(s.startSec / 60)
        .toString()
        .padStart(2, "0");
      const ss = Math.floor(s.startSec % 60)
        .toString()
        .padStart(2, "0");
      return s.speaker
        ? `[${mm}:${ss}] ${s.speaker}: ${s.text}`
        : `[${mm}:${ss}] ${s.text}`;
    })
    .join("\n");
}

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "return_hook",
      description:
        "Return the best hook for this post. Pick exactly one source and quote verbatim.",
      parameters: {
        type: "object",
        properties: {
          hook: {
            type: ["string", "null"],
            description:
              "The hook text, VERBATIM from whichever source you picked. No paraphrasing, no fixing typos, no adding punctuation. 1–2 sentences, typically 6–30 words. Null if source='none'.",
          },
          source: {
            type: "string",
            enum: ["overlay", "transcript", "caption", "title", "none"],
            description:
              "Which signal the hook came from. 'overlay' = designed text burned into the cover image (Reels/Shorts/TikTok bar text). 'transcript' = first scroll-stopping sentence in the spoken transcript. 'caption' = first sentence of post body/caption (tweets, IG posts). 'title' = post title (YouTube long, newsletter). 'none' = no good hook available.",
          },
          cover_description: {
            type: ["string", "null"],
            description:
              "One-sentence description of the cover image — who/what is shown, composition, any graphic treatment. Null if no image was provided.",
          },
          reasoning: {
            type: "string",
            description:
              "One short sentence explaining why this source was picked.",
          },
        },
        required: ["hook", "source", "cover_description", "reasoning"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const SYSTEM_PROMPT = `You pick THE HOOK for a social media post — the first thing that stops the scroll.

You receive every signal we have about the post: post type, title, caption/body, transcript opener, and (for video/image posts) the cover image itself. Choose ONE source and quote it verbatim.

Rules in order:
1. **Verbatim always.** Never paraphrase, never fix grammar, never merge sentences. Copy exactly what exists in the source.
2. **For short-form video with designed overlay text** (Reels, Shorts, TikTok — bold caption/bar text painted onto the cover), the overlay IS the hook. Return the overlay text, source='overlay'. Ignore small platform chrome (view counts, watermarks, handles in corners).
3. **For long-form YouTube videos**, the title is usually the hook (that's what gets clicked). Use source='title' unless the thumbnail has substantive overlay text that adds meaning beyond the title.
4. **For podcast/interview video** (no overlay text, talking-head cover), the first scroll-stopping sentence of the transcript is the hook. Skip greetings ("hey guys", "welcome back") and platform intros. Source='transcript'.
5. **For text-only posts** (tweets, IG posts/stories without video, LinkedIn, Threads), the first sentence of the caption/body is the hook. Source='caption'. Fall back to title if the body is empty.
6. **For newsletters**, the subject line (title) is the hook. Source='title'.
7. **If nothing is a usable hook** (platform-chrome only, silent/empty content, unreadable image), return source='none' with a reason.

Also provide a one-sentence cover_description when an image is present — who/what is shown and composition. Used for search and training, independent of the hook.

Never respond with plain text. Always call the return_hook tool exactly once.`;

export interface DispatchResult {
  status: "ok" | "skipped" | "no-signals";
  hook: string | null;
  source: DispatcherSource;
  coverDescription: string | null;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
}

interface ItemSignals {
  title: string | null;
  contentBody: string | null;
  postType: string | null;
  posterImageUrl: string | null;
  transcriptFullText: string | null;
  transcriptSegmentsPreview: string | null;
}

function buildUserMessage(signals: ItemSignals): string {
  const lines: string[] = [];
  lines.push(`post_type: ${signals.postType ?? "(unknown)"}`);
  lines.push(`title: ${signals.title ?? "(none)"}`);
  if (signals.contentBody && signals.contentBody.trim().length > 0) {
    const body = signals.contentBody.slice(0, BODY_PREVIEW_CHARS);
    lines.push(`caption / body (first ${BODY_PREVIEW_CHARS} chars):\n${body}`);
  } else {
    lines.push("caption / body: (none)");
  }
  if (signals.transcriptSegmentsPreview) {
    lines.push(
      `transcript opener (first ${TRANSCRIPT_SEGMENT_WINDOW_SEC}s with timestamps):\n${signals.transcriptSegmentsPreview}`
    );
  } else if (signals.transcriptFullText) {
    const preview = signals.transcriptFullText.slice(0, TRANSCRIPT_PREVIEW_CHARS);
    lines.push(`transcript preview:\n${preview}`);
  } else {
    lines.push("transcript: (none)");
  }
  return `${lines.join(
    "\n\n"
  )}\n\nPick the best hook and call return_hook.`;
}

async function callLLM(signals: ItemSignals): Promise<DispatchResult> {
  const userText = buildUserMessage(signals);

  const content: ChatCompletionContentPart[] = [];
  if (signals.posterImageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: signals.posterImageUrl },
    });
  }
  content.push({ type: "text", text: userText });

  const response = await openai().chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    tools,
    tool_choice: { type: "function", function: { name: "return_hook" } },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
  });

  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  const message = response.choices[0]?.message;
  for (const call of message?.tool_calls ?? []) {
    if (call.type !== "function" || call.function.name !== "return_hook") continue;
    let input: {
      hook?: string | null;
      source?: string;
      cover_description?: string | null;
      reasoning?: string;
    };
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      continue;
    }
    const source = (input.source ?? "none") as DispatcherSource;
    const rawHook = typeof input.hook === "string" ? input.hook.trim() : null;
    const hook =
      source === "none" || !rawHook
        ? null
        : rawHook.slice(0, MAX_HOOK_CHARS);
    const coverDescription =
      typeof input.cover_description === "string"
        ? input.cover_description.trim().slice(0, MAX_DESCRIPTION_CHARS) ||
          null
        : null;
    const reasoning =
      typeof input.reasoning === "string" ? input.reasoning.trim() : "";

    return {
      status: hook ? "ok" : "skipped",
      hook,
      source,
      coverDescription,
      reasoning,
      inputTokens,
      outputTokens,
    };
  }

  return {
    status: "skipped",
    hook: null,
    source: "none",
    coverDescription: null,
    reasoning: "no-tool-call",
    inputTokens,
    outputTokens,
  };
}

/**
 * Pick the best hook for a single item. Idempotent on `hook_extracted_at`.
 * Never overwrites `clip_idea` or `manual` sources.
 */
export async function dispatchHookForItem(
  productionItemId: string
): Promise<{
  status: "ok" | "skipped" | "protected" | "no-signals";
  source?: string;
  note?: string;
}> {
  const [existing] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      contentBody: productionItems.contentBody,
      postType: productionItems.postType,
      posterS3Key: productionItems.posterS3Key,
      hookSource: productionItems.hookSource,
      hookExtractedAt: productionItems.hookExtractedAt,
      transcriptFullText: transcripts.fullText,
      transcriptSegments: transcripts.segments,
    })
    .from(productionItems)
    .leftJoin(
      transcripts,
      eq(transcripts.productionItemId, productionItems.id)
    )
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!existing) return { status: "skipped", note: "not-found" };
  if (
    existing.hookSource === "clip_idea" ||
    existing.hookSource === "manual"
  ) {
    return { status: "protected", note: existing.hookSource };
  }
  if (existing.hookExtractedAt) {
    return { status: "skipped", note: "already-stamped" };
  }

  const hasTitle = !!existing.title?.trim();
  const hasBody = !!existing.contentBody?.trim();
  const hasTranscript = !!existing.transcriptFullText?.trim();
  const hasPoster = !!existing.posterS3Key;

  if (!hasTitle && !hasBody && !hasTranscript && !hasPoster) {
    const now = new Date();
    await db
      .update(productionItems)
      .set({
        hookExtractedAt: now,
        hookExtractor: DISPATCHER_VERSION,
        updatedAt: now,
      })
      .where(eq(productionItems.id, productionItemId));
    return { status: "no-signals", note: "no-signals" };
  }

  const posterImageUrl = existing.posterS3Key
    ? await getPresignedGetUrl(existing.posterS3Key, POSTER_URL_TTL_SECONDS)
    : null;

  const transcriptSegmentsPreview = existing.transcriptSegments
    ? formatTranscriptSegments(
        existing.transcriptSegments,
        TRANSCRIPT_SEGMENT_WINDOW_SEC
      )
    : null;

  const result = await callLLM({
    title: existing.title,
    contentBody: existing.contentBody,
    postType: existing.postType,
    posterImageUrl,
    transcriptFullText: existing.transcriptFullText,
    transcriptSegmentsPreview:
      transcriptSegmentsPreview && transcriptSegmentsPreview.trim().length > 0
        ? transcriptSegmentsPreview
        : null,
  });

  const now = new Date();
  const updates: Partial<typeof productionItems.$inferInsert> = {
    hookExtractedAt: now,
    hookExtractor: DISPATCHER_VERSION,
    updatedAt: now,
  };
  if (result.coverDescription) {
    updates.coverDescription = result.coverDescription;
    updates.visionExtractedAt = now;
  } else if (posterImageUrl) {
    updates.visionExtractedAt = now;
  }
  if (result.hook && result.source !== "none") {
    updates.hook = result.hook;
    updates.hookSource = SOURCE_TO_COLUMN[result.source];
    // When the LLM identifies designed overlay text, persist it to the
    // dedicated `overlay` column too — same string, but lets downstream
    // queries answer "does this clip have a burn-in overlay?" without
    // having to inspect hook_source.
    if (result.source === "overlay") {
      updates.overlay = result.hook;
    }
  }

  await db
    .update(productionItems)
    .set(updates)
    .where(eq(productionItems.id, productionItemId));

  return {
    status: result.hook ? "ok" : "skipped",
    source: result.source,
    note: result.reasoning || undefined,
  };
}
