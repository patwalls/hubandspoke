// Our section Markdown → beehiiv's native content blocks (paragraph, heading,
// list, image, button), so a pushed How-To draft is fully editable in
// beehiiv's editor (the team adds screenshots there). Structural parsing of
// the drafter's own constrained Markdown — headings, bullets, numbered lines,
// images, link-only lines, **bold**, *italic*, [links](url) — not content
// analysis. Pure.

export interface TextRun {
  text: string;
  styling?: ("bold" | "italic")[];
  link?: { href: string; target: "_blank" };
  text_color?: string;
}
export type Block = Record<string, unknown>;

/** Inline Markdown → beehiiv formattedText runs (bold, italic, links; nesting allowed). */
export function inlineRuns(s: string, styling: ("bold" | "italic")[] = [], link?: TextRun["link"]): TextRun[] {
  const out: TextRun[] = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    out.push({ text: buf, ...(styling.length ? { styling: [...styling] } : {}), ...(link ? { link } : {}) });
    buf = "";
  };
  for (let i = 0; i < s.length; ) {
    if (s.startsWith("**", i)) {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push(...inlineRuns(s.slice(i + 2, end), styling.includes("bold") ? styling : [...styling, "bold"], link));
        i = end + 2;
        continue;
      }
    }
    const atWordStart = i === 0 || /[\s([]/.test(s[i - 1]);
    if ((s[i] === "*" || (s[i] === "_" && atWordStart)) && s[i + 1] !== s[i]) {
      const end = s.indexOf(s[i], i + 1);
      if (end > i + 1 && s[end + 1] !== s[i]) {
        flush();
        out.push(...inlineRuns(s.slice(i + 1, end), styling.includes("italic") ? styling : [...styling, "italic"], link));
        i = end + 1;
        continue;
      }
    }
    if (s[i] === "[" && !link) {
      const m = s.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
      if (m) {
        flush();
        out.push(...inlineRuns(m[1], styling, { href: m[2], target: "_blank" }));
        i += m[0].length;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}

const plain = (runs: TextRun[]) => runs.map((r) => r.text).join("");

/**
 * A section's Markdown → blocks. Each non-empty line is its own paragraph (the
 * drafts use short lines). `buttons`: a line that is only a link (optionally
 * bold) becomes a button — the offer CTA and "Watch The Full Video" — instead
 * of a text link.
 */
export function markdownToBlocks(md: string, opts: { buttons?: boolean } = {}): Block[] {
  const blocks: Block[] = [];
  let list: TextRun[][] = [];
  const flushList = () => {
    if (list.length) blocks.push({ type: "list", listType: "unordered", items: list.map((runs) => ({ formattedText: runs })) });
    list = [];
  };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    // "- Saj" / "- Kevin": the intro's sign-off, not a one-item list.
    if (bullet && !/^-\s+(Saj|Kevin)$/.test(line)) {
      list.push(inlineRuns(bullet[1]));
      continue;
    }
    flushList();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = String(Math.min(4, Math.max(2, heading[1].length)));
      blocks.push({ type: "heading", level, anchorHeader: false, anchorIncludeInToc: false, text: plain(inlineRuns(heading[2])) });
      continue;
    }
    const image = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (image) {
      blocks.push({ type: "image", imageUrl: image[2], ...(image[1] ? { alt_text: image[1] } : {}) });
      continue;
    }
    const linkOnly = line.match(/^(?:\*\*)?\[([^\]]+)\]\(([^)\s]+)\)(?:\*\*)?$/);
    if (linkOnly && opts.buttons) {
      const text = linkOnly[1].replace(/\s*(->|→)\s*$/, "").replace(/\*\*/g, "").trim();
      blocks.push({ type: "button", text: `${text} →`, href: linkOnly[2], alignment: "left", target: "_blank" });
      continue;
    }
    blocks.push({ type: "paragraph", formattedText: inlineRuns(line) });
  }
  flushList();
  return blocks;
}
