import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { ContentDraftContent } from "@/lib/db/schema";

/**
 * v16 (2026-10-29): "drafts learn from what editors change".
 *
 * About a third of the AI drafts that get published are rewritten by an
 * editor first (content_drafts: the current version is `user:edit`, an
 * earlier version is `draft-algo:*`). The fixes repeat — the same opener
 * voice, the same trimmed company names, the same split of a long first
 * line — but the draft agent only ever saw the FINAL published copy as
 * exemplars, never the delta. This module pulls the team's most recent
 * (AI draft → what the editor published) pairs for the same brand + format
 * so the agent can see what keeps getting changed and do it up front.
 */

/** How far back to look. Editorial standards drift (same reasoning as the
 *  45-day window on prior cross-post pairs); 60 days keeps sparse formats
 *  in range without teaching last quarter's voice. */
const WINDOW_DAYS = 60;

/** Fields checked, in order, for the body text the editor rewrote. The
 *  first one present on both sides AND different wins — that's the text a
 *  person actually touched. */
const TEXT_FIELDS = ["caption", "tweet", "post", "body", "description", "title"] as const;

/** Very long bodies (TMZ, slideshows) blow up the prompt; the opening is
 *  where most rewrites land anyway. */
const MAX_CHARS = 1200;

export interface EditorRewriteExample {
  field: string;
  draft: string;
  edited: string;
  /** YYYY-MM-DD the editor's version was saved. */
  editedAt: string | null;
}

function textOf(content: ContentDraftContent | null | undefined, field: string): string | null {
  const v = content?.[field];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Whitespace-only differences (a trailing newline, double spaces) aren't
 *  an editorial change — don't teach them. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string): string {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}…` : s;
}

/**
 * The one field an editor rewrote between the AI draft and their saved
 * version, or null when nothing meaningful changed (the editor only touched
 * the CTA or media, or saved the draft as-is).
 */
export function pickRewrite(
  draft: ContentDraftContent | null | undefined,
  edited: ContentDraftContent | null | undefined,
): { field: string; draft: string; edited: string } | null {
  for (const field of TEXT_FIELDS) {
    const a = textOf(draft, field);
    const b = textOf(edited, field);
    if (!a || !b) continue;
    if (normalize(a) === normalize(b)) continue;
    return { field, draft: clip(a), edited: clip(b) };
  }
  return null;
}

interface LoadEditorRewritesOpts {
  brand: string;
  format: string | null;
  /** The item being drafted — never its own history. */
  excludeId: string;
  limit?: number;
}

/**
 * The team's last `limit` (AI draft → editor's version) pairs for this
 * brand + format, newest first. Only items that reached Published count:
 * an abandoned edit isn't a standard. [] when the format is unset or has
 * no rewrites yet — the caller omits the prompt block.
 */
export async function loadEditorRewrites(
  opts: LoadEditorRewritesOpts,
): Promise<EditorRewriteExample[]> {
  if (!opts.format) return [];
  const limit = opts.limit ?? 3;

  // For each published item of this brand+format whose CURRENT draft is a
  // human edit, the newest draft-algo version before it. Over-fetch: some
  // pairs drop out in pickRewrite (only the CTA changed).
  const rows = (await db.execute(sql`
    SELECT cur.content AS edited, ai.content AS draft, cur.updated_at AS edited_at
    FROM content_drafts cur
    JOIN production_items p ON p.id = cur.production_item_id
    JOIN LATERAL (
      SELECT d.content FROM content_drafts d
      WHERE d.production_item_id = cur.production_item_id
        AND d.generated_by LIKE 'draft-algo%'
        AND d.version < cur.version
      ORDER BY d.version DESC
      LIMIT 1
    ) ai ON true
    WHERE cur.is_current
      AND cur.generated_by LIKE 'user%'
      AND p.brand = ${opts.brand}
      AND lower(p.format) = lower(${opts.format})
      AND p.status = 'Published'
      AND p.id <> ${opts.excludeId}
      AND cur.updated_at > now() - (${WINDOW_DAYS} || ' days')::interval
    ORDER BY cur.updated_at DESC
    LIMIT ${limit * 4}
  `)) as unknown as Array<{
    edited: ContentDraftContent;
    draft: ContentDraftContent;
    edited_at: Date | string | null;
  }>;

  const out: EditorRewriteExample[] = [];
  for (const r of rows) {
    const pair = pickRewrite(r.draft, r.edited);
    if (!pair) continue;
    out.push({
      ...pair,
      editedAt: r.edited_at ? new Date(r.edited_at).toISOString().slice(0, 10) : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Prompt block for the per-call payload. null when there are no pairs so
 * the agent isn't handed an empty section.
 */
export function renderEditorRewrites(
  examples: EditorRewriteExample[],
  format: string | null,
): string | null {
  if (examples.length === 0) return null;
  const header = `## WHAT EDITORS CHANGED
Here are the ${examples.length} most recent ${format ? `"${format}" ` : ""}drafts an editor rewrote before publishing: your earlier draft, then what they published. Work out what they keep fixing (voice, openers, length, names, structure) and write it that way from the start. Don't copy their topics — only the kind of change.`;
  const body = examples
    .map((ex, i) => {
      const dateMeta = ex.editedAt ? ` (${ex.editedAt})` : "";
      return `--- rewrite ${i + 1}${dateMeta}, field: ${ex.field} ---
DRAFT:
${ex.draft}

EDITOR PUBLISHED:
${ex.edited}`;
    })
    .join("\n\n");
  return `${header}\n\n${body}`;
}

/** The draft prompt version that started reading editor rewrites. */
export const LEARNS_FROM_EDITS_SINCE = 16;

/**
 * True when a content_drafts.generated_by value is a Draft Algorithm run
 * that had the WHAT EDITORS CHANGED block — `draft-algo:<algo>:<model>:v<N>`
 * with N ≥ 16. Copies, CTA regenerations and human saves never learned.
 */
export function learnedFromEdits(generatedBy: string | null | undefined): boolean {
  if (!generatedBy?.startsWith("draft-algo")) return false;
  const m = /:v(\d+)$/.exec(generatedBy);
  return !!m && Number(m[1]) >= LEARNS_FROM_EDITS_SINCE;
}
