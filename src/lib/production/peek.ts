import type { ContentDraftContent, FormatFieldSchema } from "@/lib/db/schema";

/**
 * What the In Production row peek (M4) shows of a post's draft: its written
 * fields in the format's order (caption, description, tweet text, slides),
 * each cut to a readable length, so a reviewer can tell what the post is
 * without opening it.
 */
export const PEEK_MAX_FIELDS = 3;
export const PEEK_MAX_CHARS = 600;

export interface PeekField {
  label: string;
  text: string;
}

function fieldText(v: ContentDraftContent[string]): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (!Array.isArray(v)) return "";
  const parts = v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" && "text" in x ? String(x.text ?? "") : ""));
  // Tags read as a list; slides as paragraphs.
  const isSlides = v.some((x) => x && typeof x === "object");
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(isSlides ? "\n\n" : ", ");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function draftPreview(
  content: ContentDraftContent | null | undefined,
  schema: FormatFieldSchema | null | undefined,
  { maxFields = PEEK_MAX_FIELDS, maxChars = PEEK_MAX_CHARS } = {},
): PeekField[] {
  if (!content) return [];
  const labelled = schema?.fields?.length
    ? schema.fields.map((f) => ({ key: f.key, label: f.label }))
    : [];
  // Keys the snapshot doesn't name (older drafts, renamed fields) still show,
  // after the named ones, labelled by their key.
  const named = new Set(labelled.map((f) => f.key));
  const extra = Object.keys(content)
    .filter((k) => !named.has(k))
    .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ") }));
  const out: PeekField[] = [];
  for (const f of [...labelled, ...extra]) {
    const text = fieldText(content[f.key]);
    if (!text) continue;
    out.push({ label: f.label, text: clip(text, maxChars) });
    if (out.length >= maxFields) break;
  }
  return out;
}
