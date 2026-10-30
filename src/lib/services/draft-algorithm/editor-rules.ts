import Anthropic from "@anthropic-ai/sdk";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, type FormatEditorRules } from "@/lib/db/schema";
import {
  loadEditorRewrites,
  renderEditorRewrites,
  type EditorRewriteExample,
} from "./editor-rewrites";

/**
 * drafts-learn M4 (2026-10-30): per-format "house rules".
 *
 * The draft prompt already sees the 3 newest (draft → editor published)
 * pairs (editor-rewrites.ts). Three pairs teach the agent, but the TEAM
 * never sees the pattern, and a rule that holds across a dozen rewrites
 * deserves to live in the format's Skill where everyone can read and edit
 * it. Once a week Haiku reads up to 12 recent pairs per format and writes
 * 3–5 short rules; the format page shows them with "Add to Skill". Nothing
 * here edits a Skill on its own — a person accepts each rule.
 *
 * The cron is daily but each format refreshes weekly (`rulesAreStale`).
 */

const MODEL = "claude-haiku-5-5";
export const EDITOR_RULES_VERSION = `${MODEL}:editor-rules:v1`;

/** Fewer rewrites than this and "what keeps changing" is one person's
 *  one-off taste, not a rule. */
export const MIN_PAIRS = 4;
const MAX_PAIRS = 12;
const MAX_RULES = 5;
const MAX_RULE_CHARS = 200;

/** Rules are re-derived at most this often. The cron runs daily so a new
 *  format (or a fresh deploy) gets rules the same day; this keeps it weekly. */
export const REFRESH_EVERY_MS = 6.5 * 24 * 60 * 60 * 1000;

/** True when a format's stored rules are older than REFRESH_EVERY_MS (or
 *  missing) and the daily run should re-derive them. */
export function rulesAreStale(rules: FormatEditorRules | null | undefined, now: Date): boolean {
  if (!rules?.generatedAt) return true;
  const at = new Date(rules.generatedAt).getTime();
  return !Number.isFinite(at) || now.getTime() - at >= REFRESH_EVERY_MS;
}

/** Never matches a real item — loadEditorRewrites excludes one id. */
const NO_ITEM = "00000000-0000-0000-0000-000000000000";

/**
 * Clean up the model's rule list: strings only, trimmed, list markers
 * stripped, too-long ones dropped, duplicates (case-insensitive) dropped,
 * at most MAX_RULES. [] when nothing usable came back.
 */
export function parseEditorRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const rule = r.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (!rule || rule.length > MAX_RULE_CHARS) continue;
    const key = rule.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

const SYSTEM_PROMPT = `You read before/after pairs of social posts: what an editor started from (an AI draft, or a caption copied from another post) and what they actually published. Find the changes editors make AGAIN AND AGAIN across several pairs — voice, openers, length, names, line breaks, words they always cut — and state each as a short instruction a writer can follow ("Open with the founder's name, not 'He'").

Rules:
- Only patterns seen in at least two pairs. Skip one-off fixes and topic changes.
- 3 to 5 rules, each one sentence under 25 words, imperative, concrete.
- Never mention a specific post, person, company or number from the pairs.
- If there is no repeated pattern, return an empty list.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "return_rules",
    description: "Return the recurring editor changes as writing rules.",
    input_schema: {
      type: "object",
      properties: {
        rules: { type: "array", items: { type: "string" }, maxItems: MAX_RULES },
      },
      required: ["rules"],
    },
  },
];

export type SummarizeResult =
  | { ok: true; rules: string[] }
  | { ok: false; failure: string };

/** One Haiku call → rules. Fail-soft: an API error or an empty/garbled
 *  answer is `{ ok: false }`, and the caller keeps last week's rules. */
export async function summarizeEditorRules(
  pairs: EditorRewriteExample[],
  format: string,
): Promise<SummarizeResult> {
  const block = renderEditorRewrites(pairs, format);
  if (!block) return { ok: false, failure: "no pairs" };
  let response: Anthropic.Message;
  try {
    response = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "return_rules" },
      messages: [{ role: "user", content: block }],
    });
  } catch (err) {
    return { ok: false, failure: err instanceof Error ? err.message : String(err) };
  }
  const tool = response.content.find((b) => b.type === "tool_use");
  const rules = parseEditorRules(
    tool && tool.type === "tool_use" ? (tool.input as { rules?: unknown }).rules : null,
  );
  if (rules.length === 0) return { ok: false, failure: "no rules returned" };
  return { ok: true, rules };
}

export interface RefreshSummary {
  formats: number;
  updated: number;
  skipped: number;
  failed: number;
}

/**
 * Daily, weekly per format: for every format whose rules are stale and that
 * has at least MIN_PAIRS recent rewrites, re-derive its rules and store them on `formats.editor_rules`. A format
 * whose pairs dropped below the bar keeps its last rules (they were true
 * when written, and the page shows their date).
 */
export async function refreshEditorRules(opts: {
  log?: (msg: string) => void;
  now?: Date;
  /** Tests: only these formats, and a stand-in for the Haiku call. */
  formatIds?: string[];
  summarize?: typeof summarizeEditorRules;
} = {}): Promise<RefreshSummary> {
  const { log = () => {}, now = new Date(), summarize = summarizeEditorRules } = opts;
  const rows = await db
    .select({ id: formats.id, name: formats.name, brand: formats.brand, editorRules: formats.editorRules })
    .from(formats)
    .where(opts.formatIds ? inArray(formats.id, opts.formatIds) : undefined);
  const summary: RefreshSummary = { formats: rows.length, updated: 0, skipped: 0, failed: 0 };
  for (const f of rows) {
    if (!rulesAreStale(f.editorRules, now)) {
      summary.skipped++;
      continue;
    }
    const pairs = await loadEditorRewrites({
      brand: f.brand,
      format: f.name,
      excludeId: NO_ITEM,
      limit: MAX_PAIRS,
    });
    if (pairs.length < MIN_PAIRS) {
      summary.skipped++;
      continue;
    }
    const result = await summarize(pairs, f.name);
    if (!result.ok) {
      summary.failed++;
      log(`editor-rules ${f.brand}/${f.name}: ${result.failure}`);
      continue;
    }
    const value: FormatEditorRules = {
      rules: result.rules,
      pairCount: pairs.length,
      generatedAt: now.toISOString(),
      model: EDITOR_RULES_VERSION,
    };
    await db.update(formats).set({ editorRules: value }).where(eq(formats.id, f.id));
    summary.updated++;
  }
  return summary;
}
