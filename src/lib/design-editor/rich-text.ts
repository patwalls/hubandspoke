/**
 * The inline text editor's model: the text plus each character's colour and
 * weight. Formatting is by POSITION, as in a doc — colouring one "($200/mo)"
 * leaves the other alone — and the editor draws it live as you click
 * (page-canvas.tsx → TextEditor). Spans are only what it saves.
 */
import type { DesignSpan } from "./doc";

export interface CharStyle {
  color: string | null;
  bold: boolean;
}
export interface RichText {
  text: string;
  /** One per UTF-16 unit of `text` (what DOM selection offsets count). */
  styles: CharStyle[];
}

const PLAIN: CharStyle = { color: null, bold: false };

export function spansToRich(spans: DesignSpan[]): RichText {
  return {
    text: spans.map((s) => s.text).join(""),
    styles: spans.flatMap((s) => Array.from({ length: s.text.length }, () => ({ color: s.color ?? null, bold: !!s.bold }))),
  };
}

/** Runs of equal style — what the editor draws and what gets saved. */
export function richRuns(rt: RichText): Array<{ text: string } & CharStyle> {
  const runs: Array<{ text: string } & CharStyle> = [];
  for (let i = 0; i < rt.text.length; i++) {
    const st = rt.styles[i] ?? PLAIN;
    const last = runs[runs.length - 1];
    if (last && last.color === st.color && last.bold === st.bold) last.text += rt.text[i];
    else runs.push({ text: rt.text[i], ...st });
  }
  return runs;
}

export function richToSpans(rt: RichText): DesignSpan[] {
  const spans: DesignSpan[] = richRuns(rt).map((r) => ({ text: r.text, ...(r.color ? { color: r.color } : {}), ...(r.bold ? { bold: true } : {}) }));
  return spans.length ? spans : [{ text: "" }];
}

/** A selection grown to whole words, so formatting never splits a word into
 *  two spans (layout breaks words at span edges). A caret picks its word. */
export function wordRange(text: string, start: number, end: number): [number, number] {
  const ws = (i: number) => /\s/.test(text[i] ?? " ");
  let s = Math.min(start, end);
  let e = Math.max(start, end);
  const collapsed = s === e;
  while (s > 0 && !ws(s - 1) && (collapsed || !ws(s))) s--;
  while (e < text.length && !ws(e) && (collapsed || e === s || !ws(e - 1))) e++;
  return [s, e];
}

/** Apply `patch` to [start, end), grown to whole words. */
export function formatRange(rt: RichText, start: number, end: number, patch: Partial<CharStyle>): { rt: RichText; range: [number, number] } {
  const [s, e] = wordRange(rt.text, start, end);
  const styles = rt.styles.map((st, i) => (i >= s && i < e ? { ...st, ...patch } : st));
  return { rt: { text: rt.text, styles }, range: [s, e] };
}

/** Bold on unless every letter in the (word-grown) range already is. */
export function isRangeBold(rt: RichText, start: number, end: number): boolean {
  const [s, e] = wordRange(rt.text, start, end);
  let any = false;
  for (let i = s; i < e; i++) {
    if (/\s/.test(rt.text[i])) continue;
    any = true;
    if (!rt.styles[i]?.bold) return false;
  }
  return any;
}

/** Replace [start, end) with `insert`; typed characters take the style of
 *  the character before them (typing on after a bold word stays bold). */
export function insertRich(rt: RichText, start: number, end: number, insert: string): RichText {
  const inherit = rt.styles[start - 1] ?? rt.styles[end] ?? PLAIN;
  return {
    text: rt.text.slice(0, start) + insert + rt.text.slice(end),
    styles: [...rt.styles.slice(0, start), ...Array.from({ length: insert.length }, () => ({ ...inherit })), ...rt.styles.slice(end)],
  };
}
