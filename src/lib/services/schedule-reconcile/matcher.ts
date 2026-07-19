// Best-guess matcher for the schedule-reconcile sweep. Given a Scheduled
// planning item, find the newly-synced Published post that most likely IS
// that post going live.
//
// Two stages:
//   1. Structural candidate gate (cheap SQL) — same account, Published,
//      synced-origin, published within the item's scheduling window, same
//      post_type when known. Usually 0–3 rows.
//   2. LLM scorer (gpt-4.1-mini, single pinned tool, fail-soft) — reads the plan
//      (title / hook / body) against each candidate's real title / caption
//      and the publish-time proximity, and returns the best match index +
//      a 0–100 confidence. Content-meaning judgement is the LLM's job, not
//      string distance (per the no-regex-on-free-form-copy rule); structural
//      proximity is fed in as context.
//
// Mirrors the template at draft-algorithm/derivative-hook.ts.

import type OpenAI from "openai";
import { and, eq, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { openai } from "@/lib/openai";
import { productionItems, scheduledMatchSuggestions } from "@/lib/db/schema";

const MODEL = "gpt-4.1-mini";
export const SCHEDULE_MATCHER_VERSION = `${MODEL}:schedule-match:v1`;

// Look at most this many recent candidates — the gate already narrows hard,
// but cap so a chaotic account can't blow up the prompt.
const MAX_CANDIDATES = 8;
// Synced-origin rows only. A "repost" of a repost is not an original go-live,
// and other Scheduled/Idea planning rows must never be treated as candidates.
const SYNCED_SOURCE_TYPES = ["original", "cross_post", "repurposed"] as const;
// Grace before scheduledAt: a post can go live a touch before the operator
// flipped the status to Scheduled (they schedule first, then mark it here).
const PRE_SCHEDULE_GRACE_MS = 60 * 60 * 1000; // 1h
const BODY_CHAR_BUDGET = 2_000;

export interface ScheduledItemForMatch {
  id: string;
  accountId: string;
  postType: string | null;
  title: string | null;
  hook: string | null;
  contentBody: string | null;
  scheduledAt: Date;
  expectedPublishAt: Date | null;
}

export interface MatchCandidate {
  id: string;
  title: string | null;
  hook: string | null;
  contentBody: string | null;
  publishedLink: string | null;
  publishedAt: Date | null;
  publishedDate: string | null;
  postType: string | null;
  thumbnail: string | null;
}

export type ScheduleMatchFailure =
  | { reason: "llm-empty" }
  | { reason: "llm-error"; message: string };

export type ScheduleMatchResult =
  | { ok: true; value: { candidateId: string; score: number; reason: string } | null }
  | { ok: false; failure: ScheduleMatchFailure };

const SYSTEM_PROMPT = `You decide whether a freshly-published social post is the same post that a content operator had PLANNED and marked "Scheduled".

You are given ONE plan and a numbered list of CANDIDATE live posts (all from the same account, all published around the scheduled time). Exactly one candidate might be the plan going live — or none of them are.

Judge on MEANING, not surface string overlap:
- Same core subject / hook / story being told?
- Same format and angle?
- Does the publish timing line up with when the operator expected it to go live?

A candidate is only a match if you're genuinely convinced it's the same post. Two different posts from the same creator on the same day are NOT a match just because they share a topic. When unsure, prefer NO match (match_index 0) over a wrong tie.

Confidence scale:
- 85–100: clearly the same post (near-identical hook/subject, timing fits).
- 55–84: probably the same, but some doubt (paraphrased, partial signal).
- 1–54: weak/uncertain — report it but it won't auto-apply.
- match_index 0: none of the candidates is this post.

Never respond with plain text. Always call return_match exactly once.`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "return_match",
      description:
        "Return which candidate (if any) is the scheduled post going live, with a confidence score.",
      parameters: {
        type: "object" as const,
        properties: {
          match_index: {
            type: "integer",
            description:
              "The 1-based index of the candidate that is the same post as the plan. Use 0 if none of the candidates is the scheduled post.",
          },
          confidence: {
            type: "integer",
            description:
              "0–100 confidence that the chosen candidate is the same post. Use 0 when match_index is 0.",
          },
          reason: {
            type: "string",
            description:
              "One short sentence explaining the decision (what matched or why nothing did).",
          },
        },
        required: ["match_index", "confidence", "reason"],
      },
    },
  },
];

/**
 * Structural candidate gate. Returns recent Published, synced-origin posts on
 * the same account that fall inside the item's scheduling window and match
 * its post_type (when known), excluding any pair the operator already
 * rejected for this scheduled item.
 */
