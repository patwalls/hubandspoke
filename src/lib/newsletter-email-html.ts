// Markdown (what the newsletter drafter writes) → email-safe HTML (what goes
// into the HubSpot email's rich-text module). Renders with the same
// react-markdown the UI preview uses, so the preview and the email match,
// then whitelists tags/attributes an email client renders reliably.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import sanitizeHtml from "sanitize-html";

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
