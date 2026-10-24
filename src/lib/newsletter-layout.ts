// A newsletter template's DESIGN is a document (`template.layout`, TipTap
// JSON edited WYSIWYG on the format page, like the email itself): the
// masthead image, headings (plain, or a colored pill), tinted boxes,
// dividers, fixed text — and SLOTS, one per AI section (`{ type: "slot",
// attrs: { key } }`), where each issue's drafted text goes. The template's
// `sections` stay the STRUCTURE the drafter reads (key, instructions, story,
// screenshots…); the layout says where each one sits and what's around it.
//
// Templates saved before 2026-10-23 have no layout: `layoutFor` builds one
// from their sections' old look settings (heading + pill color, tinted box,
// dividers, the masthead in `style`), so they render exactly as before.
// Pure.

import type { DocNode } from "@/lib/newsletter-rich-doc";
import type { NewsletterTemplate, NewsletterTemplateSection } from "@/lib/newsletter-template";

export type LayoutDoc = DocNode;

const text = (t: string): DocNode => ({ type: "text", text: t });

/** The layout an older template implies (no `layout` saved). Pure; exported for tests. */
export function layoutFromSections(template: NewsletterTemplate): LayoutDoc {
  const st = template.style;
  const content: DocNode[] = [];
  if (st.mastheadImageUrl) {
    content.push({ type: "image", attrs: { src: st.mastheadImageUrl, alt: "", href: st.mastheadLinkUrl ?? null, background: st.mastheadBackground ?? null } });
  }
  template.sections.forEach((sec, i) => {
    if (i > 0 && st.dividers) content.push({ type: "horizontalRule" });
    const heading: DocNode | null = sec.heading
      ? { type: "heading", attrs: { level: sec.headingLevel ?? 2, pill: sec.pillColor ?? null }, content: [text(sec.heading)] }
      : null;
    const slot: DocNode = { type: "slot", attrs: { key: sec.key } };
    if (heading) content.push(heading);
    // A tinted box (the sponsor's) holds the drafted text; a "label" look (Read Time) keeps its own chip.
    if (sec.boxColor && sec.look !== "label") content.push({ type: "callout", attrs: { color: sec.boxColor }, content: [slot] });
    else content.push(slot);
  });
  return { type: "doc", content };
}

/**
 * The template's layout: the saved one, else the one its sections imply. A
 * section the saved layout has no slot for (added by the template learner,
 * or by an older editor) is appended at the end with its heading, so no
 * section is ever silently left out of the email.
 */
export function layoutFor(template: NewsletterTemplate, override?: LayoutDoc | null): LayoutDoc {
  // A draft's own design (the editor changed a designed part in that issue) beats the template's.
  const saved = (override ?? template.layout) as LayoutDoc | null | undefined;
  if (!(saved?.type === "doc" && Array.isArray(saved.content))) return layoutFromSections(template);
  const have = new Set(slotKeys(saved));
  const missing = template.sections.filter((sec) => !have.has(sec.key));
  if (!missing.length) return saved;
  const extra = missing.flatMap((sec): DocNode[] => [
    ...(sec.heading ? [{ type: "heading", attrs: { level: sec.headingLevel ?? 2, pill: sec.pillColor ?? null }, content: [text(sec.heading)] }] : []),
    { type: "slot", attrs: { key: sec.key } },
  ]);
  return { ...saved, content: [...(saved.content ?? []), ...extra] };
}

/** Every slot key in the layout, in document order. Pure. */
export function slotKeys(layout: LayoutDoc): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === "slot" && typeof n.attrs?.key === "string") out.push(n.attrs.key);
    n.content?.forEach(walk);
  };
  walk(layout);
  return out;
}

const plain = (n: DocNode): string => (n.text ?? "") + (n.content ?? []).map(plain).join("");

/**
 * The heading the design puts right above each slot (same parent, nothing but
 * a heading in between), by slot key — the section's name for the drafter,
 * the past-issue examples and the editor. Pure; exported for tests.
 */
export function slotHeadings(layout: LayoutDoc): Record<string, { text: string; level: 2 | 3 } | null> {
  const out: Record<string, { text: string; level: 2 | 3 } | null> = {};
  const walk = (parent: DocNode, before: DocNode | null) => {
    (parent.content ?? []).forEach((n, i, arr) => {
      const prev = i > 0 ? arr[i - 1] : before;
      if (n.type === "slot" && typeof n.attrs?.key === "string") {
        out[n.attrs.key] = prev?.type === "heading" && plain(prev).trim() ? { text: plain(prev).trim(), level: Number(prev.attrs?.level) === 3 ? 3 : 2 } : null;
      }
      // A box's first child takes the heading just above the box.
      if (n.content && n.type !== "heading") walk(n, prev);
    });
  };
  walk(layout, null);
  return out;
}

/** A new section for a slot the designer just added. */
export function defaultSection(key: string): NewsletterTemplateSection {
  return {
    key,
    heading: null,
    headingLevel: 2,
    kind: "text",
    hint: "",
    pillColor: null,
    boxColor: null,
    screenshots: false,
    look: "text",
    thumbnail: false,
    bullets: "list",
    linkButtons: false,
    optional: false,
  };
}

/**
 * The template with its sections brought in line with the layout: in slot
 * order, a section for every slot (new slots get defaults), sections whose
 * slot was deleted dropped, and each one's heading taken from the design.
 * The old look fields are cleared — the layout owns the look now (a "label"
 * look and its color stay: Read Time's chip). Pure; exported for tests.
 */
export function withLayout(template: NewsletterTemplate, layout: LayoutDoc): NewsletterTemplate {
  const keys = [...new Set(slotKeys(layout))];
  const heads = slotHeadings(layout);
  const byKey = new Map(template.sections.map((s) => [s.key, s]));
  const sections = keys.map((key) => {
    const base = byKey.get(key) ?? defaultSection(key);
    const h = heads[key];
    return { ...base, heading: h?.text ?? null, headingLevel: h?.level ?? base.headingLevel, pillColor: null, boxColor: base.look === "label" ? base.boxColor : null };
  });
  return { ...template, layout: layout as NewsletterTemplate["layout"], sections: sections.length ? sections : template.sections };
}

/** A key for a new slot, unique in the template. Pure. */
export function newSlotKey(template: NewsletterTemplate, base = "section"): string {
  const taken = new Set(template.sections.map((s) => s.key));
  for (let n = template.sections.length + 1; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/**
 * The layout with `count` nodes starting at `path` (child indexes from the
 * doc down) replaced by `nodes` (zero or more). Pure; exported for tests.
 */
export function replaceAtPath(layout: LayoutDoc, path: number[], nodes: DocNode[], count = 1): LayoutDoc {
  if (!path.length) return layout;
  const [i, ...rest] = path;
  const content = [...(layout.content ?? [])];
  if (rest.length) content[i] = replaceAtPath(content[i], rest, nodes, count);
  else content.splice(i, count, ...nodes);
  return { ...layout, content };
}

/** The node at `path`, or null. Pure. */
export function nodeAtPath(layout: LayoutDoc, path: number[]): DocNode | null {
  let n: DocNode | undefined = layout;
  for (const i of path) n = n?.content?.[i];
  return n ?? null;
}
