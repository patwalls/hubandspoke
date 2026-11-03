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
