// What a beehiiv push sends for a draft — shared by the create task
// (beehiiv-newsletter-create-draft) and the update task
// (beehiiv-newsletter-update-draft): the draft + its format read from the DB,
// pending screenshots resolved, and the create-post request from
// beehiiv-draft.ts (the designed email as one html block + the poll). The
// update sends the request's `blocks` only. Worker-only (S3 + DB).
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { buildBeehiivDraftRequest } from "@/lib/beehiiv-draft";
import { htmlToText } from "@/lib/html-text";
import type { DocNode } from "@/lib/newsletter-rich-doc";
import { templateFor } from "@/lib/newsletter-template";
import { voiceForChannel } from "@/lib/services/newsletter-drafter/format-config";
import { resolvePendingScreenshots, screenshotUrlsByKey } from "@/lib/services/newsletter-drafter/screenshots";

export interface BeehiivPush {
  row: { id: string; subject: string; beehiivPostId: string | null; beehiivPushedText: string | null };
  /** The full create-post request (beehiiv-draft.ts). */
  body: Record<string, unknown>;
  /** The email's html block, as sent. */
  html: string;
  /** The words of that html (html-text.ts), stored on the draft after a push. */
  pushedText: string;
}

/** The push for a draft, or why there is none: not found / not ready / no beehiiv template. */
export type BeehiivPushLoad = { ok: true; push: BeehiivPush } | { ok: false; problem: string; found: boolean };

export async function loadBeehiivPush(newsletterDraftId: string): Promise<BeehiivPushLoad> {
  const [row] = await db
    .select({
      id: newsletterDrafts.id,
      status: newsletterDrafts.status,
      subject: newsletterDrafts.subject,
      previewText: newsletterDrafts.previewText,
      sendDate: newsletterDrafts.sendDate,
      sections: newsletterDrafts.sections,
      layout: newsletterDrafts.layout,
      variables: newsletterDrafts.variables,
      screenshots: newsletterDrafts.screenshots,
      specialCopy: newsletterDrafts.specialCopy,
      specialSource: newsletterDrafts.specialSource,
      beehiivPostId: newsletterDrafts.beehiivPostId,
      beehiivPushedText: newsletterDrafts.beehiivPushedText,
      formatName: formats.name,
      formatTemplate: formats.newsletterTemplate,
      youtubeId: sql<string | null>`(SELECT ${productionItems.youtubeId} FROM ${productionItems} WHERE ${productionItems.id} = ${newsletterDrafts.sourceItemId})`,
      channelHandle: sql<string | null>`(SELECT a.handle FROM ${productionItems} p JOIN accounts a ON a.id = p.account_id WHERE p.id = ${newsletterDrafts.sourceItemId})`,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, newsletterDraftId))
    .limit(1);
  if (!row) return { ok: false, problem: "not found", found: false };
  if (row.status !== "ready" || !row.subject || !row.sendDate) return { ok: false, problem: "draft is not ready", found: true };
  const template = templateFor(row.formatName, row.formatTemplate);
  if (!template?.beehiiv) return { ok: false, problem: `"${row.formatName}" has no beehiiv template set up`, found: true };
  // Frames still being grabbed when the draft was read: fill in any that have landed.
  const screenshots = await resolvePendingScreenshots(row.id, row.screenshots);
  const body = buildBeehiivDraftRequest({
    template,
    subject: row.subject,
    previewText: row.previewText,
    sendDate: row.sendDate,
    sections: row.sections,
    sponsor: row.specialCopy ? { copy: row.specialCopy, landingUrl: row.specialSource?.landingUrl ?? null } : null,
    thumbnailUrl: row.youtubeId ? `https://img.youtube.com/vi/${row.youtubeId}/maxresdefault.jpg` : null,
    author: voiceForChannel(row.formatName, row.channelHandle)?.voice ?? null,
    screenshots,
    screenshotUrls: await screenshotUrlsByKey(screenshots),
    layout: row.layout as DocNode | null,
    variables: row.variables,
  });
  const html = (body.blocks as { type: string; html?: string }[]).find((b) => b.type === "html")?.html ?? "";
  return { ok: true, push: { row: { id: row.id, subject: row.subject, beehiivPostId: row.beehiivPostId, beehiivPushedText: row.beehiivPushedText }, body, html, pushedText: htmlToText(html) } };
}
