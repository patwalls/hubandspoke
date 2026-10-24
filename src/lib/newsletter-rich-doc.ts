// The newsletter editor is a WYSIWYG editor (TipTap / ProseMirror,
// rich-section-editor.tsx); a section is still STORED as our constrained
// Markdown, because the drafter writes it, the email renderer
// (newsletter-email-html.ts) draws it and both pushes send it. This module
// converts between the two, losslessly for everything the editor can make:
// paragraphs with line breaks, bold, italic, links, headings, bullet and
// numbered lists, quotes, dividers, images, screenshot spots
// (`*[Screenshot @ M:SS: label]*`), buttons (`[button: Text](url)`) and the
// first-name token (`{{first_name}}`). Pure (no DOM), so it's unit-tested and
// runs in the browser and on the server alike.

import { Marked, type Token, type Tokens } from "marked";
import { replaceScreenshotMarks } from "@/lib/newsletter-screenshots";

export type Mark = { type: "bold" } | { type: "italic" } | { type: "link"; attrs: { href: string } };
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: Mark[];
}

const SHOT_ALT = "__nlshot__";
const FIRST_NAME = "{{first_name}}";
const BUTTON = /^\s*button:\s*/i;

const lexer = new Marked({ gfm: true, breaks: true });

// ── Markdown → document ─────────────────────────────────────────────────

function textNodes(text: string, marks: Mark[]): DocNode[] {
  if (!text) return [];
  const out: DocNode[] = [];
  const parts = text.split(FIRST_NAME);
  parts.forEach((part, i) => {
    if (part) out.push({ type: "text", text: part, ...(marks.length ? { marks } : {}) });
    if (i < parts.length - 1) out.push({ type: "firstName", ...(marks.length ? { marks } : {}) });
  });
  return out;
}

/** Inline tokens → inline nodes; images and screenshot spots are lifted out as blocks (`blocks`). */
function inline(tokens: Token[] | undefined, marks: Mark[], lift: (block: DocNode) => void): DocNode[] {
  const out: DocNode[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inline(tt.tokens, marks, lift));
        else out.push(...textNodes(tt.text, marks));
        break;
      }
      case "escape":
        out.push(...textNodes((t as Tokens.Escape).text, marks));
        break;
      case "codespan":
        out.push(...textNodes((t as Tokens.Codespan).text, marks));
        break;
      case "html":
        out.push(...textNodes((t as Tokens.HTML).text, marks));
        break;
      case "strong":
        out.push(...inline((t as Tokens.Strong).tokens, [...marks.filter((m) => m.type !== "bold"), { type: "bold" }], lift));
        break;
      case "em":
        out.push(...inline((t as Tokens.Em).tokens, [...marks.filter((m) => m.type !== "italic"), { type: "italic" }], lift));
        break;
      case "del":
        out.push(...inline((t as Tokens.Del).tokens, marks, lift));
        break;
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "link": {
        const l = t as Tokens.Link;
        out.push(...inline(l.tokens, [...marks.filter((m) => m.type !== "link"), { type: "link", attrs: { href: l.href } }], lift));
        break;
      }
      case "image": {
        const im = t as Tokens.Image;
        if (im.text.startsWith(SHOT_ALT)) {
          const [, sec, label] = im.text.split("|");
          lift({ type: "screenshot", attrs: { label: label ?? "", sec: sec || null } });
        } else lift({ type: "image", attrs: { src: im.href, alt: im.text || null } });
        break;
      }
      default:
        if ("text" in t && typeof t.text === "string") out.push(...textNodes(t.text, marks));
    }
  }
  return out;
}

/** A paragraph's inline content, split around images / screenshot spots (which become their own blocks), in document order. */
function paragraphBlocks(tokens: Token[] | undefined): DocNode[] {
  const blocks: DocNode[] = [];
  let current: DocNode[] = [];
  const flush = () => {
    while (current[0]?.type === "hardBreak") current.shift();
    while (current[current.length - 1]?.type === "hardBreak") current.pop();
    if (current.length) blocks.push({ type: "paragraph", content: current });
    current = [];
  };
  const walk = (toks: Token[] | undefined, marks: Mark[]) => {
    for (const t of toks ?? []) {
      if (t.type === "image") {
        flush();
        inline([t], marks, (b) => blocks.push(b));
        continue;
      }
      const nested = (t as { tokens?: Token[] }).tokens;
      const hasImage = nested?.some(function deep(x: Token): boolean {
        return x.type === "image" || !!(x as { tokens?: Token[] }).tokens?.some(deep);
      });
      if (hasImage && (t.type === "strong" || t.type === "em" || t.type === "link" || t.type === "text")) {
        const m: Mark[] =
          t.type === "strong" ? [...marks, { type: "bold" }] : t.type === "em" ? [...marks, { type: "italic" }] : t.type === "link" ? [...marks, { type: "link", attrs: { href: (t as Tokens.Link).href } }] : marks;
        walk(nested, m);
        continue;
      }
      current.push(...inline([t], marks, (b) => {
        flush();
        blocks.push(b);
      }));
    }
  };
  walk(tokens, []);
  flush();
  return blocks;
}

