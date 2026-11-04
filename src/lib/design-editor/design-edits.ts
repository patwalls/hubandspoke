/**
 * What an editor changed in a design between the AI's draft and the doc they
 * shipped — the design-editor counterpart of the drafts-learn pairs.
 *
 * `design_docs.generated_doc` keeps the doc exactly as the template + brief
 * built it (first draft or the last Regenerate); `design_docs.doc` is what
 * the editor made of it. `designEdits(generated, final)` lists the changes
 * per element so a format page can say "editors shrink the headline on 9 of
 * 12 posts" and a template fix can follow.
 *
 * Pure and structural (ids, numbers, colours) — no content meaning is read
 * here, so no LLM. Elements are matched by id within the same page index; a
 * template-filled element keeps its id through every edit the editor makes.
 */
import type { DesignDoc, DesignElement } from "./doc";

export type DesignEditKind =
  | "text" // the words changed
  | "moved"
  | "resized"
  | "style" // font, size, colour, opacity, crop zoom…
  | "image" // a different picture / video source
  | "removed"
  | "added"
  | "pages"; // the page count changed

export interface DesignEdit {
  kind: DesignEditKind;
  /** 0-based page index (the generated doc's for removed, the final's otherwise). -1 for `pages`. */
  page: number;
  /** The element's editor label ("Headline", "Stat"), or its type when unnamed. */
  element: string;
  /** The changed fields for `style` ("style.sizePx", "opacity"), or "4 → 5" for `pages`. */
  fields?: string[];
}

/** Moves/resizes smaller than this are nudges from dragging, not intent. */
export const GEOMETRY_TOLERANCE_PX = 4;

// Fields that never mean "the editor changed the look".
const IGNORED = new Set(["id", "name", "locked", "group", "slot", "stack", "type"]);
const GEOMETRY_POS = new Set(["x", "y"]);
const GEOMETRY_SIZE = new Set(["w", "h"]);
const IMAGE_FIELDS = new Set(["src"]);

function label(el: DesignElement): string {
  return el.name?.trim() || el.type;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function spansText(el: DesignElement): string | null {
  if (!("spans" in el) || !Array.isArray(el.spans)) return null;
  return el.spans.map((s) => s.text).join("");
}

function changedFields(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ""): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (same(a[k], b[k])) continue;
    const av = a[k];
    const bv = b[k];
    if (av && bv && typeof av === "object" && typeof bv === "object" && !Array.isArray(av) && !Array.isArray(bv)) {
      out.push(...changedFields(av as Record<string, unknown>, bv as Record<string, unknown>, `${prefix}${k}.`));
    } else {
      out.push(`${prefix}${k}`);
    }
  }
  return out;
}

function elementEdits(page: number, gen: DesignElement, fin: DesignElement): DesignEdit[] {
  const out: DesignEdit[] = [];
  const element = label(gen);
  const g = gen as unknown as Record<string, unknown>;
  const f = fin as unknown as Record<string, unknown>;

  const tg = spansText(gen);
  const tf = spansText(fin);
  if (tg !== null && tf !== null && tg !== tf) out.push({ kind: "text", page, element });

  const far = (k: string) => Math.abs(Number(g[k] ?? 0) - Number(f[k] ?? 0)) > GEOMETRY_TOLERANCE_PX;
  if ([...GEOMETRY_POS].some(far)) out.push({ kind: "moved", page, element });
  if ([...GEOMETRY_SIZE].some(far)) out.push({ kind: "resized", page, element });
  if ([...IMAGE_FIELDS].some((k) => k in g || k in f) && !same(g.src, f.src)) out.push({ kind: "image", page, element });

  const style: string[] = [];
  for (const k of new Set([...Object.keys(g), ...Object.keys(f)])) {
    if (IGNORED.has(k) || GEOMETRY_POS.has(k) || GEOMETRY_SIZE.has(k) || IMAGE_FIELDS.has(k)) continue;
    if (same(g[k], f[k])) continue;
    if (k === "spans") {
      // Only the highlight colours count as style; the words are `text`.
      const cg = (gen as { spans?: { color?: string }[] }).spans?.map((s) => s.color ?? null);
      const cf = (fin as { spans?: { color?: string }[] }).spans?.map((s) => s.color ?? null);
      if (tg === tf && !same(cg, cf)) style.push("spans.color");
      continue;
    }
    const gv = g[k];
    const fv = f[k];
    if (gv && fv && typeof gv === "object" && typeof fv === "object" && !Array.isArray(gv) && !Array.isArray(fv)) {
      style.push(...changedFields(gv as Record<string, unknown>, fv as Record<string, unknown>, `${k}.`));
    } else {
      style.push(k);
    }
  }
  if (style.length) out.push({ kind: "style", page, element, fields: style.sort() });
  return out;
}

