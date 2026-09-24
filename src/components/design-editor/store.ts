"use client";

/**
 * Design editor state — the same shape as the clip editor's store (immutable
 * doc + undo stack + save state), specialised for pages and elements.
 * Every doc change goes through `apply`, so everything inherits undo,
 * autosave and dirty tracking.
 */
import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import type { DesignDoc, DesignElement, DesignPage } from "@/lib/design-editor/doc";
import { newElementId } from "@/lib/design-editor/doc";

const HISTORY_LIMIT = 200;
const COALESCE_WINDOW_MS = 900;

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

export interface DesignSelection {
  pageIndex: number;
  elementId: string | null;
}

export interface DesignEditorState {
  doc: DesignDoc;
  past: DesignDoc[];
  future: DesignDoc[];
  lastChange: { key: string | null; at: number };
  revision: number;
  savedDoc: DesignDoc;
  saveState: SaveState;
  selection: DesignSelection;
  /** Element id → editable text mode. */
  editingElementId: string | null;

  apply: (mutate: (doc: DesignDoc) => DesignDoc, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  replaceDoc: (doc: DesignDoc, revision: number) => void;
  markSaving: () => void;
  markSaved: (doc: DesignDoc, revision: number) => void;
  markSaveFailed: (kind: "error" | "conflict") => void;
  select: (sel: DesignSelection) => void;
  setEditing: (id: string | null) => void;
}

function stateFor(doc: DesignDoc, savedDoc: DesignDoc, current: SaveState): SaveState {
  if (current === "conflict" || current === "saving") return current;
  return doc === savedDoc ? "saved" : "dirty";
}

export function createDesignStore(init: { doc: DesignDoc; revision: number }): StoreApi<DesignEditorState> {
  return createStore<DesignEditorState>((set, get) => ({
    doc: init.doc,
    past: [],
    future: [],
    lastChange: { key: null, at: 0 },
    revision: init.revision,
    savedDoc: init.doc,
    saveState: "saved",
    selection: { pageIndex: 0, elementId: null },
    editingElementId: null,

    apply: (mutate, coalesceKey) => {
      const { doc, past, lastChange, saveState } = get();
      const next = mutate(doc);
      if (next === doc) return;
      const now = Date.now();
      const coalesce =
        coalesceKey != null && lastChange.key === coalesceKey && now - lastChange.at < COALESCE_WINDOW_MS && past.length > 0;
      set({
        doc: next,
        past: coalesce ? past : [...past, doc].slice(-HISTORY_LIMIT),
        future: [],
        lastChange: { key: coalesceKey ?? null, at: now },
        saveState: saveState === "conflict" ? "conflict" : "dirty",
      });
    },
    undo: () => {
      const { doc, past, future, saveState, selection } = get();
      if (past.length === 0) return;
      const target = past[past.length - 1];
      set({
        doc: target,
        past: past.slice(0, -1),
        future: [doc, ...future],
        lastChange: { key: null, at: 0 },
        saveState: stateFor(target, get().savedDoc, saveState),
        selection: { pageIndex: Math.min(selection.pageIndex, target.pages.length - 1), elementId: null },
      });
    },
    redo: () => {
      const { doc, past, future, saveState, selection } = get();
      if (future.length === 0) return;
      set({
        doc: future[0],
        past: [...past, doc],
        future: future.slice(1),
        lastChange: { key: null, at: 0 },
        saveState: stateFor(future[0], get().savedDoc, saveState),
        selection: { pageIndex: Math.min(selection.pageIndex, future[0].pages.length - 1), elementId: null },
      });
    },
    /** A regeneration: brand-new doc from the server; history restarts. */
    replaceDoc: (doc, revision) =>
      set({ doc, past: [], future: [], revision, savedDoc: doc, saveState: "saved", selection: { pageIndex: 0, elementId: null }, editingElementId: null }),
    markSaving: () => set({ saveState: "saving" }),
    markSaved: (doc, revision) => set((s) => ({ savedDoc: doc, revision, saveState: s.doc === doc ? "saved" : "dirty" })),
    markSaveFailed: (kind) => set({ saveState: kind }),
    select: (selection) => set({ selection, editingElementId: null }),
    setEditing: (editingElementId) => set({ editingElementId }),
  }));
}

export const DesignStoreContext = createContext<StoreApi<DesignEditorState> | null>(null);

export function useDesign<T>(selector: (s: DesignEditorState) => T): T {
  const store = useContext(DesignStoreContext);
  if (!store) throw new Error("useDesign must be used inside the design editor");
  return useStore(store, selector);
}

export function useDesignStoreApi(): StoreApi<DesignEditorState> {
  const store = useContext(DesignStoreContext);
  if (!store) throw new Error("useDesignStoreApi must be used inside the design editor");
  return store;
}

// ─── Commands (pure doc → doc) ──────────────────────────────────────────────

function mapPage(doc: DesignDoc, pageIndex: number, fn: (p: DesignPage) => DesignPage): DesignDoc {
  const page = doc.pages[pageIndex];
  if (!page) return doc;
  const next = fn(page);
  if (next === page) return doc;
  return { ...doc, pages: doc.pages.map((p, i) => (i === pageIndex ? next : p)) };
}

export const commands = {
  patchElement:
    <E extends DesignElement>(pageIndex: number, id: string, patch: (el: E) => E) =>
    (doc: DesignDoc) =>
      mapPage(doc, pageIndex, (p) => ({ ...p, elements: p.elements.map((el) => (el.id === id ? patch(el as E) : el)) })),

  /** Append (on top), or insert at `at` in z-order. */
  addElement: (pageIndex: number, element: DesignElement, at?: number) => (doc: DesignDoc) =>
    mapPage(doc, pageIndex, (p) => {
      const i = at === undefined ? p.elements.length : Math.max(0, Math.min(p.elements.length, at));
      return { ...p, elements: [...p.elements.slice(0, i), element, ...p.elements.slice(i)] };
    }),

  removeElement: (pageIndex: number, id: string) => (doc: DesignDoc) =>
    mapPage(doc, pageIndex, (p) => ({ ...p, elements: p.elements.filter((el) => el.id !== id) })),

  /** Move one step in z-order. */
  reorderElement: (pageIndex: number, id: string, dir: "forward" | "backward") => (doc: DesignDoc) =>
    mapPage(doc, pageIndex, (p) => {
      const i = p.elements.findIndex((el) => el.id === id);
      const j = dir === "forward" ? i + 1 : i - 1;
      if (i < 0 || j < 0 || j >= p.elements.length) return p;
      const elements = [...p.elements];
      [elements[i], elements[j]] = [elements[j], elements[i]];
      return { ...p, elements };
    }),

  /** Move to an absolute z-index (0 = bottom), or all the way to the front/back. */
  moveElementTo: (pageIndex: number, id: string, to: number | "front" | "back") => (doc: DesignDoc) =>
    mapPage(doc, pageIndex, (p) => {
      const i = p.elements.findIndex((el) => el.id === id);
      if (i < 0) return p;
      const rest = p.elements.filter((el) => el.id !== id);
      const j = to === "front" ? rest.length : to === "back" ? 0 : Math.max(0, Math.min(rest.length, to));
      if (j === i) return p;
      return { ...p, elements: [...rest.slice(0, j), p.elements[i], ...rest.slice(j)] };
    }),

  duplicateElement: (pageIndex: number, id: string) => (doc: DesignDoc) =>
    mapPage(doc, pageIndex, (p) => {
      const el = p.elements.find((e) => e.id === id);
      if (!el) return p;
      return { ...p, elements: [...p.elements, { ...el, id: newElementId(el.type), x: el.x + 24, y: el.y + 24, name: `${el.name} copy` }] };
    }),

  setPageBackground: (pageIndex: number, background: string) => (doc: DesignDoc) =>
    mapPage(doc, pageIndex, (p) => ({ ...p, background })),

  addPage: (afterIndex: number, background: string) => (doc: DesignDoc) => ({
    ...doc,
    pages: [...doc.pages.slice(0, afterIndex + 1), { id: newElementId("page"), background, elements: [] }, ...doc.pages.slice(afterIndex + 1)],
  }),

  duplicatePage: (index: number) => (doc: DesignDoc) => {
    const page = doc.pages[index];
    if (!page) return doc;
    const copy: DesignPage = { ...page, id: newElementId("page"), elements: page.elements.map((el) => ({ ...el, id: newElementId(el.type) })) };
    return { ...doc, pages: [...doc.pages.slice(0, index + 1), copy, ...doc.pages.slice(index + 1)] };
  },

  removePage: (index: number) => (doc: DesignDoc) =>
    doc.pages.length <= 1 ? doc : { ...doc, pages: doc.pages.filter((_, i) => i !== index) },

  movePage: (index: number, dir: -1 | 1) => (doc: DesignDoc) => {
    const j = index + dir;
    if (j < 0 || j >= doc.pages.length) return doc;
    const pages = [...doc.pages];
    [pages[index], pages[j]] = [pages[j], pages[index]];
    return { ...doc, pages };
  },
};