function blocksFrom(tokens: Token[]): DocNode[] {
  const out: DocNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "space":
        break;
      case "paragraph": {
        const p = t as Tokens.Paragraph;
        // A paragraph that is only "[button: Text](url)" is a button.
        const meaningful = (p.tokens ?? []).filter((x) => !(x.type === "text" && !(x as Tokens.Text).text.trim()));
        const one = meaningful.length === 1 ? meaningful[0] : null;
        const link = one?.type === "link" ? (one as Tokens.Link) : one?.type === "strong" && (one as Tokens.Strong).tokens?.length === 1 && (one as Tokens.Strong).tokens[0].type === "link" ? ((one as Tokens.Strong).tokens[0] as Tokens.Link) : null;
        if (link && BUTTON.test(link.text)) {
          out.push({ type: "ctaButton", attrs: { text: link.text.replace(BUTTON, "").trim(), href: link.href } });
          break;
        }
        out.push(...paragraphBlocks(p.tokens));
        break;
      }
      case "heading": {
        const h = t as Tokens.Heading;
        out.push({ type: "heading", attrs: { level: Math.min(Math.max(h.depth, 2), 3) }, content: inline(h.tokens, [], () => undefined) });
        break;
      }
      case "list": {
        const l = t as Tokens.List;
        out.push({
          type: l.ordered ? "orderedList" : "bulletList",
          ...(l.ordered ? { attrs: { start: typeof l.start === "number" ? l.start : 1 } } : {}),
          content: l.items.map((item) => {
            const inner = blocksFrom(item.tokens.map((x) => (x.type === "text" ? ({ ...x, type: "paragraph", tokens: (x as Tokens.Text).tokens ?? [{ type: "text", raw: (x as Tokens.Text).text, text: (x as Tokens.Text).text }] } as Token) : x)));
            return { type: "listItem", content: inner.length ? inner : [{ type: "paragraph" }] };
          }),
        });
        break;
      }
      case "blockquote":
        out.push({ type: "blockquote", content: blocksFrom((t as Tokens.Blockquote).tokens) });
        break;
      case "hr":
        out.push({ type: "horizontalRule" });
        break;
      case "code":
        out.push({ type: "paragraph", content: textNodes((t as Tokens.Code).text, []) });
        break;
      default:
        if ("text" in t && typeof t.text === "string" && t.text.trim()) out.push({ type: "paragraph", content: textNodes(t.text, []) });
    }
  }
  return out;
}