export function designEdits(generated: DesignDoc, final: DesignDoc): DesignEdit[] {
  const out: DesignEdit[] = [];
  if (generated.pages.length !== final.pages.length) {
    out.push({ kind: "pages", page: -1, element: "pages", fields: [`${generated.pages.length} → ${final.pages.length}`] });
  }
  const n = Math.max(generated.pages.length, final.pages.length);
  for (let p = 0; p < n; p++) {
    const gp = generated.pages[p];
    const fp = final.pages[p];
    const gEls = gp?.elements ?? [];
    const fEls = fp?.elements ?? [];
    const fById = new Map(fEls.map((e) => [e.id, e]));
    const gIds = new Set(gEls.map((e) => e.id));
    // A page the editor deleted outright is one `pages` edit, not N removals.
    if (gp && fp) {
      for (const ge of gEls) {
        const fe = fById.get(ge.id);
        if (!fe) out.push({ kind: "removed", page: p, element: label(ge) });
        else out.push(...elementEdits(p, ge, fe));
      }
      for (const fe of fEls) if (!gIds.has(fe.id)) out.push({ kind: "added", page: p, element: label(fe) });
      if (gp.background !== fp.background) out.push({ kind: "style", page: p, element: "page", fields: ["background"] });
    }
  }
  return out;
}

/** One line per (kind, element) for a quick read: "style Headline (style.sizePx)". */
export function summarizeDesignEdits(edits: DesignEdit[]): string[] {
  return edits.map((e) => `${e.kind} ${e.element}${e.page >= 0 ? ` p${e.page + 1}` : ""}${e.fields?.length ? ` (${e.fields.join(", ")})` : ""}`);
}

// ── Per-format roll-up (design-edits M2) ────────────────────────────────────

/** One post's design as the format page reads it. `generated` is only there
 *  for designs drafted after 2026-11-03 (design_docs.generated_doc); the AI's
 *  words (`briefTexts`, from design_docs.brief) are there for every draft. */
export interface DesignEditSample {
  briefTexts: string[];
  generated: DesignDoc | null;
  final: DesignDoc;
}

/** One template element across recent posts: on how many posts it was there,
 *  and on how many of those editors changed its words / place / size / look. */
export interface TemplateEditRow {
  element: string;
  posts: number;
  text: number;
  moved: number;
  resized: number;
  style: number;
  /** Posts compared against the kept draft (moved/resized/style are out of these). */
  layoutPosts: number;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Roll a format's recent designs up per AI-filled element ("Headline").
 *
 * Words: an element the AI filled (slot `ai`, has spans) whose text matches
 * none of the brief's values was rewritten — this works for every draft,
 * because the slot and the brief survive the editor's saves. Look (moved,
 * resized, style): only where the draft was kept (`generated`), via
 * `designEdits`. An element counts once per post however many pages it is on.
 * Sorted by most-changed first; elements nobody changed are dropped.
 */
