/**
 * Which text a cross-post / repost should start from when it copies its
 * source's caption.
 *
 * `production_items.content_body` is the source's caption for posts synced
 * from a platform, but for clip-promoted items it holds the clip-idea notes
 * written by `buildContentBody` in promote-clip-idea.ts ("Source: … /
 * Timestamp: … / Angle: … / Why: …"). Seeding those notes into a TikTok
 * cross-post's caption made editors delete and rewrite it by hand, and some
 * went out as-is. For those sources the caption the editor actually wrote
 * lives in the source's current content_drafts row.
 *
 * The check below matches our own template (structure we generate), not
 * free-form content.
 */
export function isClipIdeaNotes(body: string | null | undefined): boolean {
  if (!body) return false;
  return body.startsWith("Source: ") && /\nTimestamp: /.test(body);
}

/** Real body first (the live post's text), then the source's draft caption.
 *  Never the clip-idea notes. Null when neither has text. */
export function pickSourceCaption(
  contentBody: string | null | undefined,
  draftCaption: string | null | undefined,
): string | null {
  const body = contentBody?.trim() ? contentBody : null;
  if (body && !isClipIdeaNotes(body)) return body;
  const draft = draftCaption?.trim() ? draftCaption : null;
  if (draft && !isClipIdeaNotes(draft)) return draft;
  return null;
}