export async function loadMatchCandidates(
  item: ScheduledItemForMatch,
): Promise<MatchCandidate[]> {
  const windowStart = new Date(item.scheduledAt.getTime() - PRE_SCHEDULE_GRACE_MS);

  // Pairs this operator already rejected — never re-surface them.
  const rejected = await db
    .select({ candidateItemId: scheduledMatchSuggestions.candidateItemId })
    .from(scheduledMatchSuggestions)
    .where(
      and(
        eq(scheduledMatchSuggestions.scheduledItemId, item.id),
        eq(scheduledMatchSuggestions.status, "rejected"),
      ),
    );
  const rejectedIds = new Set(rejected.map((r) => r.candidateItemId));

  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      hook: productionItems.hook,
      contentBody: productionItems.contentBody,
      publishedLink: productionItems.publishedLink,
      publishedAt: productionItems.publishedAt,
      publishedDate: productionItems.publishedDate,
      postType: productionItems.postType,
      thumbnail: productionItems.thumbnail,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.accountId, item.accountId),
        eq(productionItems.status, "Published"),
        sql`${productionItems.deletedAt} IS NULL`,
        ne(productionItems.id, item.id),
        sql`${productionItems.sourceType} IN ('original', 'cross_post', 'repurposed')`,
        isNotNull(productionItems.publishedAt),
        gte(productionItems.publishedAt, windowStart),
        lte(productionItems.publishedAt, new Date()),
        // post_type gate: skip when either side is unknown.
        item.postType
          ? sql`(${productionItems.postType} IS NULL OR ${productionItems.postType} = ${item.postType})`
          : undefined,
      ),
    )
    .orderBy(sql`${productionItems.publishedAt} DESC`)
    .limit(MAX_CANDIDATES + rejectedIds.size);

  return rows.filter((r) => !rejectedIds.has(r.id)).slice(0, MAX_CANDIDATES);
}

function clip(text: string | null | undefined): string {
  if (!text) return "";
  const t = text.trim();
  return t.length <= BODY_CHAR_BUDGET ? t : t.slice(0, BODY_CHAR_BUDGET);
}

function hoursBetween(a: Date, b: Date): string {
  const h = Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60);
  return `${h.toFixed(1)}h`;
}

function renderPlan(item: ScheduledItemForMatch): string {
  const ref = item.expectedPublishAt ?? item.scheduledAt;
  const refLabel = item.expectedPublishAt
    ? "expected go-live"
    : "scheduled at";
  return [
    `## THE PLAN (a post the operator scheduled)`,
    `Post type: ${item.postType ?? "unknown"}`,
    `${refLabel}: ${ref.toISOString()}`,
    `Title / overlay: ${clip(item.title) || "(none)"}`,
    `Hook: ${clip(item.hook) || "(none)"}`,
    `Planned body: ${clip(item.contentBody) || "(none)"}`,
  ].join("\n");
}

function renderCandidates(
  item: ScheduledItemForMatch,
  candidates: MatchCandidate[],
): string {
  const ref = item.expectedPublishAt ?? item.scheduledAt;
  const blocks = candidates.map((c, i) => {
    const delta = c.publishedAt
      ? `${hoursBetween(c.publishedAt, ref)} from ${
          item.expectedPublishAt ? "expected go-live" : "scheduled time"
        }`
      : "unknown publish time";
    return [
      `### Candidate ${i + 1}`,
      `Post type: ${c.postType ?? "unknown"}`,
      `Published: ${c.publishedAt?.toISOString() ?? c.publishedDate ?? "unknown"} (${delta})`,
      `Title: ${clip(c.title) || "(none)"}`,
      `Hook: ${clip(c.hook) || "(none)"}`,
      `Caption / body: ${clip(c.contentBody) || "(none)"}`,
    ].join("\n");
  });
  return `## CANDIDATE LIVE POSTS\n${blocks.join("\n\n")}`;
}

/**
 * Score the candidates and return the single best match (or null when none
 * is convincing / there are no candidates). Fail-soft: an LLM error returns
 * `{ ok: false }` and the caller treats the tick as a no-match (retry next).
 */
export async function findBestScheduledMatch(
  item: ScheduledItemForMatch,
  opts: { client?: OpenAI; candidates?: MatchCandidate[] } = {},
): Promise<ScheduleMatchResult> {
  const candidates = opts.candidates ?? (await loadMatchCandidates(item));
  if (candidates.length === 0) {
    return { ok: true, value: null };
  }

  const client = opts.client ?? openai();

  const userText = [
    renderPlan(item),
    renderCandidates(item, candidates),
    "Decide now. Call return_match exactly once.",
  ].join("\n\n");

  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 256,
      tools: TOOLS,
      tool_choice: { type: "function", function: { name: "return_match" } },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    });
  } catch (err) {
    return {
      ok: false,
      failure: {
        reason: "llm-error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  for (const call of response.choices[0]?.message?.tool_calls ?? []) {
    if (call.type !== "function" || call.function.name !== "return_match")
      continue;
    let input: {
      match_index?: unknown;
      confidence?: unknown;
      reason?: unknown;
    };
    try {
      input = JSON.parse(call.function.arguments) as {
        match_index?: unknown;
        confidence?: unknown;
        reason?: unknown;
      };
    } catch {
      return { ok: false, failure: { reason: "llm-empty" } };
    }
    const idx =
      typeof input.match_index === "number" ? Math.trunc(input.match_index) : 0;
    const reason =
      typeof input.reason === "string" ? input.reason.trim() : "";
    // 0 or out-of-range → no match.
    if (idx < 1 || idx > candidates.length) {
      return { ok: true, value: null };
    }
    const rawScore =
      typeof input.confidence === "number" ? Math.trunc(input.confidence) : 0;
    const score = Math.max(0, Math.min(100, rawScore));
    return {
      ok: true,
      value: { candidateId: candidates[idx - 1].id, score, reason },
    };
  }

  return { ok: false, failure: { reason: "llm-empty" } };
}