export function rollUpTemplateEdits(samples: DesignEditSample[]): TemplateEditRow[] {
  const rows = new Map<string, TemplateEditRow>();
  const row = (element: string) => {
    let r = rows.get(element);
    if (!r) rows.set(element, (r = { element, posts: 0, text: 0, moved: 0, resized: 0, style: 0, layoutPosts: 0 }));
    return r;
  };
  for (const s of samples) {
    const brief = new Set(s.briefTexts.map(norm).filter(Boolean));
    const seen = new Set<string>();
    const rewritten = new Set<string>();
    for (const page of s.final.pages) {
      for (const el of page.elements) {
        if (el.slot?.kind !== "ai") continue;
        const text = spansText(el);
        if (text === null) continue;
        const name = label(el);
        seen.add(name);
        if (!brief.has(norm(text))) rewritten.add(name);
      }
    }
    for (const name of seen) {
      const r = row(name);
      r.posts++;
      if (rewritten.has(name)) r.text++;
    }
    if (!s.generated) continue;
    const kinds = new Map<string, Set<DesignEditKind>>();
    for (const e of designEdits(s.generated, s.final)) {
      if (!seen.has(e.element)) continue;
      if (e.kind !== "moved" && e.kind !== "resized" && e.kind !== "style") continue;
      if (!kinds.has(e.element)) kinds.set(e.element, new Set());
      kinds.get(e.element)!.add(e.kind);
    }
    for (const name of seen) {
      const r = row(name);
      r.layoutPosts++;
      const k = kinds.get(name);
      if (k?.has("moved")) r.moved++;
      if (k?.has("resized")) r.resized++;
      if (k?.has("style")) r.style++;
    }
  }
  const changed = (r: TemplateEditRow) => Math.max(r.text, r.moved, r.resized, r.style);
  return [...rows.values()].filter((r) => changed(r) > 0).sort((a, b) => changed(b) / b.posts - changed(a) / a.posts || b.posts - a.posts);
}

/** "words rewritten on 4 of 9 posts · made smaller… " for one row. */
export function describeTemplateEditRow(r: TemplateEditRow): string {
  const parts: string[] = [];
  if (r.text) parts.push(`words rewritten on ${r.text} of ${r.posts}`);
  if (r.moved) parts.push(`moved on ${r.moved} of ${r.layoutPosts}`);
  if (r.resized) parts.push(`resized on ${r.resized} of ${r.layoutPosts}`);
  if (r.style) parts.push(`restyled on ${r.style} of ${r.layoutPosts}`);
  return parts.join(" · ");
}

// ── The AI's words → the editor's words, per slot (design-edits M4) ─────────

/** One AI-filled text the editor rewrote before shipping: what the brief
 *  wrote and what the post went out with. Teaches the next fill. */
export interface SlotRewrite {
  /** The element's editor label ("Headline"). */
  slot: string;
  ai: string;
  edited: string;
}

/** Where a brief key sat in the format's template (listSlots: key, name, page). */
export interface SlotPlace {
  key: string;
  name: string;
  pageIndex: number;
}

/**
 * The (AI wrote → editor shipped) pairs in one post's design.
 *
 * With the kept draft (`generated`, 2026-11-03+) the match is exact: the
 * same element id in the draft and the final, its words changed. Without it
 * (older drafts) the brief's value is placed through the format's template —
 * key → slot name + page — and paired with the final's ONE AI element of
 * that name on that page; ambiguous or missing matches are skipped rather
 * than guessed. Words the editor only re-spaced are not a rewrite, and a
 * final text that is some other brief value (the editor swapped two slots'
 * words) is not one either. Pure.
 */
export function slotRewrites(args: {
  final: DesignDoc;
  generated: DesignDoc | null;
  brief: Array<{ key: string; text: string }>;
  places: SlotPlace[];
}): SlotRewrite[] {
  const out: SlotRewrite[] = [];
  const briefSet = new Set(args.brief.map((b) => norm(b.text)).filter(Boolean));
  const aiTexts = (doc: DesignDoc) =>
    doc.pages.flatMap((p, page) =>
      p.elements.flatMap((el) => {
        if (el.slot?.kind !== "ai") return [];
        const text = spansText(el);
        return text === null ? [] : [{ id: el.id, page, name: label(el), text }];
      }),
    );
  const finals = aiTexts(args.final);
  const push = (slot: string, ai: string, edited: string) => {
    const a = norm(ai);
    const e = norm(edited);
    if (!a || !e || a === e || briefSet.has(e)) return;
    out.push({ slot, ai: a, edited: e });
  };
  if (args.generated) {
    const byId = new Map(finals.map((f) => [f.id, f]));
    for (const g of aiTexts(args.generated)) {
      const f = byId.get(g.id);
      if (f) push(g.name, g.text, f.text);
    }
    return out;
  }
  const placeByKey = new Map(args.places.map((p) => [p.key, p]));
  for (const b of args.brief) {
    const place = placeByKey.get(b.key);
    if (!place) continue;
    const matches = finals.filter((f) => f.page === place.pageIndex && f.name === place.name);
    if (matches.length !== 1) continue;
    push(place.name, b.text, matches[0].text);
  }
  return out;
}
