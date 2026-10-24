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
 * Numbered steps as the Kevin/Saj templates lay them out: the step's title on
 * its own bold line, its explanation in the paragraph(s) below. A step written
 * with an inline lead-in — "**4. Copy the prompt.** Click…" or
 * "4. **Copy the prompt.** Click…" — is split into "**4. Copy the prompt**"
 * and "Click…" (the title's trailing period/colon dropped, as in the
 * template). Structural handling of our own Markdown. Pure; exported for tests.
 */
export function splitStepTitles(md: string): string {
  return md
    .split("\n")
    .flatMap((line) => {
      const m = line.match(/^\s*(?:\*\*(\d+)\.\s+([^*]+?)\*\*|(\d+)\.\s+\*\*([^*]+?)\*\*)\s+(\S.*)$/);
      if (!m) return [line];
      const n = m[1] ?? m[3];
      const title = (m[2] ?? m[4]).trim().replace(/[.:]$/, "");
      return [`**${n}. ${title}**`, m[5]];
    })
    .join("\n");
}

/** "- Kevin" / "- Saj" on its own line: the intro's sign-off, not a one-item list. */
const SIGNOFF = /^-\s+(Saj|Kevin)$/;

/** Markdown with the sign-off escaped ("\\- Kevin") so a Markdown renderer keeps it a line. Pure. */
export function keepSignoff(md: string): string {
  return md.replace(new RegExp(SIGNOFF.source, "gm"), "\\- $1");
}

/**
 * A section's bullets laid out as its template's `bullets` setting says (see
 * sectionSchema): "lines" joins a run of bullets (or ✅-led lines) into one
 * paragraph with a line break between items (Markdown hard breaks, "  \n");
 * "paragraphs" makes each bullet its own paragraph. "- Kevin" / "- Saj" stay
 * the sign-off. Pure; exported for tests.
 */
export function flattenBullets(md: string, mode: "list" | "lines" | "paragraphs"): string {
  if (mode === "list") return md;
  const out: string[] = [];
  let group: string[] = [];
  const flush = () => {
    if (!group.length) return;
    out.push("", group.join(mode === "lines" ? "  \n" : "\n\n"), "");
    group = [];
  };
  for (const line of md.split("\n")) {
    const bullet = /^\s*-\s+(Saj|Kevin)\s*$/.test(line) ? null : line.match(/^\s*[-*•]\s+(.*)$/);
    const item = bullet ? bullet[1].trim() : mode === "lines" && /^\s*✅/.test(line) ? line.trim() : null;
    if (item) {
      group.push(item);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** "[label →](url)" or "[label](url) ->" → "[label](url) →": the Kevin/Saj arrow sits after the link. Pure. */
export function arrowAfterLink(md: string): string {
  return md.replace(/\[([^\]]*?)\s*(?:->|→)\s*\]\(([^)\s]+)\)(?:\s*(?:->|→))?/g, "[$1]($2) →").replace(/\]\(([^)\s]+)\)\s*->/g, "]($1) →");
}

/** A section's Markdown laid out as the template does it (push and preview share this). Pure. */
export function layoutSection(md: string, bullets: "list" | "lines" | "paragraphs" = "list"): string {
  return arrowAfterLink(flattenBullets(splitStepTitles(md), bullets));
}

/** One paragraph per line, with no spacing between them (the group keeps its outer spacing). */
function tightLines(lines: TextRun[][]): Block[] {
  return lines.map((runs, i) => {
    const vs: Record<string, number> = {};
    if (i > 0) Object.assign(vs, { inner_spacing_top: 0, outer_spacing_top: 0 });
    if (i < lines.length - 1) Object.assign(vs, { inner_spacing_bottom: 0, outer_spacing_bottom: 0 });
    return { type: "paragraph", formattedText: runs, ...(Object.keys(vs).length ? { visual_settings: vs } : {}) };
  });
}

/**
 * A section's Markdown → blocks. Each non-empty line is its own paragraph (the
 * drafts use short lines). `buttons`: a line that is only a link (optionally
 * bold) becomes a button — the offer CTA and "Watch The Full Video" — instead
 * of a text link. Lines joined by Markdown hard breaks ("  ", e.g. the ✅
 * block) stay one tight group: beehiiv splits a newline inside a paragraph
 * into separate paragraphs anyway, so each line is its own paragraph with no
 * spacing between them (`tightLines`), like the template's one-paragraph block.
 */
export function markdownToBlocks(md: string, opts: { buttons?: boolean; buttonColor?: string } = {}): Block[] {
  const blocks: Block[] = [];
  let list: TextRun[][] = [];
  let para: TextRun[][] | null = null;
  const flushPara = () => {
    if (para) blocks.push(...tightLines(para));
    para = null;
  };
  const flushList = () => {
    if (list.length) blocks.push({ type: "list", listType: "unordered", items: list.map((runs) => ({ formattedText: runs })) });
    list = [];
  };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (para) {
      if (line) para.push(inlineRuns(line));
      if (!line || !/ {2}$/.test(raw)) flushPara();
      continue;
    }
    if (!line) {
      flushList();
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    // "- Saj" / "- Kevin": the intro's sign-off, not a one-item list.
    if (bullet && !SIGNOFF.test(line)) {
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
    const linkOnly = line.match(/^(?:\*\*)?\[([^\]]+)\]\(([^)\s]+)\)(?:\*\*)?(?:\s*(?:->|→))?$/);
    if (linkOnly && opts.buttons) {
      const text = linkOnly[1].replace(/\s*(->|→)\s*$/, "").replace(/\*\*/g, "").trim();
      // The Kevin/Saj templates' buttons: centered, navy #273653, white text (unset, beehiiv shows its own pink/black).
      blocks.push({
        type: "button",
        text: `${text} →`,
        href: linkOnly[2],
        alignment: "center",
        target: "_blank",
        visual_settings: { background_color: opts.buttonColor ?? "#273653", text_color: "#FFFFFF" },
      });
      continue;
    }
    if (/ {2}$/.test(raw)) {
      para = [inlineRuns(line)];
      continue;
    }
    blocks.push({ type: "paragraph", formattedText: inlineRuns(line) });
  }
  flushPara();
  flushList();
  return blocks;
}
