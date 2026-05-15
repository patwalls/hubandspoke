/**
 * Newsletter (Klaviyo) enricher. Pulls the campaign-message body for a
 * Sent campaign and writes:
 *   • plaintext body              → contentBody
 *   • raw HTML body               → newsletterBodyHtml (training corpus
 *                                   source-of-truth; we can re-extract
 *                                   plaintext later if the stripper improves)
 *   • inbox preview / preheader   → newsletterPreviewText
 *   • re-affirmed subject         → title
 *   • from-email / from-name      → authorHandle / authorDisplayName
 *   • first sentence of plaintext → hook (mirrors the YT enricher's
 *                                   "title as hook" rule; gives the
 *                                   newsletter a hook-source so search +
 *                                   exemplar lookups work without LLM)
 *
 * One-shot: orchestrator gates on `enrichmentCompletedAt IS NULL`. Re-runs
 * via the on-demand `enrichSingleItem(id, { force: true })` path are fine
 * — every column above is idempotent on re-fetch.
 */

import { eq } from "drizzle-orm";
import sanitizeHtml from "sanitize-html";
import { db } from "@/lib/db";
import { accounts, productionItems } from "@/lib/db/schema";
import { fetchKlaviyo, KlaviyoError } from "@/lib/services/klaviyo-client";
import type { EnrichmentResult } from "./types";

interface CampaignMessageContent {
  subject?: string;
  preview_text?: string;
  from_email?: string;
  from_label?: string;
  reply_to_email?: string | null;
  cc_email?: string | null;
  bcc_email?: string | null;
}

interface CampaignMessageDefinition {
  channel?: string;
  label?: string;
  content?: CampaignMessageContent;
}

interface CampaignMessageAttributes {
  // Some revisions nest `channel` / `content` under `definition`; older
  // revisions exposed them at the top level. Accept both shapes.
  definition?: CampaignMessageDefinition;
  channel?: string;
  content?: CampaignMessageContent;
  send_times?: unknown;
}

interface CampaignMessageRelationships {
  template?: {
    data?: { type: "template"; id: string } | null;
  };
}

interface CampaignMessage {
  type: "campaign-message";
  id: string;
  attributes: CampaignMessageAttributes;
  relationships?: CampaignMessageRelationships;
}

interface CampaignMessagesListResponse {
  data: CampaignMessage[];
}

interface TemplateAttributes {
  name?: string;
  html?: string;
  text?: string;
}

interface TemplateGetResponse {
  data: { type: "template"; id: string; attributes: TemplateAttributes };
}

