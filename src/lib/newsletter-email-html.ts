// The newsletter as the email that lands in the inbox: Markdown (what the
// drafter writes and the editor edits) + the format's template → table-based
// HTML with every style inline, the way mail clients (Gmail, Outlook, Apple
// Mail, phones) render reliably. No <style> block, no classes, no web fonts:
// system fonts, fluid 600px tables, bulletproof buttons, images that shrink
// to the phone's width.
//
// ONE renderer, three readers, so nothing can drift: the editor's canvas
// (renderEmailParts — the same HTML, section by section, with click targets
// marked up for editing), the exact preview and the format page thumbnail
// (renderEmailHtml — a full document), and the HubSpot push (renderEmailBody
// — the fragment that fills the email's one rich-text block; HubSpot adds the
// footer). Pure and isomorphic: `marked` runs in the browser and on the
// worker alike. Raw HTML in the Markdown is shown as text, never rendered.

import { Marked, type Tokens } from "marked";
import { replaceScreenshotMarks, screenshotKey, stepsWithoutScreenshots, type ChosenScreenshot, type StepSpot } from "@/lib/newsletter-screenshots";
import { sponsorBlock, type NewsletterSection, type NewsletterStyle, type NewsletterTemplate, type NewsletterTemplateSection } from "@/lib/newsletter-template";
import { layoutFor } from "@/lib/newsletter-layout";
import { docToMarkdown, type DocNode } from "@/lib/newsletter-rich-doc";

