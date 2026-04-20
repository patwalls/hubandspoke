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
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeCommentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "target", "rel"],
      span: ["data-type", "data-id", "data-label", "class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    transformTags: {
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
  const stripped = sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
  });
  return stripped.replace(/\s+/g, " ").trim();
}
