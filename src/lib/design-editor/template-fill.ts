/**
 * Format templates → item documents.
 *
 * A format's design template is an ordinary DesignDoc whose elements may
 * carry a `slot` (doc.ts). Filling it for one post is pure:
 *
 *   listSlots(template)            what the AI has to write (for the prompt)
 *   fillTemplate(template, fill)   values + item context → the item's doc
 *
 * The AI never touches the document: it returns text per slot (with the
 * phrases to colour), a clip per video slot and the caption; this module
 * substitutes them, fills the system slots from the item (photo, video
 * title, channel), drops what couldn't be filled, and reflows the stacks.
 */
import { DM_KEYWORD_TOKEN, IG_SQUARE, PHOTO_PLACEHOLDER, isPhotoPlaceholder, newElementId, type DesignDoc, type DesignElement, type DesignImageSource, type DesignPage, type DesignSpan, type DesignTextElement } from "./doc";
import { layoutDesignText } from "./layout";
import type { DesignContext } from "./shared";

export const HIGHLIGHT_COLORS = { red: "#FF3B3B", green: "#22E07A", yellow: "#FFE14D" } as const;
export type HighlightColor = keyof typeof HIGHLIGHT_COLORS;

/** One thing the AI writes. `key` is the element id in the template. */
export interface DesignSlotSpec {
  key: string;
  kind: "text" | "video";
  name: string;
  hint: string;
  pageIndex: number;
  /** The template's own content, as the style example. */
  sample: string;
  /** Rough capacity of the box at its font size (text only). */
  maxChars: number | null;
  /** Colours the template's sample uses — the AI may highlight with these. */
  highlightColors: HighlightColor[];
}

export interface DesignFillValue {
  key: string;
  text?: string;
  highlights?: Array<{ phrase: string; color: HighlightColor }>;
  startSec?: number;
  endSec?: number;
}

/** What the AI returns for a template; stored as `design_docs.brief`. */
export interface DesignFill {
  caption: string;
  values: DesignFillValue[];
}

export function listSlots(doc: DesignDoc): DesignSlotSpec[] {
  const out: DesignSlotSpec[] = [];
  doc.pages.forEach((page, pageIndex) => {
    for (const el of page.elements) {
      if (!el.slot || el.slot.kind !== "ai") continue;
      if (el.type === "text") {
        const sample = el.spans.map((s) => s.text).join("");
        const colors = new Set<HighlightColor>();
        for (const s of el.spans) {
          const c = (Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).find((k) => HIGHLIGHT_COLORS[k].toLowerCase() === s.color?.toLowerCase());
          if (c) colors.add(c);
        }
        // Capacity: box area over the area of an average glyph cell, capped
        // so a huge autoFit box doesn't invite an essay.
        const cell = el.style.sizePx * el.style.sizePx * 0.58 * el.style.lineHeight;
        const maxChars = Math.max(8, Math.min(1200, Math.round(((el.w * el.h) / cell) * 0.85)));
        out.push({ key: el.id, kind: "text", name: el.name, hint: el.slot.hint, pageIndex, sample, maxChars, highlightColors: [...colors] });
      } else if (el.type === "video") {
        out.push({ key: el.id, kind: "video", name: el.name, hint: el.slot.hint, pageIndex, sample: "", maxChars: null, highlightColors: [] });
      }
    }
  });
  return out;
}

/** Split text into spans so each highlighted phrase gets its colour.
 *  Case-insensitive, first occurrence, phrases that don't appear are
 *  ignored (the model sometimes paraphrases its own headline). */