/** The email's width in a desktop client; phones get 100%. */
export const EMAIL_WIDTH = 600;
/** Inner padding on every side (the masthead and images are EMAIL_WIDTH − 2 × this wide). */
const PAD = 24;
export const CONTENT_WIDTH = EMAIL_WIDTH - 2 * PAD;
const RULE = "#e5e7eb";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** http(s) and mailto only; anything else (javascript:, data:) is dropped. */
function safeUrl(href: string | null | undefined): string | null {
  const h = (href ?? "").trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

export interface EmailScreenshots {
  chosen: Record<string, ChosenScreenshot> | null | undefined;
  /** The link to show for a picked frame / upload (a preview link in the browser, the public link in the sent email). */
  urlFor: (c: ChosenScreenshot, markKey: string) => string | null;
}

/**
 * Personalization tokens the editor can type (toolbar → First name): how the
 * preview shows them (a sample) and what the HubSpot push sends (HubL with a
 * fallback). Replaced AFTER Markdown rendering, so the HubL quotes survive
 * escaping. Exported for tests.
 */
export const PERSONALIZATION: Record<string, { sample: string; hubspot: string }> = {
  "{{first_name}}": { sample: "Pat", hubspot: "{{ contact.firstname|default('there') }}" },
};
export type Personalization = "sample" | "hubspot" | "raw";

/** Swap personalization tokens in rendered HTML (or text). Pure; exported for tests. */
export function applyPersonalization(html: string, mode: Personalization): string {
  if (mode === "raw") return html;
  return Object.entries(PERSONALIZATION).reduce((out, [token, v]) => out.split(token).join(mode === "hubspot" ? v.hubspot : v.sample), html);
}

export interface RenderEmailArgs {
  template: NewsletterTemplate;
  sections: NewsletterSection[];
  sponsor?: { copy: string | null; landingUrl: string | null } | null;
  subject?: string | null;
  previewText?: string | null;
  /** Template preview: show each section's instructions (greyed) where its content goes, and sample boxes for thumbnails / screenshots. */
  showHints?: boolean;
  /** Picked screenshots for the drafts' placeholders. Without it (or for an unpicked one) the placeholder is left out of the email. */
  screenshots?: EmailScreenshots | null;
  /**
   * The editor's canvas: screenshot spots (picked or not) and images carry
   * `data-shot` / `data-img` + `nlc-*` classes the canvas wires to its panels,
   * and unpicked spots draw as a dashed box. Never set for the push.
   */
  canvas?: boolean;
  /** Personalization tokens: "sample" (preview, default), "hubspot" (the push), "raw". */
  personalization?: Personalization;
}

// ── Style tokens ────────────────────────────────────────────────────────
// Every visual decision, as inline `style=""` text. Font family repeats on
// every text element because Outlook doesn't inherit it through tables.

function tokens(st: NewsletterStyle) {
  const F = `font-family:${st.fontFamily};`;
  const text = `${F}font-size:16px;line-height:1.6;color:${st.textColor};`;
  const button = st.buttonColor ?? st.linkColor;
  return {
    F,
    text,
    button,
    p: `margin:0 0 16px 0;${text}`,
    h: (level: 1 | 2 | 3) => `margin:${level === 1 ? 24 : 20}px 0 ${level === 3 ? 8 : 10}px 0;${F}font-size:${level === 1 ? 24 : level === 2 ? 21 : 18}px;font-weight:700;line-height:1.3;color:${st.headingColor};`,
    // list-style spelled out: some clients (and the app's own CSS reset) strip bullets otherwise.
    ul: (ordered: boolean) => `margin:0 0 16px 0;padding:0 0 0 24px;list-style-type:${ordered ? "decimal" : "disc"};${text}`,
    li: `margin:0 0 8px 0;${text}`,
    a: `color:${st.linkColor};text-decoration:underline;`,
    img: `display:block;width:100%;max-width:${CONTENT_WIDTH}px;height:auto;border:0;border-radius:10px;margin:4px 0 16px 0;`,
    blockquote: `margin:0 0 16px 0;padding:4px 0 4px 16px;border-left:3px solid ${RULE};${F}font-size:16px;line-height:1.6;color:#4b5563;font-style:italic;`,
    code: `font-family:Menlo,Consolas,monospace;font-size:14px;background:#f3f4f6;padding:2px 5px;border-radius:4px;`,
    pre: `margin:0 0 16px 0;padding:14px 16px;background:#f3f4f6;border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.5;color:${st.textColor};white-space:pre-wrap;`,
    hr: `border:0;border-top:1px solid ${RULE};margin:24px 0;`,
    hint: `margin:0 0 16px 0;${F}font-size:15px;line-height:1.5;color:#9ca3af;font-style:italic;`,
    pill: (color: string) => `background:${color};border-radius:8px;padding:8px 14px;${F}font-size:19px;font-weight:700;line-height:1.2;color:${st.headingColor};`,
    plainHeading: (level: 2 | 3) => `margin:0 0 12px 0;${F}font-size:${level === 2 ? 22 : 18}px;font-weight:700;line-height:1.3;color:${st.headingColor};`,
    label: (color: string) => `background:${color};border-radius:6px;padding:6px 10px;${F}font-size:13px;font-weight:700;line-height:1.2;color:${st.headingColor};`,
    box: (color: string) => `background:${color};border-radius:12px;padding:20px 22px 6px 22px;`,
    buttonCell: `background:${button};border-radius:8px;`,
    buttonLink: `display:inline-block;padding:13px 26px;${F}font-size:16px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px;`,
    masthead: `background:${st.mastheadBackground ?? "transparent"};border-radius:12px;text-align:center;padding:0;`,
    mastheadImg: `display:block;width:100%;max-width:${CONTENT_WIDTH}px;height:auto;border:0;border-radius:12px;margin:0 auto;`,
    body: bodyStyle(st),
  };
}

/** The email body cell's style (padding, font, color) — as an object, so the canvas can put the same on a React element. */
export function bodyStyle(st: NewsletterStyle): Record<string, string> {
  return { padding: `${PAD}px ${PAD}px ${PAD + 4}px ${PAD}px`, fontFamily: st.fontFamily, fontSize: "16px", lineHeight: "1.6", color: st.textColor };
}

/** React-style CSS object → inline `style=""` text. */
export function cssText(css: Record<string, string>): string {
  return Object.entries(css)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v};`)
    .join("");
}

const TABLE = (style: string, width = false) =>
  `<table role="presentation"${width ? ' width="100%"' : ""} cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;${width ? "width:100%;" : ""}${style}">`;

/** A section break: a faint rule with air around it, or just the air. */
function divider(withRule: boolean): string {
  return withRule
    ? `${TABLE("margin:0;", true)}<tr><td style="padding:10px 0 0 0;border-bottom:1px solid ${RULE};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr><tr><td style="padding:0 0 26px 0;font-size:0;line-height:0;">&nbsp;</td></tr></table>`
    : `${TABLE("margin:0;", true)}<tr><td style="padding:0 0 14px 0;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

// ── Markdown → HTML ─────────────────────────────────────────────────────

/** Alt-text encoding for a screenshot spot, set by the pre-pass and read by the image renderer. */
const SHOT = "__shot__|";
/** "[button: Watch the episode](url)" — a button wherever it's written. */
export const BUTTON_PREFIX = /^\s*button:\s*/i;

interface SectionRenderContext {
  t: ReturnType<typeof tokens>;
  /** A line that is only a link becomes a button. */
  buttons: boolean;
  canvas: boolean;
  /** Ordinary images in this section so far (their order is the canvas's handle on them). */
  images: number;
}

/** The one link a paragraph consists of (optionally bold-wrapped), else null. */
function soleLink(tokens: Tokens.Paragraph["tokens"]): Tokens.Link | null {
  const meaningful = tokens.filter((x) => !(x.type === "text" && !x.text.trim()));
  if (meaningful.length !== 1) return null;
  const one = meaningful[0];
  if (one.type === "link") return one as Tokens.Link;
  if (one.type === "strong" && (one as Tokens.Strong).tokens?.length === 1 && (one as Tokens.Strong).tokens[0].type === "link") return (one as Tokens.Strong).tokens[0] as Tokens.Link;
  return null;
}

function markedFor(ctx: SectionRenderContext): Marked {
  const { t } = ctx;
  const m = new Marked({ gfm: true, breaks: true });
  m.use({
    renderer: {
      space: () => "",
      html: ({ text }) => esc(text),
      hr: () => `<hr style="${t.hr}">`,
      code: ({ text }) => `<pre style="${t.pre}">${esc(text)}</pre>`,
      codespan: ({ text }) => `<code style="${t.code}">${esc(text)}</code>`,
      br: () => "<br>",
      blockquote({ tokens }) {
        return `<blockquote style="${t.blockquote}">${this.parser.parse(tokens)}</blockquote>`;
      },
      heading({ tokens, depth }) {
        const level = (Math.min(Math.max(depth, 1), 3) as 1 | 2 | 3) ?? 2;
        return `<p style="${t.h(level)}">${this.parser.parseInline(tokens)}</p>`;
      },
      paragraph({ tokens }) {
        // A button: a line that is only a link, when the section asks for buttons — or any link written "[button: Text](url)".
        const sole = soleLink(tokens);
        const explicit = !!sole && BUTTON_PREFIX.test(sole.text);
        const link = sole && (ctx.buttons || explicit) ? sole : null;
        const href = link && safeUrl(link.href);
        if (link && href) {
          const label = explicit ? esc(link.text.replace(BUTTON_PREFIX, "").trim()) : this.parser.parseInline(link.tokens);
          return `${TABLE("margin:4px auto 20px auto;")}<tr><td align="center" style="${t.buttonCell}"><a href="${esc(href)}" target="_blank" style="${t.buttonLink}">${label}</a></td></tr></table>`;
        }
        return `<p style="${t.p}">${this.parser.parseInline(tokens)}</p>`;
      },
      list(token) {
        const tag = token.ordered ? "ol" : "ul";
        const start = token.ordered && token.start !== 1 && token.start !== "" ? ` start="${token.start}"` : "";
        return `<${tag}${start} style="${t.ul(!!token.ordered)}">${token.items.map((item) => this.listitem(item)).join("")}</${tag}>`;
      },
      listitem(item) {
        return `<li style="${t.li}">${this.parser.parse(item.tokens)}</li>`;
      },
      link({ href, tokens, text }) {
        const url = safeUrl(href);
        const inner = BUTTON_PREFIX.test(text) ? esc(text.replace(BUTTON_PREFIX, "").trim()) : this.parser.parseInline(tokens);
        return url ? `<a href="${esc(url)}" target="_blank" style="${t.a}">${inner}</a>` : inner;
      },
      image({ href, text }) {
        if (text.startsWith(SHOT)) {
          const [, markKey, label, sec, pending] = text.split("|");
          const url = safeUrl(href);
          if (!ctx.canvas) return url ? `<img src="${esc(url)}" width="${CONTENT_WIDTH}" alt="${esc(label)}" style="${t.img}">` : "";
          const data = `class="nlc-shot" data-shot="${esc(markKey)}" data-label="${esc(label)}"${sec ? ` data-sec="${esc(sec)}"` : ""}${pending ? ' data-pending="1"' : ""}`;
          return url
            ? `<img src="${esc(url)}" width="${CONTENT_WIDTH}" alt="${esc(label)}" ${data} style="${t.img}">`
            : `<div ${data} style="margin:4px 0 16px 0;padding:26px 24px;border:2px dashed #c7d2dc;border-radius:10px;background:#f7fafc;text-align:center;${t.F}font-size:13px;line-height:1.5;color:#6b7280;"><strong>${pending ? "Grabbing frame" : "Screenshot"}${sec ? ` @ ${esc(sec)}` : ""}</strong><br>${esc(label)}${pending ? "" : '<br><span style="color:#49adff;">Click to pick a frame, or drop an image here</span>'}</div>`;
        }
        const url = safeUrl(href);
        if (!url) return "";
        const data = ctx.canvas ? ` class="nlc-img" data-img="${ctx.images++}"` : "";
        return `<img src="${esc(url)}" width="${CONTENT_WIDTH}" alt="${esc(text)}"${data} style="${t.img}">`;
      },
    },
  });
  return m;
}

/**
 * One section's Markdown → email HTML. `buttons`: a line that is only a link
 * becomes a button. `inline`: inline content only (a label like "Read Time:
 * 47 sec."). Exported for tests.
 */
export function markdownToEmailHtml(
  markdown: string,
  style: NewsletterStyle,
  opts: { buttons?: boolean; canvas?: boolean; inline?: boolean; personalization?: Personalization } = {},
): string {
  const ctx: SectionRenderContext = { t: tokens(style), buttons: !!opts.buttons, canvas: !!opts.canvas, images: 0 };
  const m = markedFor(ctx);
  const out = opts.inline ? m.parseInline(markdown, { async: false }) : m.parse(markdown, { async: false });
  return applyPersonalization((out as string).trim(), opts.personalization ?? "sample");
}

/**
 * The Markdown a section renders from: the sponsor's promo copy when there
 * is one, and every screenshot placeholder swapped for its picked image (or,
 * on the canvas, a marker the image renderer draws as a spot; in the email,
 * nothing). Exported for tests.
 */
export function sectionMarkdown(args: RenderEmailArgs, sec: NewsletterTemplateSection): string {
  const raw = (args.sections.find((x) => x.key === sec.key)?.markdown ?? "").trim();
  const md = sec.kind === "sponsor" && args.sponsor?.copy?.trim() ? sponsorBlock(args.sponsor.copy, args.sponsor.landingUrl) : raw;
  const secFmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return replaceScreenshotMarks(md, (sec0, label) => {
    const markKey = screenshotKey(sec.key, label);
    const c = args.screenshots?.chosen?.[markKey];
    const url = c ? args.screenshots!.urlFor(c, markKey) : null;
    const clean = label.replace(/[[\]|]/g, "");
    if (!args.canvas) return url ? `\n![${SHOT}${markKey.replace(/\|/g, "")}|${clean}||](${url})\n` : "";
    return `\n![${SHOT}${markKey.replace(/\|/g, "")}|${clean}|${sec0 != null ? secFmt(sec0) : ""}|${c?.pending ? "1" : ""}](${url ?? "#"})\n`;
  }).replace(/\n{3,}/g, "\n\n");
}

export interface EmailSectionPart {
  key: string;
  /** The section's content (label applied), "" when there is none. */
  content: string;
  /** Nothing drafted here yet. */
  empty: boolean;
  /** Canvas: numbered steps with no screenshot yet (where "+ Add screenshot" goes). */
  addPoints: StepSpot[];
}

/** The email as the layout draws it: fixed design, the sections' slots, and boxes holding either. */
export type EmailBlock =
  | { kind: "fixed"; html: string; node: string }
  | ({ kind: "slot" } & EmailSectionPart)
  | { kind: "box"; color: string; children: EmailBlock[] };

export interface EmailParts {
  blocks: EmailBlock[];
  /** The email body cell's style (padding, font, color). */
  bodyStyle: Record<string, string>;
  background: string;
}

/** A tinted box (a layout `callout`), as React style for the canvas. */
export function boxStyle(color: string): Record<string, string> {
  return { background: color, borderRadius: "12px", padding: "20px 22px 6px 22px", marginBottom: "16px" };
}

/** One section's slot content. */
function slotPart(args: RenderEmailArgs, sec: NewsletterTemplateSection, t: ReturnType<typeof tokens>): EmailSectionPart {
  const st = args.template.style;
  const md = sectionMarkdown(args, sec);
  let content = md ? markdownToEmailHtml(md, st, { buttons: sec.linkButtons, canvas: args.canvas, inline: sec.look === "label", personalization: args.personalization }) : "";
  if (!content && args.showHints) {
    const sample = (title: string, body: string) =>
      `<div style="margin:4px 0 16px 0;padding:22px 24px;border:2px dashed #c7d2dc;border-radius:10px;background:#f7fafc;text-align:center;${t.F}font-size:13px;line-height:1.5;color:#6b7280;"><strong>${title}</strong><br>${body}</div>`;
    content =
      (sec.thumbnail && sec.kind !== "sponsor" ? sample("Video thumbnail", "Pulled from the video each draft. Swap or upload in the draft editor.") : "") +
      `<p style="${t.hint}">${esc(sec.hint || "(content)")}</p>` +
      (sec.screenshots && sec.kind !== "sponsor" ? sample("Screenshots go here in each draft", "AI marks the right moments in the video; Hub &amp; Spoke grabs those frames.") : "");
  }
  if (content && sec.look === "label") content = `${TABLE("margin:0 0 16px 0;")}<tr><td style="${t.label(sec.boxColor ?? "#e2e8f0")}">${content}</td></tr></table>`;
  return { key: sec.key, content, empty: !md, addPoints: args.canvas && sec.screenshots && sec.kind !== "sponsor" ? stepsWithoutScreenshots(md) : [] };
}

/** A fixed (designed) layout node as email HTML. */
function fixedHtml(node: DocNode, args: RenderEmailArgs, t: ReturnType<typeof tokens>): string {
  const st = args.template.style;
  switch (node.type) {
    case "image": {
      const src = safeUrl(String(node.attrs?.src ?? ""));
      if (!src) return "";
      const bg = typeof node.attrs?.background === "string" ? node.attrs.background : null;
      const img = `<img src="${esc(src)}" width="${CONTENT_WIDTH}" alt="${esc(String(node.attrs?.alt ?? ""))}" style="${t.mastheadImg}">`;
      const link = safeUrl(typeof node.attrs?.href === "string" ? node.attrs.href : null);
      return `${TABLE("margin:0 0 24px 0;", true)}<tr><td style="background:${bg ?? "transparent"};border-radius:12px;text-align:center;padding:0;">${link ? `<a href="${esc(link)}" target="_blank" style="display:block;">${img}</a>` : img}</td></tr></table>`;
    }
    case "heading": {
      const label = applyPersonalization(esc((node.content ?? []).map(function plain(n: DocNode): string {
        return (n.text ?? "") + (n.content ?? []).map(plain).join("");
      }).join("")), args.personalization ?? "sample");
      if (!label.trim()) return "";
      const pill = typeof node.attrs?.pill === "string" ? node.attrs.pill : null;
      const level = Number(node.attrs?.level) === 3 ? 3 : 2;
      return pill ? `${TABLE("margin:0 0 14px 0;")}<tr><td style="${t.pill(pill)}">${label}</td></tr></table>` : `<p style="${t.plainHeading(level)}">${label}</p>`;
    }
    case "horizontalRule":
      return divider(true);
    default:
      return markdownToEmailHtml(docToMarkdown({ type: "doc", content: [node] }), st, { personalization: args.personalization });
  }
}

/** The email in blocks, from the template's layout — the editor's canvas puts click-to-edit around each slot. */
export function renderEmailParts(args: RenderEmailArgs): EmailParts {
  const { template } = args;
  const st = template.style;
  const t = tokens(st);
  const byKey = new Map(template.sections.map((s) => [s.key, s]));
  const build = (nodes: DocNode[]): EmailBlock[] =>
    nodes.flatMap((node): EmailBlock[] => {
      if (node.type === "slot") {
        const sec = byKey.get(String(node.attrs?.key ?? ""));
        return sec ? [{ kind: "slot", ...slotPart(args, sec, t) }] : [];
      }
      if (node.type === "callout") return [{ kind: "box", color: typeof node.attrs?.color === "string" ? node.attrs.color : "#f1f5f9", children: build(node.content ?? []) }];
      const html = fixedHtml(node, args, t);
      return html ? [{ kind: "fixed", html, node: node.type }] : [];
    });
  return { blocks: build(layoutFor(template).content ?? []), bodyStyle: bodyStyle(st), background: st.contentBackground };
}

/**
 * The blocks the sent email keeps: an empty slot goes, and so does the
 * heading right above it; a box left with nothing but headings goes; dividers
 * never stack or sit at the very top / bottom. Pure; exported for tests.
 */
export function pruneForSend(blocks: EmailBlock[], top = true): EmailBlock[] {
  const kept: EmailBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "slot" && !b.content) {
      if (kept.length && kept[kept.length - 1].kind === "fixed" && (kept[kept.length - 1] as { node: string }).node === "heading") kept.pop();
      continue;
    }
    if (b.kind === "box") {
      const children = pruneForSend(b.children, false);
      if (!children.some((c) => !(c.kind === "fixed" && (c.node === "heading" || c.node === "horizontalRule")))) {
        if (kept.length && kept[kept.length - 1].kind === "fixed" && (kept[kept.length - 1] as { node: string }).node === "heading") kept.pop();
        continue;
      }
      kept.push({ ...b, children });
      continue;
    }
    kept.push(b);
  }
  const isRule = (b: EmailBlock | undefined) => b?.kind === "fixed" && b.node === "horizontalRule";
  const out = kept.filter((b, i) => !(isRule(b) && isRule(kept[i - 1])));
  if (top) {
    while (isRule(out[0])) out.shift();
    while (isRule(out[out.length - 1])) out.pop();
  }
  return out;
}

