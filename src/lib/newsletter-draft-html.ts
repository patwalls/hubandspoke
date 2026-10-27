// A saved newsletter edition as the full email document (renderEmailHtml):
// what the test send mails and what the content page's preview shows. Built
// from the draft row in one place so every reader passes the same args — the
// issue's own design (layout) and its `{fields}` (variables) included.

import { renderEmailHtml } from "@/lib/newsletter-email-html";
import type { NewsletterSection, NewsletterTemplate, NewsletterVariables } from "@/lib/newsletter-template";
import type { ChosenScreenshot } from "@/lib/newsletter-screenshots";
import type { DocNode } from "@/lib/newsletter-rich-doc";
import type { NewsletterSpecialSource } from "@/lib/db/schema";

export interface DraftForHtml {
  template: NewsletterTemplate | null;
  sections: NewsletterSection[];
  subject: string | null;
  previewText: string | null;
  specialCopy: string | null;
  specialSource: NewsletterSpecialSource | null;
  screenshots: Record<string, ChosenScreenshot> | null;
  screenshotPreviews?: Record<string, string> | null;
  layout: unknown;
  variables: NewsletterVariables | null;
}

/** The edition's email as a full HTML document, or null when it has no template yet. Pure. */
export function draftEmailHtml(draft: DraftForHtml, footerNote: string | null): string | null {
  if (!draft.template) return null;
  const sponsor = draft.specialCopy ? { copy: draft.specialCopy, landingUrl: draft.specialSource?.landingUrl ?? null } : null;
  const previews = draft.screenshotPreviews ?? {};
  return renderEmailHtml({
    template: draft.template,
    sections: draft.sections,
    sponsor,
    subject: draft.subject,
    previewText: draft.previewText,
    screenshots: { chosen: draft.screenshots, urlFor: (_c, markKey) => previews[markKey] ?? null },
    layout: draft.layout as DocNode | null,
    variables: draft.variables,
    footerNote,
  });
}

/**
 * What a published newsletter's "Live post" shows: the edition's designed
 * email when there is one, else the imported body (`newsletter_body_html`,
 * a bare fragment of <p>/<h2> with no styles) set in a plain email column so
 * it doesn't render as unstyled browser-default serif. Null when neither. Pure.
 */
export function liveNewsletterDocument(editionHtml: string | null, bodyHtml: string | null): string | null {
  if (editionHtml) return editionHtml;
  if (!bodyHtml?.trim()) return null;
  if (/<html[\s>]/i.test(bodyHtml)) return bodyHtml;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;color:#1a1a1a;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:600px;margin:0 auto;padding:24px 20px}
h1,h2,h3{line-height:1.25;margin:1.6em 0 .5em}
p{margin:0 0 1em}
a{color:#0b6bcb}
img{max-width:100%;height:auto}
</style></head><body><main>${bodyHtml}</main></body></html>`;
}
