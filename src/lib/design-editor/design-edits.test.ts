import { describe, it, expect } from "vitest";
import { describeTemplateEditRow, designEdits, rollUpTemplateEdits, slotRewrites, summarizeDesignEdits, type DesignEditSample, type SlotPlace } from "./design-edits";
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

describe("rollUpTemplateEdits (format page: what editors change)", () => {
  const template = buildPlaybookTemplate();
  const aiTexts = (d: DesignDoc) =>
    d.pages.flatMap((p) => p.elements).filter((e): e is DesignTextElement => e.type === "text" && e.slot?.kind === "ai");
  const words = (d: DesignDoc) => aiTexts(d).map((e) => e.spans.map((s) => s.text).join(""));
  const sample = (final: DesignDoc, generated: DesignDoc | null = null, briefTexts = words(template)): DesignEditSample => ({ briefTexts, generated, final });

  it("fixture has AI text slots", () => {
    expect(aiTexts(template).length).toBeGreaterThan(0);
  });

  it("a design shipped as drafted shows nothing", () => {
    expect(rollUpTemplateEdits([sample(clone(template), clone(template))])).toEqual([]);
  });

  it("counts a rewrite once per post, out of the posts the element was on, even without a kept draft", () => {
    const a = clone(template);
    const target = aiTexts(a)[0];
    target.spans = [{ text: "EDITOR WROTE THIS" }];
    const rows = rollUpTemplateEdits([sample(a), sample(clone(template)), sample(clone(template))]);
    const row = rows.find((r) => r.element === (target.name || "text"))!;
    expect(row.text).toBe(1);
    expect(row.posts).toBeGreaterThanOrEqual(3);
    expect(row.layoutPosts).toBe(0);
    expect(describeTemplateEditRow(row)).toMatch(/^words rewritten on 1 of \d+$/);
  });

  it("whitespace-only differences are not a rewrite", () => {
    const a = clone(template);
    const t = aiTexts(a)[0];
    t.spans = [{ text: `  ${t.spans.map((s) => s.text).join("")}  ` }];
    expect(rollUpTemplateEdits([sample(a)])).toEqual([]);
  });

  it("look changes come only from posts with a kept draft, out of those posts", () => {
    const gen = clone(template);
    const fin = clone(gen);
    const t = aiTexts(fin)[0];
    t.style = { ...t.style, sizePx: t.style.sizePx - 10 };
    t.y += 50;
    const rows = rollUpTemplateEdits([sample(fin, gen), sample(clone(template))]);
    const row = rows.find((r) => r.element === (t.name || "text"))!;
    expect(row).toMatchObject({ style: 1, moved: 1, resized: 0, text: 0, layoutPosts: 1 });
    expect(row.posts).toBeGreaterThanOrEqual(2);
    expect(describeTemplateEditRow(row)).toBe("moved on 1 of 1 · restyled on 1 of 1");
  });
});

describe("slotRewrites (design-edits M4: the AI's words → the editor's)", () => {
  const template = buildPlaybookTemplate();
  const aiTexts = (d: DesignDoc) =>
    d.pages.flatMap((p) => p.elements).filter((e): e is DesignTextElement => e.type === "text" && e.slot?.kind === "ai");
  const text = (e: DesignTextElement) => e.spans.map((s) => s.text).join("");
  // The template as listSlots sees it: brief keys are its element ids.
  const places: SlotPlace[] = template.pages.flatMap((p, pageIndex) =>
    p.elements.filter((e) => e.slot?.kind === "ai" && e.type === "text").map((e) => ({ key: e.id, name: e.name || e.type, pageIndex })),
  );
  const brief = aiTexts(template).map((e) => ({ key: e.id, text: text(e) }));
  // fillTemplate gives every element a fresh id: a post's doc never shares ids with the template.
  const filled = () => {
    const d = clone(template);
    for (const e of d.pages.flatMap((p) => p.elements)) e.id = `${e.id}-post`;
    return d;
  };

  it("with the kept draft: pairs by element id, only where the words changed", () => {
    const gen = filled();
    const fin = clone(gen);
    const t = aiTexts(fin)[0];
    t.spans = [{ text: "Shorter, the editor's way" }];
    expect(slotRewrites({ final: fin, generated: gen, brief, places })).toEqual([
      { slot: t.name || "text", ai: text(aiTexts(gen)[0]).replace(/\s+/g, " ").trim(), edited: "Shorter, the editor's way" },
    ]);
  });

  it("without it: places the brief through the template (name + page), even though ids changed", () => {
    const fin = filled();
    const t = aiTexts(fin)[0];
    t.spans = [{ text: "Editor's headline" }];
    const out = slotRewrites({ final: fin, generated: null, brief, places });
    expect(out).toEqual([{ slot: t.name || "text", ai: brief[0].text.replace(/\s+/g, " ").trim(), edited: "Editor's headline" }]);
  });

  it("a design shipped as drafted, re-spaced words, or words moved from another slot teach nothing", () => {
    const fin = filled();
    const [a, b] = aiTexts(fin);
    a.spans = [{ text: `  ${text(a)}  ` }];
    if (b) b.spans = [{ text: brief[0].text }];
    expect(slotRewrites({ final: filled(), generated: null, brief, places })).toEqual([]);
    expect(slotRewrites({ final: fin, generated: null, brief, places })).toEqual([]);
  });

  it("skips a brief value whose slot is gone from the template (the template changed since)", () => {
    const fin = filled();
    aiTexts(fin)[0].spans = [{ text: "Editor's headline" }];
    expect(slotRewrites({ final: fin, generated: null, brief, places: [] })).toEqual([]);
  });
});