function blocksHtml(blocks: EmailBlock[], t: ReturnType<typeof tokens>): string {
  return blocks
    .map((b) => (b.kind === "fixed" ? b.html : b.kind === "slot" ? b.content : `${TABLE("margin:0 0 16px 0;", true)}<tr><td style="${t.box(b.color)}">${blocksHtml(b.children, t)}</td></tr></table>`))
    .join("");
}

/**
 * The email body as one fragment: the layout, empty sections (and their
 * headings) left out. What fills the HubSpot email's rich-text block (HubSpot
 * adds the footer under it) and what the full document wraps.
 */
export function renderEmailBody(args: RenderEmailArgs): string {
  const parts = renderEmailParts({ ...args, canvas: false });
  const t = tokens(args.template.style);
  return `${TABLE(`background:${parts.background};`, true)}<tr><td style="${cssText(parts.bodyStyle)}">${blocksHtml(pruneForSend(parts.blocks), t)}</td></tr></table>`;
}

/**
 * The email as a complete document, for the exact preview (desktop / phone)
 * and the format page's thumbnail: the body on the page background, 600px
 * wide, with the faint border HubSpot's own wrapper draws. `footerNote`: a
 * grey line under the email standing in for the footer the email tool adds.
 */
export function renderEmailHtml(args: RenderEmailArgs & { footerNote?: string | null }): string {
  const st = args.template.style;
  const t = tokens(st);
  const footer = args.footerNote
    ? `<p style="margin:14px 0 0 0;${t.F}font-size:12px;line-height:1.5;color:#9ca3af;text-align:center;">${esc(args.footerNote)}</p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(args.subject ?? "")}</title></head>
<body style="margin:0;padding:0;background:${st.pageBackground};-webkit-text-size-adjust:100%;">
${args.previewText ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${st.pageBackground};">${esc(args.previewText)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;background:${st.pageBackground};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;width:100%;max-width:${EMAIL_WIDTH}px;margin:0 auto;background:${st.contentBackground};border:1px solid #eaf0f6;border-radius:12px;overflow:hidden;"><tr><td style="padding:0;">
${renderEmailBody(args)}
</td></tr></table>
${footer}
</td></tr></table>
</body></html>`;
}
