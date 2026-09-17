"use client";

/**
 * Editor state. One store instance per open editor (created by the dialog,
 * handed down via context) so two editors can never share state.
 *
 * Every change to the document goes through `apply`, which is what gives the
 * editor undo/redo for free: the doc is immutable, history is just a stack of
 * previous docs. There is no other way to mutate the doc — keep it that way
 * when adding features, and they inherit undo, autosave and dirty-tracking.
 */
import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import type { ClipEditDoc, Layer, RemovalReason, Section } from "@/lib/clip-editor/doc";
import { wordEditKey } from "@/lib/clip-editor/doc";
import {
  addRemoval,
  restoreRange,
  restoreReason,
  retimeSection,
} from "@/lib/clip-editor/removals";
import type { TimeRange } from "@/lib/clip-editor/doc";

const HISTORY_LIMIT = 200;
/** Same-key changes closer together than this collapse into one undo step
 *  (typing in the hook box, dragging a layer). */
const COALESCE_WINDOW_MS = 900;

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

/** Which thing on the stage the inspector is showing. */
export type StageSelection = { kind: "layer"; id: string } | { kind: "video" } | null;

export interface EditorState {
  doc: ClipEditDoc;
  past: ClipEditDoc[];
  future: ClipEditDoc[];
  lastChange: { key: string | null; at: number };

  /** Server revision the local doc is based on. */
  revision: number;
  /** The doc object last confirmed saved — identity compare = dirty check. */
  savedDoc: ClipEditDoc;
  saveState: SaveState;

  /** Selected transcript words, as positions in the editor's display list. */
  wordSelection: { anchor: number; focus: number } | null;
  stageSelection: StageSelection;

