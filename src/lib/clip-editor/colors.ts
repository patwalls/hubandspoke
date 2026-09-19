/** Every colour a clip document uses, most-used first — for the picker's
 *  "In this clip" row. Pure. */
import type { ClipEditDoc } from "./doc";

export function colorsInClipDoc(doc: ClipEditDoc): string[] {
  const counts = new Map<string, number>();
  const add = (c: string | null | undefined) => {
    if (!c) return;
    const k = c.toUpperCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  add(doc.canvas.background);
  for (const l of doc.layers) {
    add(l.style.color);
    if (l.style.outlinePct > 0) add(l.style.outlineColor);
    if (l.type === "captions") add(l.highlightColor);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}
