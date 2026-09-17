import { describe, it, expect } from "vitest";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import { commands, createEditorStore } from "./store";

const make = () =>
  createEditorStore({ doc: createDefaultDoc({ startSec: 100, endSec: 110, hook: "h" }), revision: 1 });
const cut = commands.remove("body", [{ startSec: 102, endSec: 103 }], "manual");

describe("editor store", () => {
  it("undo and redo restore exact documents", () => {
    const store = make();
    const original = store.getState().doc;
    store.getState().apply(cut);
    const edited = store.getState().doc;
    expect(edited.sections[0].removals).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().doc).toBe(original);
    store.getState().redo();
    expect(store.getState().doc).toBe(edited);
  });

  it("a new edit clears the redo stack", () => {
    const store = make();
    store.getState().apply(cut);
    store.getState().undo();
    store.getState().apply(commands.patchVideo({ yPct: 40 }));
    expect(store.getState().future).toHaveLength(0);
  });

  it("coalesces same-key changes into one undo step", () => {
    const store = make();
    for (const y of [41, 42, 43]) store.getState().apply(commands.patchVideo({ yPct: y }), "drag");
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().doc.video.yPct).toBe(50);
  });

  it("a no-op mutation records nothing", () => {
    const store = make();
    store.getState().apply((d) => d);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().saveState).toBe("saved");
  });

  it("undoing back to the saved document reads as saved, not dirty", () => {
    const store = make();
    store.getState().apply(cut);
    expect(store.getState().saveState).toBe("dirty");
    store.getState().undo();
    expect(store.getState().saveState).toBe("saved");
    store.getState().redo();
    expect(store.getState().saveState).toBe("dirty");
  });

  it("an edit made while a save is in flight keeps the editor dirty afterwards", () => {
    const store = make();
    store.getState().apply(cut);
    const sent = store.getState().doc;
    store.getState().markSaving();
    store.getState().apply(commands.patchVideo({ yPct: 40 }));
    store.getState().markSaved(sent, 2);
    expect(store.getState()).toMatchObject({ saveState: "dirty", revision: 2 });
  });

  it("a conflict is terminal — later edits do not mask it", () => {
    const store = make();
    store.getState().markSaveFailed("conflict");
    store.getState().apply(cut);
    store.getState().undo();
    expect(store.getState().saveState).toBe("conflict");
  });
});
