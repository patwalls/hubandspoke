import { describe, it, expect } from "vitest";
import { buildPlaybookTemplate } from "@/lib/design-editor/playbook-template";
import { rehighlight } from "./page-canvas";
import { commands, createDesignStore } from "./store";

const doc = () => buildPlaybookTemplate();

describe("design store commands", () => {
  it("pages: add, duplicate (fresh ids), move, never remove the last one", () => {
    const store = createDesignStore({ doc: doc(), revision: 1 });
    const { apply } = store.getState();
    apply(commands.duplicatePage(0));
    const [a, b] = store.getState().doc.pages;
    expect(b.elements.map((e) => e.name)).toEqual(a.elements.map((e) => e.name));
    expect(new Set(b.elements.map((e) => e.id)).size).toBe(b.elements.length);
    expect(b.elements.every((e) => !a.elements.some((x) => x.id === e.id))).toBe(true);
    apply(commands.movePage(2, -1));
    expect(store.getState().doc.pages[1].id).not.toBe(b.id);
    for (let i = 0; i < 10; i++) apply(commands.removePage(0));
    expect(store.getState().doc.pages).toHaveLength(1);
  });

  it("elements: reorder z, duplicate offsets, remove; all undoable", () => {
    const store = createDesignStore({ doc: doc(), revision: 1 });
    const { apply } = store.getState();
    const first = store.getState().doc.pages[0].elements[0];
    apply(commands.reorderElement(0, first.id, "forward"));
    expect(store.getState().doc.pages[0].elements[1].id).toBe(first.id);
    apply(commands.duplicateElement(0, first.id));
    const copy = store.getState().doc.pages[0].elements.at(-1)!;
    expect(copy).toMatchObject({ x: first.x + 24, y: first.y + 24 });
    apply(commands.removeElement(0, copy.id));
    store.getState().undo();
    expect(store.getState().doc.pages[0].elements.at(-1)!.id).toBe(copy.id);
  });

  it("replaceDoc (a regeneration) resets history and dirtiness", () => {
    const store = createDesignStore({ doc: doc(), revision: 1 });
    store.getState().apply(commands.setPageBackground(0, "#123456"));
    expect(store.getState().saveState).toBe("dirty");
    store.getState().replaceDoc(doc(), 5);
    expect(store.getState()).toMatchObject({ saveState: "saved", revision: 5, past: [], future: [] });
  });
});

describe("rehighlight", () => {
  it("keeps coloured phrases after the text is edited, wherever they moved", () => {
    const spans = rehighlight("now the $69K/MONTH SAAS came first", [{ phrase: "$69K/MONTH SAAS", color: "#22E07A" }]);
    expect(spans).toEqual([{ text: "now the " }, { text: "$69K/MONTH SAAS", color: "#22E07A" }, { text: " came first" }]);
  });
  it("drops a phrase that no longer exists", () => {
    expect(rehighlight("plain", [{ phrase: "gone", color: "#FF3B3B" }])).toEqual([{ text: "plain" }]);
  });
});