/** Section Markdown → the editor's document (TipTap JSON). Pure; exported for tests. */
export function markdownToDoc(markdown: string): DocNode {
  // Screenshot spots become sentinel images first, so the lexer keeps them whole.
  const md = replaceScreenshotMarks(markdown, (sec, label) => {
    const ts = sec == null ? "" : `${Math.floor(sec / 60)}:${String(Math.round(sec) % 60).padStart(2, "0")}`;
    return `\n\n![${SHOT_ALT}|${ts}|${label.replace(/[|\]]/g, "")}](#shot)\n\n`;
  });
  const content = blocksFrom(lexer.lexer(md));
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

// ── Document → Markdown ─────────────────────────────────────────────────

/** Characters that would turn into Markdown syntax if typed as text. */
function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/([*`])/g, "\\$1").replace(/(^|\s)_(?=\S)/g, "$1\\_");
}

const ORDER: Mark["type"][] = ["bold", "italic"];
const DELIM: Record<"bold" | "italic", string> = { bold: "**", italic: "*" };

/**
 * Inline nodes → Markdown, with emphasis opened / closed only where it
 * changes and spaces kept outside it. A link is one unit: emphasis every part
 * of it shares goes outside (`**[title](url)**`, how the drafter writes it).
 */
function inlineMd(nodes: DocNode[] | undefined): string {
  const list = nodes ?? [];
  const units: DocNode[] = [];
  let i = 0;
  while (i < list.length) {
    const href = linkOf(list[i]);
    let j = i;
    while (j < list.length && linkOf(list[j]) === href) j++;
    if (!href) units.push(...list.slice(i, j));
    else {
      const group = list.slice(i, j);
      const common = ORDER.filter((m) => group.every((n) => n.type === "hardBreak" || n.marks?.some((x) => x.type === m)));
      const inner = emphasisMd(group.map((n) => ({ ...n, marks: n.marks?.filter((m) => m.type !== "link" && !common.includes(m.type)) })));
      units.push({ type: "raw", text: `[${inner}](${href})`, marks: common.map((type) => ({ type }) as Mark) });
    }
    i = j;
  }
  return emphasisMd(units);
}

const linkOf = (n: DocNode) => (n.marks?.find((m) => m.type === "link") as { attrs: { href: string } } | undefined)?.attrs.href ?? null;

function emphasisMd(nodes: DocNode[]): string {
  let out = "";
  const open: ("bold" | "italic")[] = [];
  // Whitespace that ended the last run: written inside the emphasis if the next run continues it, else after closing.
  let pending = "";
  const isPrefix = (to: ("bold" | "italic")[]) => open.length <= to.length && open.every((m, k) => to[k] === m);
  const close = (to: ("bold" | "italic")[]) => {
    while (open.length && !isPrefix(to)) out += DELIM[open.pop()!];
  };
  const flushPending = () => {
    out += pending;
    pending = "";
  };
  for (const n of nodes) {
    if (n.type === "hardBreak") {
      close([]);
      flushPending();
      out += "\n";
      continue;
    }
    const raw = n.type === "firstName" ? FIRST_NAME : n.type === "text" || n.type === "raw" ? (n.text ?? "") : "";
    if (!raw) continue;
    const want = ORDER.filter((m) => n.marks?.some((x) => x.type === m)) as ("bold" | "italic")[];
    const text = n.type === "text" ? escapeText(raw) : raw;
    // Emphasis can't start or end on a space: edge spaces go outside unless the emphasis carries on.
    const lead = text.match(/^\s*/)![0];
    const trail = text.slice(lead.length).match(/\s*$/)![0];
    const core = text.slice(lead.length, text.length - trail.length);
    if (!core) {
      pending += text;
      continue;
    }
    if (lead) pending += lead;
    if (pending && !(want.length >= open.length && isPrefix(want))) close([]);
    else close(want);
    flushPending();
    for (const m of want.slice(open.length)) {
      out += DELIM[m];
      open.push(m);
    }
    out += core;
    pending = trail;
  }
  close([]);
  flushPending();
  return out;
}

function blockMd(node: DocNode): string {
  switch (node.type) {
    case "paragraph":
      return inlineMd(node.content).replace(/^(\s*)([#>]|[-+]\s|\d+\.\s)/, "$1\\$2");
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 2))} ${inlineMd(node.content)}`;
    case "bulletList":
      return (node.content ?? []).map((li) => `- ${itemMd(li)}`).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1) || 1;
      return (node.content ?? []).map((li, k) => `${start + k}. ${itemMd(li)}`).join("\n");
    }
    case "blockquote":
      return (node.content ?? []).map(blockMd).join("\n\n").split("\n").map((l) => `> ${l}`).join("\n");
    case "horizontalRule":
      return "---";
    case "image":
      return `![${String(node.attrs?.alt ?? "").replace(/[[\]]/g, "")}](${String(node.attrs?.src ?? "")})`;
    case "screenshot": {
      const sec = node.attrs?.sec ? ` @ ${String(node.attrs.sec)}` : "";
      return `*[Screenshot${sec}: ${String(node.attrs?.label ?? "Image")}]*`;
    }
    case "ctaButton":
      return `[button: ${String(node.attrs?.text ?? "Button").replace(/[[\]]/g, "")}](${String(node.attrs?.href ?? "")})`;
    default:
      return (node.content ?? []).map(blockMd).join("\n\n");
  }
}

function itemMd(li: DocNode): string {
  return (li.content ?? []).map(blockMd).filter(Boolean).join("\n\n").replace(/\n/g, "\n  ");
}

/** The editor's document → section Markdown. Pure; exported for tests. */
export function docToMarkdown(doc: DocNode): string {
  return (doc.content ?? [])
    .map(blockMd)
    .filter((b) => b.trim())
    .join("\n\n")
    .trim();
}
