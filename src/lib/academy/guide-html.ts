import sanitizeHtml from "sanitize-html";
import { videoEmbedUrl } from "@/lib/academy/video-embed";

/**
 * The step-by-step guide under an Academy video is HTML written by the
 * GuideEditor (TipTap). It's sanitized on save to the few tags the editor
 * produces, and at render time video placeholders become players.
 *
 *   <h2>/<h3>                 step headings
 *   <figure data-figure>      a screenshot + optional <figcaption>
 *   <div data-callout="tip">  a tip box (wraps paragraphs/lists)
 *   <div data-video-embed=…>  an extra video (Loom/YouTube/Vimeo/Drive link)
 */

// Our auth-checked file proxy (uploads) or any https image.
const IMG_SRC_RE = /^(\/api\/files\/[A-Za-z0-9._\-/]+|https:\/\/[^\s"'<>]+)$/;

export function sanitizeGuideHtml(html: string): string {
  const clean = sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "em", "u", "s", "a", "ul", "ol", "li", "blockquote", "h2", "h3", "hr", "figure", "figcaption", "img", "div"],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt"],
      figure: ["data-figure"],
      div: ["data-callout", "data-video-embed"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    transformTags: {
      img: (_tag, attribs) =>
        IMG_SRC_RE.test(attribs.src ?? "")
          ? { tagName: "img", attribs: { src: attribs.src, ...(attribs.alt ? { alt: attribs.alt } : {}) } }
          : { tagName: "", attribs: {} },
      a: (_tag, attribs) => ({
        tagName: "a",
        attribs: { ...(attribs.href ? { href: attribs.href } : {}), target: "_blank", rel: "noopener noreferrer" },
      }),
      div: (_tag, attribs) => {
        const out: Record<string, string> = {};
        const url = attribs["data-video-embed"];
        if (attribs["data-callout"] !== undefined) out["data-callout"] = "tip";
        else if (url && videoEmbedUrl(url)) out["data-video-embed"] = url;
        return { tagName: "div", attribs: out };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
  // An editor with nothing typed still sends "<p></p>".
  return sanitizeHtml(clean, { allowedTags: [], allowedAttributes: {} }).trim() === "" && !/<(img|div data-video-embed)/.test(clean)
    ? ""
    : clean;
}

export { renderGuideHtml } from "@/lib/academy/guide-render";
