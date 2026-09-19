/** Every colour a design document uses, most-used first — for the picker's
 *  "In this design" row. Pure. */
import type { DesignDoc } from "./doc";

export function colorsInDesignDoc(doc: DesignDoc): string[] {
  const counts = new Map<string, number>();
  const add = (c: string | null | undefined) => {
    if (!c) return;
    const k = c.toUpperCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (const page of doc.pages) {
    add(page.background);
    for (const el of page.elements) {
      if (el.type === "text" || el.type === "captions") {
        add(el.style.color);
        add(el.style.shadow?.color);
        if (el.type === "text") for (const s of el.spans) add(s.color);
      } else if (el.type === "rect") {
        add(el.fill.color);
        add(el.gradientTo?.color);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}