export async function enrichNewsletterItem(
  itemId: string,
): Promise<EnrichmentResult> {
  const [item] = await db
    .select({
      id: productionItems.id,
      platformContentId: productionItems.platformContentId,
      accountId: productionItems.accountId,
      title: productionItems.title,
      contentBody: productionItems.contentBody,
      authorHandle: productionItems.authorHandle,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) throw new Error(`Production item ${itemId} not found`);

  const result: EnrichmentResult = {
    updates: {},
    creditsSpent: 0,
    fields: {},
  };

  // Legacy newsletters predate Klaviyo sync — they were created via Notion
  // import or manual entry and have no Klaviyo campaign id. Return a
  // successful empty result so the orchestrator stamps
  // enrichment_completed_at and stops re-trying them. Same outcome as a
  // platform with no enricher: nothing to do, don't burn retries.
  if (!item.platformContentId || !item.accountId) {
    return result;
  }

  const [account] = await db
    .select({ handle: accounts.handle })
    .from(accounts)
    .where(eq(accounts.id, item.accountId))
    .limit(1);
  if (!account) {
    // Account row was deleted under us — same no-op treatment.
    return result;
  }

  // Three-step fetch:
  //   1. /campaigns/{id}/campaign-messages  — relationship endpoint that
  //      lists this campaign's messages with the channel/subject/preview/
  //      from_* fields inline. The filter-based variant
  //      (?filter=equals(campaign_id,…)) is rejected on this revision; the
  //      relationship endpoint is the canonical path.
  //   2. /templates/{template_id}            — pulls the rendered HTML body.
  //      The body does NOT live on the campaign-message — that endpoint
  //      only carries headers (subject, preheader, from). The template is
  //      where the actual email lives.
  //   3. (no third fetch — we have everything.)
  const listPath = `/campaigns/${item.platformContentId}/campaign-messages`;
  const list = await fetchKlaviyo<CampaignMessagesListResponse>(
    { handle: account.handle },
    listPath,
  );
  if (!list || list.data.length === 0) {
    throw new KlaviyoError(
      `No campaign-messages for campaign ${item.platformContentId}`,
      404,
      listPath,
    );
  }
  const emailMsg =
    list.data.find(
      (m) =>
        m.attributes.definition?.channel === "email" ||
        m.attributes.channel === "email",
    ) ?? list.data[0];

  const content =
    emailMsg.attributes.definition?.content ??
    emailMsg.attributes.content ??
    {};
  const subject = (content.subject ?? "").trim();
  const preview = (content.preview_text ?? "").trim();
  const fromEmail = (content.from_email ?? "").trim();
  const fromLabel = (content.from_label ?? "").trim();

  const templateId = emailMsg.relationships?.template?.data?.id;
  let html = "";
  if (templateId) {
    const tpl = await fetchKlaviyo<TemplateGetResponse>(
      { handle: account.handle },
      `/templates/${templateId}`,
    );
    html = (tpl?.data?.attributes?.html ?? "").trim();
  }
  const plaintext = htmlToPlaintext(html);

  if (subject) {
    result.updates.title = subject;
  }
  if (html) {
    result.updates.newsletterBodyHtml = html;
  }
  if (plaintext) {
    result.updates.contentBody = plaintext;
    result.updates.contentBodyFetchedAt = new Date();
    result.updates.contentBodySource = "klaviyo:campaign-message";
    // Mirror YT's "first sentence as hook" pattern — gives newsletters a
    // populated hook column for search + exemplar lookups without
    // needing the LLM hook sweep (which is short-form-only).
    const firstSentence = extractFirstSentence(plaintext);
    if (firstSentence) {
      result.updates.hook = firstSentence.slice(0, 240);
      result.updates.hookSource = "body";
      result.updates.hookExtractor = "newsletter-enricher:v1";
      result.updates.hookExtractedAt = new Date();
    }
  }
  if (preview) {
    result.updates.newsletterPreviewText = preview;
  }
  if (fromEmail) {
    result.updates.authorHandle = fromEmail;
  }
  if (fromLabel) {
    result.updates.authorDisplayName = fromLabel;
  }
  result.updates.updatedAt = new Date();

  // Klaviyo doesn't bill us per-call (rate-limited but not metered like SC),
  // so creditsSpent stays 0 — the SC credit accounting in performance-decay
  // and the dashboard wouldn't make sense to extend to Klaviyo without
  // a separate cost surface.
  result.fields.captionFetched = !!plaintext;
  result.fields.descriptionFetched = !!html;
  result.fields.authorFetched = !!(fromEmail || fromLabel);

  return result;
}

/**
 * Convert Klaviyo's rendered HTML to readable plaintext for training. We
 * use sanitize-html with `allowedTags: []` to strip every tag, then
 * normalize whitespace. Links: keep the visible text, drop the URL —
 * marketing-email URLs are usually long Klaviyo tracking redirects that
 * don't help training. The HTML is preserved on `newsletterBodyHtml` so
 * a future re-extract can revisit this decision.
 */
export function htmlToPlaintext(html: string): string {
  if (!html) return "";
  // Pre-pass: insert hard newlines after block-level closing tags and
  // around <br>/<hr> so paragraph boundaries survive the strip step.
  // sanitize-html with allowedTags:[] flattens everything to a single
  // line otherwise, which is unreadable for training data.
  const blockBoundary = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article|footer|header)>/gi,
      "\n\n",
    )
    .replace(/<hr\s*\/?>/gi, "\n\n");
  const stripped = sanitizeHtml(blockBoundary, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "head"],
  });
  return normalizeWhitespace(stripped);
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ") // NBSP -> regular space
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Find the first non-empty sentence in plaintext. Keeps it simple — splits
 * on `.!?` followed by whitespace or EOL. Falls back to the first non-empty
 * line if no sentence terminator appears in the first ~500 chars (some
 * newsletters open with "Hey friend" + a paragraph break instead of
 * punctuation).
 */
export function extractFirstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const head = trimmed.slice(0, 1000);
  const m = head.match(/^([^\n.!?]+[.!?])(?:\s|$)/);
  if (m) return m[1].trim();
  const firstLine = trimmed.split("\n").find((l) => l.trim().length > 0);
  return firstLine ? firstLine.trim() : "";
}
