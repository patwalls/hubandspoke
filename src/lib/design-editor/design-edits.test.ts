import { describe, it, expect } from "vitest";
import { designEdits, summarizeDesignEdits } from "./design-edits";
import { buildPlaybookTemplate } from "./playbook-template";
import type { DesignDoc, DesignTextElement } from "./doc";

const clone = (d: DesignDoc): DesignDoc => structuredClone(d);
function firstText(d: DesignDoc, page = 0): DesignTextElement {
  const el = d.pages[page].elements.find((e) => e.type === "text");
  if (!el || el.type !== "text") throw new Error("fixture has no text element");
  return el;
}

describe("designEdits", () => {
  const generated = buildPlaybookTemplate();

  it("an untouched design has no edits", () => {
    expect(designEdits(generated, clone(generated))).toEqual([]);
  });

  it("a drag under the tolerance is a nudge, not a move", () => {
    const fin = clone(generated);
    firstText(fin).x += 3;
    expect(designEdits(generated, fin)).toEqual([]);
  });

  it("names each kind of change on the element it happened to", () => {
    const fin = clone(generated);
    const t = firstText(fin);
    t.spans = [{ text: "A DIFFERENT HEADLINE" }];
    t.y += 40;
    t.w += 20;
    t.style = { ...t.style, sizePx: t.style.sizePx - 10, color: "#123456" };
    const edits = designEdits(generated, fin);
    const name = firstText(generated).name;
    expect(edits).toEqual([
      { kind: "text", page: 0, element: name },
      { kind: "moved", page: 0, element: name },
      { kind: "resized", page: 0, element: name },
      { kind: "style", page: 0, element: name, fields: ["style.color", "style.sizePx"] },
    ]);
  });

  it("recolouring a highlight is style; rewording is text, not both", () => {
    const fin = clone(generated);
    const t = firstText(fin);
    t.spans = t.spans.map((s) => ({ ...s, color: "#00FF00" }));
    expect(designEdits(generated, fin).map((e) => e.kind)).toEqual(["style"]);
    expect(designEdits(generated, fin)[0].fields).toEqual(["spans.color"]);
  });

  it("removed and added elements, and a changed page background", () => {
    const fin = clone(generated);
    const removed = fin.pages[0].elements.shift()!;
    fin.pages[0].elements.push({ ...firstText(fin), id: "t-new", name: "My note" });
    fin.pages[0].background = "#000001";
    const edits = designEdits(generated, fin);
    expect(edits).toContainEqual({ kind: "removed", page: 0, element: removed.name || removed.type });
    expect(edits).toContainEqual({ kind: "added", page: 0, element: "My note" });
    expect(edits).toContainEqual({ kind: "style", page: 0, element: "page", fields: ["background"] });
  });

  it("deleting a page is one pages edit, not a removal per element", () => {
    const fin = clone(generated);
    expect(fin.pages.length).toBeGreaterThan(1);
    fin.pages.pop();
    const edits = designEdits(generated, fin);
    expect(edits).toEqual([{ kind: "pages", page: -1, element: "pages", fields: [`${generated.pages.length} → ${fin.pages.length}`] }]);
    expect(summarizeDesignEdits(edits)).toEqual([`pages pages (${generated.pages.length} → ${fin.pages.length})`]);
  });
});