  apply: (mutate: (doc: ClipEditDoc) => ClipEditDoc, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  markSaving: () => void;
  markSaved: (doc: ClipEditDoc, revision: number) => void;
  markSaveFailed: (kind: "error" | "conflict") => void;
  setWordSelection: (sel: EditorState["wordSelection"]) => void;
  setStageSelection: (sel: StageSelection) => void;
}

/**
 * Undo/redo can land exactly on the saved document (docs are immutable, so
 * identity is a reliable test). That is "saved", not "dirty" — marking it
 * dirty would leave the indicator spinning over a save that has nothing to
 * send. A save already in flight keeps its state; a conflict is terminal.
 */
function stateFor(doc: ClipEditDoc, savedDoc: ClipEditDoc, current: SaveState): SaveState {
  if (current === "conflict" || current === "saving") return current;
  return doc === savedDoc ? "saved" : "dirty";
}

export function createEditorStore(init: {
  doc: ClipEditDoc;
  revision: number;
}): StoreApi<EditorState> {
  return createStore<EditorState>((set, get) => ({
    doc: init.doc,
    past: [],
    future: [],
    lastChange: { key: null, at: 0 },
    revision: init.revision,
    savedDoc: init.doc,
    saveState: "saved",
    wordSelection: null,
    stageSelection: null,

    apply: (mutate, coalesceKey) => {
      const { doc, past, lastChange, saveState } = get();
      const next = mutate(doc);
      if (next === doc) return;
      const now = Date.now();
      const coalesce =
        coalesceKey != null &&
        lastChange.key === coalesceKey &&
        now - lastChange.at < COALESCE_WINDOW_MS &&
        past.length > 0;
      set({
        doc: next,
        past: coalesce ? past : [...past, doc].slice(-HISTORY_LIMIT),
        future: [],
        lastChange: { key: coalesceKey ?? null, at: now },
        // A conflict is terminal until reload — don't mask it as "dirty".
        saveState: saveState === "conflict" ? "conflict" : "dirty",
      });
    },

    undo: () => {
      const { doc, past, future, saveState } = get();
      if (past.length === 0) return;
      const target = past[past.length - 1];
      set({
        doc: target,
        past: past.slice(0, -1),
        future: [doc, ...future],
        lastChange: { key: null, at: 0 },
        saveState: stateFor(target, get().savedDoc, saveState),
      });
    },

    redo: () => {
      const { doc, past, future, saveState } = get();
      if (future.length === 0) return;
      set({
        doc: future[0],
        past: [...past, doc],
        future: future.slice(1),
        lastChange: { key: null, at: 0 },
        saveState: stateFor(future[0], get().savedDoc, saveState),
      });
    },

    markSaving: () => set({ saveState: "saving" }),
    markSaved: (doc, revision) =>
      set((s) => ({
        savedDoc: doc,
        revision,
        // Edits made while the request was in flight keep us dirty.
        saveState: s.doc === doc ? "saved" : "dirty",
      })),
    markSaveFailed: (kind) => set({ saveState: kind }),
    setWordSelection: (wordSelection) => set({ wordSelection }),
    setStageSelection: (stageSelection) => set({ stageSelection }),
  }));
}

export const EditorStoreContext = createContext<StoreApi<EditorState> | null>(null);

export function useEditor<T>(selector: (s: EditorState) => T): T {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error("useEditor must be used inside the clip editor");
  return useStore(store, selector);
}

export function useEditorStoreApi(): StoreApi<EditorState> {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error("useEditorStoreApi must be used inside the clip editor");
  return store;
}

// ─── Document commands ─────────────────────────────────────────────────────
// Pure (doc) => doc functions. UI code calls `apply(commands.x(...))`; nothing
// here knows about React, the store, or playback.

function mapSection(
  doc: ClipEditDoc,
  sectionId: string,
  fn: (s: Section) => Section,
): ClipEditDoc {
  let changed = false;
  const sections = doc.sections.map((s) => {
    if (s.id !== sectionId) return s;
    const next = fn(s);
    if (next !== s) changed = true;
    return next;
  });
  return changed ? { ...doc, sections } : doc;
}

function mapLayer<L extends Layer>(
  doc: ClipEditDoc,
  layerId: string,
  fn: (l: L) => L,
): ClipEditDoc {
  return {
    ...doc,
    layers: doc.layers.map((l) => (l.id === layerId ? fn(l as L) : l)),
  };
}

export const commands = {
  remove:
    (sectionId: string, ranges: TimeRange[], reason: RemovalReason) =>
    (doc: ClipEditDoc) =>
      mapSection(doc, sectionId, (s) =>
        ranges.reduce<Section>((acc, r) => addRemoval(acc, r, reason), s),
      ),

  restore: (sectionId: string, ranges: TimeRange[]) => (doc: ClipEditDoc) =>
    mapSection(doc, sectionId, (s) =>
      ranges.reduce<Section>((acc, r) => restoreRange(acc, r), s),
    ),

  restoreAll: (reason: RemovalReason) => (doc: ClipEditDoc) => ({
    ...doc,
    sections: doc.sections.map((s) => restoreReason(s, reason)),
  }),

  retime: (sectionId: string, window: TimeRange) => (doc: ClipEditDoc) =>
    mapSection(doc, sectionId, (s) => retimeSection(s, window)),

  setIntro: (range: TimeRange | null) => (doc: ClipEditDoc) => {
    const withoutIntro = doc.sections.filter((s) => s.role !== "intro");
    if (!range) return { ...doc, sections: withoutIntro };
    return {
      ...doc,
      sections: [
        {
          id: "intro-1",
          role: "intro" as const,
          startSec: range.startSec,
          endSec: range.endSec,
          removals: [],
        },
        ...withoutIntro,
      ],
    };
  },

  patchLayer:
    <L extends Layer>(layerId: string, patch: (l: L) => L) =>
    (doc: ClipEditDoc) =>
      mapLayer(doc, layerId, patch),

  patchVideo: (patch: Partial<ClipEditDoc["video"]>) => (doc: ClipEditDoc) => ({
    ...doc,
    video: { ...doc.video, ...patch },
  }),

  /** Correct a transcript word. Setting it back to the original text clears
   *  the override rather than storing a no-op. */
  correctWord:
    (word: { startSec: number; text: string }, text: string) =>
    (doc: ClipEditDoc) => {
      const key = wordEditKey(word.startSec);
      const next = { ...doc.wordEdits };
      const trimmed = text.trim();
      if (!trimmed || trimmed === word.text) delete next[key];
      else next[key] = trimmed;
      return { ...doc, wordEdits: next };
    },
};
