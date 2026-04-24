/**
 * Hook extraction — fills `production_items.hook` with the verbatim opening
 * line of each published short-form post. Mirrors the shape of the enrichment
 * orchestrator (see `src/lib/services/enrichment/orchestrator.ts`): candidate
 * selection + per-item worker + scheduled parent task.
 *
 * Why:
 * Clip-idea generation feeds "top-performing short-form clips brand-wide" as
 * LLM exemplars. Title is a weak proxy for the hook on items that came from
 * Notion / uploads / cross-posts. Having the actual verbatim opening line
 * turns that exemplar block into real training signal.
 *
 * Cost:
 * Haiku 4.5, ~200 tokens in + 50 out per item. ~$0.0005/item. The sweep
 * ordering prefers highest-view items first so the most-impactful exemplars
 * land in the prompt quickly.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";

const MODEL = "claude-haiku-4-5";
export const EXTRACTOR_VERSION = `${MODEL}:v1`;

/** Short-form post types that have a "stop-scroll" hook to extract.
 *  Gated on `post_type` (canonical) rather than the legacy `platform[]`
 *  label array — the latter silently misses rows written with the new
 *  `kind:@handle:subtype` account-based format. */
const SHORT_FORM_POST_TYPES = ["youtube_shorts", "instagram_reel", "tiktok"];

/** Per-sweep cap — matches enrichment. First sweep after deploy is largest. */
export const SWEEP_BATCH_LIMIT = 50;

/** Ignore transcripts shorter than this — publish glitches, silent videos. */
const MIN_DURATION_SEC = 5;
const MIN_WORD_COUNT = 3;

/** Feed only the opening window to Haiku — hooks live in seconds 0..~15. */
const HOOK_WINDOW_SEC = 20;

export async function selectHookCandidates(
  limit: number = SWEEP_BATCH_LIMIT
): Promise<string[]> {
  const rows = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .innerJoin(
      transcripts,
      eq(transcripts.productionItemId, productionItems.id)
    )
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNull(productionItems.hookExtractedAt),
        inArray(productionItems.postType, SHORT_FORM_POST_TYPES),
        sql`${transcripts.durationSec}::float >= ${MIN_DURATION_SEC}`,
        sql`COALESCE(${transcripts.wordCount}, 0) >= ${MIN_WORD_COUNT}`
      )
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(limit);

  return rows.map((r) => r.id);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verify the extractor returned a verbatim quote. Normalize both sides and
 * check for substring containment. Rejects hallucinated rewordings without a
 * fuzzy-matching dependency. Tightness is deliberate — Haiku is reliable at
 * "quote the first sentence"; a rejection means the extractor got creative,
 * which is exactly the failure mode we want to catch.
 */
export function isHookVerbatim(hook: string, fullText: string): boolean {
  const nh = normalize(hook);
  const nt = normalize(fullText);
  if (nh.length < 4) return false;
  return nt.includes(nh);
}

function formatSegments(
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

const tools: Anthropic.Tool[] = [
  {
    name: "return_hook",
    description:
      "Return the verbatim 1–2 sentence opening that functions as the hook — the words the viewer hears in the first few seconds.",
    input_schema: {
      type: "object" as const,
      properties: {
        hook: {
          type: "string",
          description:
            "VERBATIM text copied from the transcript cues. Do not paraphrase, do not fix grammar, do not add punctuation that isn't there. 1–2 sentences, typically 8–30 words.",
        },
      },
      required: ["hook"],
    },
  },
  {
    name: "no_clear_hook",
    description:
      "Use when the opening is pure filler (greetings, platform intros, silence, music-only) with no hook worth extracting.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "One sentence on why no hook is extractable.",
        },
      },
      required: ["reason"],
    },
  },
];

const SYSTEM_PROMPT = `You extract the HOOK from a short-form video transcript — the verbatim 1–2 sentence opening that stops the scroll.

Rules:
- The hook must be a VERBATIM, word-for-word quote from the cues provided. Never paraphrase, never rewrite, never merge sentences.
- Prefer the first attention-stopping sentence. Skip throat-clears, greetings ("hey guys", "what's up"), or platform intros ("welcome back to the channel"). Start on the substantive sentence the viewer would stop scrolling for.
- Typical hook length: 8–30 words, one or two sentences. Not a full paragraph.
- If the opening is pure filler and no hook is extractable, call no_clear_hook.

Never respond with plain text. Always call exactly one tool.`;

