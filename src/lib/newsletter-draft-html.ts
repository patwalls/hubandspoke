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