export function applyHighlights(text: string, highlights: Array<{ phrase: string; color: HighlightColor | string }>): DesignSpan[] {
  const marks: Array<{ start: number; end: number; color: string }> = [];
  const lower = text.toLowerCase();
  for (const h of highlights) {
    const phrase = h.phrase.trim().toLowerCase();
    if (!phrase) continue;
    const start = lower.indexOf(phrase);
    if (start < 0) continue;
    const end = start + phrase.length;
    if (marks.some((m) => start < m.end && end > m.start)) continue;
    const color = (HIGHLIGHT_COLORS as Record<string, string>)[h.color] ?? h.color;
    marks.push({ start, end, color });
  }
  marks.sort((a, b) => a.start - b.start);
  const spans: DesignSpan[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) spans.push({ text: text.slice(cursor, m.start) });
    spans.push({ text: text.slice(m.start, m.end), color: m.color });
    cursor = m.end;
  }
  if (cursor < text.length || spans.length === 0) spans.push({ text: text.slice(cursor) });
  return spans;
}

/**
 * The item's document from a template: fresh ids, slot values substituted,
 * system slots filled from `ctx`, unfillable things dropped (an AI text slot
 * with no value goes away; a video page with no clip or no source goes
 * away), then stacks reflowed.
 */
export function fillTemplate(template: DesignDoc, fill: DesignFill, ctx: DesignContext): DesignDoc {
  const byKey = new Map(fill.values.map((v) => [v.key, v]));
  const pages: DesignPage[] = [];
  for (const page of template.pages) {
    const elements: DesignElement[] = [];
    let dropPage = false;
    for (const el of page.elements) {
      const filled = fillElement(el, byKey.get(el.id), ctx);
      if (filled === "drop-page") {
        dropPage = true;
        break;
      }
      if (filled) elements.push({ ...filled, id: newElementId(prefixFor(filled)) });
    }
    if (dropPage) continue;
    pages.push(reflowStacks({ ...page, id: newElementId("page"), elements }, template.canvas));
  }
  return { ...template, pages: pages.length > 0 ? pages : [{ id: newElementId("page"), background: "#0B0B0B", elements: [] }] };
}

function prefixFor(el: DesignElement): string {
  return el.type === "text" ? "t" : el.type === "image" ? "img" : el.type === "video" ? "v" : el.type === "captions" ? "c" : el.type === "channel" ? "ch" : "r";
}

function fillElement(el: DesignElement, value: DesignFillValue | undefined, ctx: DesignContext): DesignElement | null | "drop-page" {
  if (!el.slot) return el;
  switch (el.slot.kind) {
    case "ai": {
      if (el.type === "text") {
        const text = value?.text?.trim() ?? "";
        if (!text) return null;
        return { ...el, spans: applyHighlights(text, value?.highlights ?? []) };
      }
      if (el.type === "video") {
        if (!ctx.source || value?.startSec === undefined || value?.endSec === undefined || value.endSec <= value.startSec) return "drop-page";
        return { ...el, src: { kind: "s3", bucket: ctx.source.bucket, key: ctx.source.key }, startSec: value.startSec, endSec: value.endSec };
      }
      return el;
    }
    case "photo":
      return el.type === "image" ? { ...el, src: ctx.photo ?? PHOTO_PLACEHOLDER } : el;
    case "videoTitle":
      return el.type === "text" ? { ...el, spans: [{ text: ctx.source?.title ?? el.spans.map((s) => s.text).join("") }] } : el;
    case "channelName":
      return el.type === "text" ? { ...el, spans: [{ text: `${ctx.channel.name} ✓` }] } : el;
    case "channelSubscribers":
      return el.type === "text" ? (ctx.channel.subscribers ? { ...el, spans: [{ text: ctx.channel.subscribers }] } : null) : el;
    case "dmKeyword":
      // The wording stays the template's; the token becomes the post's
      // attached keyword. Keep the pattern in the slot so a later keyword
      // change can re-substitute (applyDmKeyword). No keyword yet → the
      // token stays visible so nobody ships a CTA with a hole in it.
      return el.type === "text" ? substituteDmKeyword({ ...el, slot: { kind: "dmKeyword", hint: dmPattern(el) } }, ctx.dmKeyword ?? null) : el;
  }
}