export interface ExtractHookResult {
  hook: string | null;
  skippedReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

async function callHaiku(
  cues: string
): Promise<ExtractHookResult> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    tools,
    tool_choice: { type: "any" },
    messages: [
      {
        role: "user",
        content: `Transcript cues (opening window):\n\n${cues}\n\nCall exactly one tool.`,
      },
    ],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    const input = block.input as { hook?: string; reason?: string };
    if (block.name === "return_hook") {
      const hook = typeof input.hook === "string" ? input.hook.trim() : "";
      if (hook.length === 0) {
        return {
          hook: null,
          skippedReason: "empty-hook",
          inputTokens,
          outputTokens,
        };
      }
      return { hook, skippedReason: null, inputTokens, outputTokens };
    }
    if (block.name === "no_clear_hook") {
      return {
        hook: null,
        skippedReason:
          typeof input.reason === "string" && input.reason.trim()
            ? input.reason.trim()
            : "no-clear-hook",
        inputTokens,
        outputTokens,
      };
    }
  }

  return {
    hook: null,
    skippedReason: "no-tool-call",
    inputTokens,
    outputTokens,
  };
}

/**
 * Extract and persist the hook for one production item. Idempotent on
 * `hookExtractedAt` — won't re-run a row that's already been processed. Safe
 * to retry on exception. Returns a short status so the task logger can
 * summarize.
 */
export async function extractHookForItem(
  productionItemId: string
): Promise<{ status: "ok" | "skipped" | "rejected" | "no-transcript"; note?: string }> {
  const [existing] = await db
    .select({
      id: productionItems.id,
      hook: productionItems.hook,
      hookExtractedAt: productionItems.hookExtractedAt,
      transcriptId: transcripts.id,
      fullText: transcripts.fullText,
      segments: transcripts.segments,
      durationSec: transcripts.durationSec,
      wordCount: transcripts.wordCount,
    })
    .from(productionItems)
    .leftJoin(
      transcripts,
      eq(transcripts.productionItemId, productionItems.id)
    )
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!existing) return { status: "skipped", note: "not-found" };
  if (existing.hookExtractedAt) {
    return { status: "skipped", note: "already-stamped" };
  }
  if (!existing.transcriptId || !existing.fullText || !existing.segments) {
    return { status: "no-transcript" };
  }

  const duration = Number(existing.durationSec ?? 0);
  if (duration < MIN_DURATION_SEC) {
    await db
      .update(productionItems)
      .set({
        hookExtractedAt: new Date(),
        hookSource: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, productionItemId));
    return { status: "skipped", note: "transcript-too-short" };
  }

  const cues = formatSegments(existing.segments, HOOK_WINDOW_SEC);
  if (cues.trim().length === 0) {
    await db
      .update(productionItems)
      .set({ hookExtractedAt: new Date(), updatedAt: new Date() })
      .where(eq(productionItems.id, productionItemId));
    return { status: "skipped", note: "no-cues-in-window" };
  }

  const result = await callHaiku(cues);

  if (!result.hook) {
    await db
      .update(productionItems)
      .set({
        hookExtractedAt: new Date(),
        hookExtractor: EXTRACTOR_VERSION,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, productionItemId));
    return {
      status: "skipped",
      note: result.skippedReason ?? "no-hook",
    };
  }

  if (!isHookVerbatim(result.hook, existing.fullText)) {
    await db
      .update(productionItems)
      .set({
        hookExtractedAt: new Date(),
        hookExtractor: EXTRACTOR_VERSION,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, productionItemId));
    return { status: "rejected", note: "not-verbatim" };
  }

  await db
    .update(productionItems)
    .set({
      hook: result.hook,
      hookSource: "llm",
      hookExtractor: EXTRACTOR_VERSION,
      hookExtractedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, productionItemId));

  return { status: "ok" };
}
