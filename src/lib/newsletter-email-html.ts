// Markdown (what the newsletter drafter writes) → email-safe HTML (what goes
// into the HubSpot email's rich-text module). Renders with the same
// react-markdown the UI preview uses, so the preview and the email match,
// then whitelists tags/attributes an email client renders reliably.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import sanitizeHtml from "sanitize-html";
import type { CssProps, NewsletterSection, NewsletterStyle, NewsletterTemplate } from "@/lib/newsletter-template";
import { cssText, emailCss, sponsorBlock } from "@/lib/newsletter-template";

const EMAIL_TAGS = [
  "p", "br", "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "u",
  "a", "ul", "ol", "li", "blockquote", "hr", "img", "code", "pre",
];

export function markdownToEmailHtml(markdown: string): string {
  const raw = renderToStaticMarkup(createElement(Markdown, null, markdown));
  return sanitizeHtml(raw, {
    allowedTags: EMAIL_TAGS,
    allowedAttributes: { a: ["href", "target"], img: ["src", "alt", "width", "height"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank" } }),
    },
    allowedSchemesAppliedToAttributes: ["href", "src"],
  });
}

// ── Full email rendering ────────────────────────────────────────────────
// renderEmailHtml turns a template + drafted sections into a complete,
// table-based email document with inline styles (what an inbox renders):
// masthead, then each section's heading (plain or a colored pill) and
// content (optionally in a tinted box), with faint dividers. One renderer
// feeds the format page's template thumbnail, the template editor, the draft
// editor's preview and (later) the email push, so they all match.


function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Section Markdown → HTML with the template's inline styles on each tag. */
function styledSectionHtml(markdown: string, style: NewsletterStyle): string {
  const raw = renderToStaticMarkup(createElement(Markdown, null, markdown));
  const tags = emailCss(style).tags;
  const tag = (css: CssProps) => (tagName: string, attribs: Record<string, string>) => ({ tagName, attribs: { ...attribs, style: cssText(css) } });
  return sanitizeHtml(raw, {
    allowedTags: EMAIL_TAGS,
    allowedAttributes: { a: ["href", "target", "style"], img: ["src", "alt", "width", "height", "style"], "*": ["style"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href", "src"],
    transformTags: {
      ...Object.fromEntries(Object.entries(tags).filter(([k]) => k !== "a").map(([k, css]) => [k, tag(css)])),
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", style: cssText(tags.a) } }),
    },
  });
}

export interface RenderEmailArgs {
  template: NewsletterTemplate;
  sections: NewsletterSection[];
  sponsor?: { copy: string | null; landingUrl: string | null } | null;
  subject?: string | null;
  previewText?: string | null;
  /** Template preview: show each section's hint (greyed) where content would go. */
  showHints?: boolean;
}

/**
 * The full email as inline-CSS HTML (for the email push). Worker/server only:
 * it uses react-dom/server, which Next forbids in route handlers — the
 * browser preview is <EmailPreview>, built from the same emailCss() map.
 */
export function renderEmailHtml(args: RenderEmailArgs): string {
  const { template } = args;
  const st = template.style;
  const css = emailCss(st);
  const byKey = new Map(args.sections.map((x) => [x.key, x.markdown]));

  const blocks = template.sections.map((sec) => {
    let md = (byKey.get(sec.key) ?? "").trim();
    if (sec.kind === "sponsor" && args.sponsor?.copy?.trim()) md = sponsorBlock(args.sponsor.copy, args.sponsor.landingUrl);
    let content = md ? styledSectionHtml(md, st) : "";
    if (!content && args.showHints) content = `<p style="${cssText(css.hint)}">${esc(sec.hint || "(content)")}</p>`;
    if (content && sec.boxColor) content = `<div style="${cssText(css.box(sec.boxColor))}">${content}</div>`;
    let heading = "";
    if (sec.heading) {
      heading = sec.pillColor
        ? `<div style="${cssText(css.pillWrap)}"><span style="${cssText(css.pill(sec.pillColor))}">${esc(sec.heading)}</span></div>`
        : `<div style="${cssText(css.plainHeading(sec.headingLevel))}">${esc(sec.heading)}</div>`;
    }
    return heading + content;
  });

  const body = blocks.filter(Boolean).join(st.dividers ? `<hr style="${cssText(css.divider)}">` : `<div style="${cssText(css.gap)}"></div>`);
  const img = st.mastheadImageUrl ? `<img src="${esc(st.mastheadImageUrl)}" alt="" style="${cssText(css.mastheadImg)}">` : "";
  const masthead = img
    ? `<div style="${cssText(css.mastheadWrap)}">${st.mastheadLinkUrl ? `<a href="${esc(st.mastheadLinkUrl)}" target="_blank">${img}</a>` : img}</div>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(args.subject ?? "")}</title></head>
<body style="${cssText(css.page)}">
${args.previewText ? `<div style="display:none;max-height:0;overflow:hidden">${esc(args.previewText)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${cssText(css.outer)}"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="${cssText(css.card)}"><tr><td style="${cssText(css.inner)}">
${masthead}${body}
</td></tr></table>
</td></tr></table>
</body></html>`;
}