/** The CTA's wording with the token, kept in `slot.hint` after filling. */
function dmPattern(el: DesignTextElement): string {
  return el.slot?.kind === "dmKeyword" && el.slot.hint.includes(DM_KEYWORD_TOKEN) ? el.slot.hint : el.spans.map((s) => s.text).join("");
}

function substituteDmKeyword(el: DesignTextElement, keyword: string | null): DesignTextElement {
  const pattern = dmPattern(el);
  if (!keyword) return { ...el, spans: [{ text: pattern }] };
  return { ...el, spans: [{ text: pattern.split(DM_KEYWORD_TOKEN).join(keyword.toUpperCase()) }] };
}

/** Re-substitute every DM-keyword element after the post's keyword changed. */
export function applyDmKeyword(doc: DesignDoc, keyword: string | null): DesignDoc {
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      elements: page.elements.map((el) => (el.type === "text" && el.slot?.kind === "dmKeyword" ? substituteDmKeyword(el, keyword) : el)),
    })),
  };
}

export function hasDmKeywordSlot(doc: DesignDoc): boolean {
  return doc.pages.some((p) => p.elements.some((el) => el.slot?.kind === "dmKeyword"));
}

/**
 * Elements sharing a `stack` key flow top-to-bottom in their order: each
 * starts where the previous ended plus the template's gap, text takes the
 * height its layout needs, and if the stack runs off the page everything in
 * it is scaled down together (font sizes and gaps) until it fits.
 */
export function reflowStacks(page: DesignPage, canvas: { width: number; height: number } = IG_SQUARE): DesignPage {
  const keys = [...new Set(page.elements.flatMap((el) => (el.stack ? [el.stack] : [])))];
  if (keys.length === 0) return page;
  let elements = page.elements;
  for (const key of keys) {
    const members = elements.filter((el) => el.stack === key);
    if (members.length === 0) continue;
    const top = members[0].y;
    // Gaps as authored (template order), measured before any drop.
    const gaps = members.map((el, i) => (i === 0 ? 0 : Math.max(0, el.y - (members[i - 1].y + members[i - 1].h))));
    const bottomLimit = canvas.height - 30;
    for (let scale = 1; scale >= 0.5; scale -= 0.05) {
      let y = top;
      const placed = members.map((el, i) => {
        y += Math.round(gaps[i] * scale);
        let next: DesignElement = { ...el, y };
        if (next.type === "text") {
          const style = { ...next.style, sizePx: Math.max(next.style.minSizePx, Math.round(el.type === "text" ? el.style.sizePx * scale : 0)), autoFit: false };
          const probe: DesignTextElement = { ...next, style, h: 4000 };
          next = { ...probe, h: Math.ceil(layoutDesignText(probe).blockHeightPx) };
        } else {
          next = { ...next, h: Math.round(el.h * scale) };
        }
        y = next.y + next.h;
        return next;
      });
      if (y <= bottomLimit || scale <= 0.5) {
        const byId = new Map(placed.map((el) => [el.id, el]));
        elements = elements.map((el) => byId.get(el.id) ?? el);
        break;
      }
    }
  }
  return { ...page, elements };
}

/** After the frames arrive: put the picked frame into every photo slot
 *  that still shows the placeholder. Returns null when nothing changed. */
export function applyPhotoPick(doc: DesignDoc, photo: DesignImageSource): { doc: DesignDoc; elementIds: string[] } | null {
  const ids: string[] = [];
  const pages = doc.pages.map((page) => ({
    ...page,
    elements: page.elements.map((el) => {
      if (el.type === "image" && el.slot?.kind === "photo" && isPhotoPlaceholder(el.src)) {
        ids.push(el.id);
        return { ...el, src: photo };
      }
      return el;
    }),
  }));
  return ids.length > 0 ? { doc: { ...doc, pages }, elementIds: ids } : null;
}
