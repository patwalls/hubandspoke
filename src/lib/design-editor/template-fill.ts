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
    let start = lower.indexOf(phrase);
    if (start < 0) continue;
    let end = start + phrase.length;
    // Whole words only: a phrase that stops before its closing punctuation
    // ("obese" in "obese.") would otherwise leave the "." as its own white
    // token with a space before it. Grow to the surrounding whitespace.
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    while (end < text.length && !/\s/.test(text[end])) end++;
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
  const frames = { list: ctx.frames ?? [], next: 0 };
  for (const page of template.pages) {
    const elements: DesignElement[] = [];
    let dropPage = false;
    // A page whose AI text all came back empty is an optional page the
    // post doesn't need (story slide 9 of a 6-beat story, app 4 of 3).
    let aiText = 0;
    let aiTextFilled = 0;
    for (const el of page.elements) {
      if (el.slot?.kind === "ai" && el.type === "text") aiText++;
      const filled = fillElement(el, byKey.get(el.id), ctx, frames);
      if (filled === "drop-page") {
        dropPage = true;
        break;
      }
      if (filled) {
        if (el.slot?.kind === "ai" && el.type === "text") aiTextFilled++;
        elements.push({ ...filled, id: newElementId(prefixFor(filled)) });
      }
    }
    if (dropPage || (aiText > 0 && aiTextFilled === 0)) continue;
    pages.push(reflowStacks({ ...page, id: newElementId("page"), elements }, template.canvas));
  }
  return { ...template, pages: pages.length > 0 ? pages : [{ id: newElementId("page"), background: "#0B0B0B", elements: [] }] };
}

function prefixFor(el: DesignElement): string {
  return el.type === "text" ? "t" : el.type === "image" ? "img" : el.type === "video" ? "v" : el.type === "captions" ? "c" : el.type === "channel" ? "ch" : "r";
}

function fillElement(el: DesignElement, value: DesignFillValue | undefined, ctx: DesignContext, frames: { list: DesignImageSource[]; next: number }): DesignElement | null | "drop-page" {
  if (!el.slot) return el;
  switch (el.slot.kind) {
    case "frame": {
      if (el.type !== "image") return el;
      const src = frames.list.length > 0 ? frames.list[frames.next++ % frames.list.length] : null;
      return { ...el, src: src ?? PHOTO_PLACEHOLDER };
    }
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

/** How much a stack may grow to fill its page — a five-line stack list is
 *  set bigger, not left floating in whitespace; a one-line one doesn't
 *  become a billboard. */
const STACK_MAX_GROW = 1.8;

/**
 * Elements sharing a `stack` key flow top-to-bottom in their order: each
 * starts where the previous ended plus the template's gap, text takes the
 * height its layout needs, and the whole stack is scaled together (font
 * sizes, gaps, picture heights) to FILL the page: up when there is room
 * (to `STACK_MAX_GROW`), down when it runs off the bottom — so a short
 * playbook and a long one both use the page.
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
    // The stack may fill the page down to its bottom margin — or down to the
    // first thing that isn't in the stack and sits below it (a channel row
    // under a CTA), which it must not grow over.
    const floor = elements.filter((el) => el.stack !== key && el.y > top).reduce((m, el) => Math.min(m, el.y - 24), canvas.height - 30);
    const bottomLimit = Math.max(floor, top + 40);
    for (let scale = STACK_MAX_GROW; scale >= 0.5; scale = Math.round((scale - 0.05) * 100) / 100) {
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
 *  that still shows the placeholder, and a different still into every
 *  frame slot still showing it (in document order, cycling through
 *  `frames`). Returns the new sources by element id, or null when nothing
 *  changed. */
export function applyPhotoPick(doc: DesignDoc, photo: DesignImageSource | null, frames: DesignImageSource[] = []): { doc: DesignDoc; elementIds: string[]; sources: Record<string, DesignImageSource> } | null {
  const ids: string[] = [];
  const sources: Record<string, DesignImageSource> = {};
  let next = 0;
  const pages = doc.pages.map((page) => ({
    ...page,
    elements: page.elements.map((el) => {
      if (el.type !== "image" || !isPhotoPlaceholder(el.src)) return el;
      let src: DesignImageSource | null = null;
      if (el.slot?.kind === "photo") src = photo;
      else if (el.slot?.kind === "frame" && frames.length > 0) src = frames[next++ % frames.length];
      if (!src) return el;
      ids.push(el.id);
      sources[el.id] = src;
      return { ...el, src };
    }),
  }));
  return ids.length > 0 ? { doc: { ...doc, pages }, elementIds: ids, sources } : null;
}
