import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "u",
  "s",
  "a",
  "ul",
  "ol",
  "li",
  "code",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "span",
  "img",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Comment image src must point at our auth-protected proxy. Blocking
// remote/data URIs prevents (a) tracking pixels that ping external
// servers when a comment is rendered and (b) someone pasting raw data:
// URIs that bloat the row.
const COMMENT_IMG_SRC_RE = /^\/api\/files\/[A-Za-z0-9._\-/]+$/;

export function sanitizeCommentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "target", "rel"],
      span: ["data-type", "data-id", "data-label", "class"],
      img: ["src", "alt"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    transformTags: {
      img: (tagName, attribs) => {
        const src = attribs.src ?? "";
        if (!COMMENT_IMG_SRC_RE.test(src)) {
          return { tagName: "", attribs: {} };
        }
        return {
          tagName: "img",
          attribs: {
            src,
            ...(attribs.alt ? { alt: attribs.alt } : {}),
          },
        };
      },
      a: (tagName, attribs) => ({
        tagName: "a",
        attribs: {
          ...(attribs.href ? { href: attribs.href } : {}),
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      }),
      // Only allow `<span>` if it's a well-formed mention: data-type="mention"
      // and a UUID data-id. Everything else becomes plain text (tag stripped,
      // children preserved) via an empty tagName.
      span: (tagName, attribs) => {
        const isMention =
          attribs["data-type"] === "mention" &&
          typeof attribs["data-id"] === "string" &&
          UUID_RE.test(attribs["data-id"]);
        if (!isMention) {
          return { tagName: "", attribs: {} };
        }
        return {
          tagName: "span",
          attribs: {
            "data-type": "mention",
            "data-id": attribs["data-id"],
            ...(attribs["data-label"]
              ? { "data-label": attribs["data-label"] }
              : {}),
            class: "mention",
          },
        };
      },
    },
  });
}

export function htmlToPlainText(html: string): string {
  // Insert newlines at block-element boundaries before sanitize-html
  // strips tags. Without this, `<p>foo</p><p>bar</p>` collapses to
  // `foobar` — the comment-notification email then renders one giant
  // blob instead of the multi-paragraph comment the user actually
  // typed. The email template uses `white-space: pre-wrap` and
  // converts `\n` → `<br>`, so preserving newlines here is what
  // makes line breaks survive end-to-end.
  const withBreaks = html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const stripped = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
  });
  // Collapse runs of horizontal whitespace, drop leading/trailing
  // whitespace per line, cap consecutive blank lines at one.
  return stripped
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
