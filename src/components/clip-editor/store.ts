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
import type { ClipEditDoc, Layer, MediaAsset, RemovalReason, Section } from "@/lib/clip-editor/doc";
import { wordEditKey } from "@/lib/clip-editor/doc";
import { addRemoval, restoreRange, restoreReason } from "@/lib/clip-editor/removals";
import { deleteSection, includeRange, insertMediaScene, moveSection, pastePieces, retimeSectionInDoc, splitSectionAt, type ClipPiece } from "@/lib/clip-editor/sections";
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
  /** The scene (section) picked on the timeline — framing edits in the
   *  preview and the Video panel apply to it alone. Null = no pick. */
  sceneSelection: string | null;
  /** Browser URL per image layer id — resolved by the session for stored
   *  layers, registered by the logo picker for layers added here. Not part
   *  of the doc (URLs expire; the doc keeps the durable source). */
  imageUrls: Record<string, string>;
  /** Playable URL per uploaded clip id (`doc.media`) — same deal. */
  mediaUrls: Record<string, string>;

  apply: (mutate: (doc: ClipEditDoc) => ClipEditDoc, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  markSaving: () => void;
  markSaved: (doc: ClipEditDoc, revision: number) => void;
  markSaveFailed: (kind: "error" | "conflict") => void;
  setWordSelection: (sel: EditorState["wordSelection"]) => void;
  setStageSelection: (sel: StageSelection) => void;
  setSceneSelection: (sectionId: string | null) => void;
  registerImageUrl: (layerId: string, url: string) => void;
  registerMediaUrl: (mediaId: string, url: string) => void;
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
  /** What the server has. */
  doc: ClipEditDoc;
  revision: number;
  /** Unsaved edits recovered from this browser (local-backup.ts). The editor
   *  opens on them, already dirty, so the normal autosave sends them up. */
  recoveredDoc?: ClipEditDoc | null;
  imageUrls?: Record<string, string>;
  mediaUrls?: Record<string, string>;
}): StoreApi<EditorState> {
  return createStore<EditorState>((set, get) => ({
    doc: init.recoveredDoc ?? init.doc,
    past: [],
    future: [],
    lastChange: { key: null, at: 0 },
    revision: init.revision,
    savedDoc: init.doc,
    saveState: init.recoveredDoc ? "dirty" : "saved",
    wordSelection: null,
    stageSelection: null,
    sceneSelection: null,
    imageUrls: init.imageUrls ?? {},
    mediaUrls: init.mediaUrls ?? {},

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
    setSceneSelection: (sceneSelection) => set({ sceneSelection }),
    registerImageUrl: (layerId, url) => set({ imageUrls: { ...get().imageUrls, [layerId]: url } }),
    registerMediaUrl: (mediaId, url) => set({ mediaUrls: { ...get().mediaUrls, [mediaId]: url } }),
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

  /** Move a section's in/out points (clamped to its neighbours). */
  retime: (sectionId: string, window: TimeRange) => (doc: ClipEditDoc) =>
    retimeSectionInDoc(doc, sectionId, window),

  /** Drag a scene to another place in the play order. */
  moveSection: (sectionId: string, toIndex: number) => (doc: ClipEditDoc) => moveSection(doc, sectionId, toIndex),
  insertMediaScene: (media: MediaAsset, atIndex: number) => (doc: ClipEditDoc) => insertMediaScene(doc, media, atIndex),
  /** An uploaded clip's transcript arrived. */
  setMediaWords: (mediaId: string, words: NonNullable<MediaAsset["words"]>) => (doc: ClipEditDoc) =>
    doc.media.some((m) => m.id === mediaId)
      ? { ...doc, media: doc.media.map((m) => (m.id === mediaId ? { ...m, words } : m)) }
      : doc,

  /** Blade: cut a section in two at a source time. */
  split: (sectionId: string, atSec: number) => (doc: ClipEditDoc) =>
    splitSectionAt(doc, sectionId, atSec),

  /** Paste copied text (its footage) as new scenes at the cursor. */
  paste: (pieces: ClipPiece[], at: { sectionId: string; atSec: number }) => (doc: ClipEditDoc) =>
    pastePieces(doc, pieces, at),

  /** Delete a whole piece of the clip (never the last one). */
  deleteSection: (sectionId: string) => (doc: ClipEditDoc) => deleteSection(doc, sectionId),

  /** Add source ranges to the clip — new sections, or extensions of the
   *  sections they touch. */
  include: (ranges: TimeRange[]) => (doc: ClipEditDoc) =>
    ranges.reduce<ClipEditDoc>((d, r) => includeRange(d, r), doc),

  patchLayer:
    <L extends Layer>(layerId: string, patch: (l: L) => L) =>
    (doc: ClipEditDoc) =>
      mapLayer(doc, layerId, patch),

  /** Append a layer (on top). */
  addLayer: (layer: Layer) => (doc: ClipEditDoc) => ({ ...doc, layers: [...doc.layers, layer] }),

  /** Remove an added layer. The hook and the captions are never removed —
   *  they are hidden with their toggle — so the workflow can always find
   *  the hook. */
  removeLayer: (layerId: string) => (doc: ClipEditDoc) => {
    const layer = doc.layers.find((l) => l.id === layerId);
    if (!layer || layer.type === "captions" || (layer.type === "text" && layer.role === "hook")) return doc;
    return { ...doc, layers: doc.layers.filter((l) => l.id !== layerId) };
  },

  /** Change one scene's framing; its first change starts from what it shows
   *  now (the doc's framing), so only what you touched differs. */
  patchSceneVideo: (sectionId: string, patch: Partial<ClipEditDoc["video"]>) => (doc: ClipEditDoc) =>
    mapSection(doc, sectionId, (s) => ({ ...s, video: { ...(s.video ?? doc.video), ...patch } })),

  /** Drop a scene's own framing — it follows the rest of the clip again. */
  resetSceneVideo: (sectionId: string) => (doc: ClipEditDoc) =>
    mapSection(doc, sectionId, (s) => {
      if (!s.video) return s;
      const { video: _drop, ...rest } = s;
      void _drop;
      return rest;
    }),

  patchVideo: (patch: Partial<ClipEditDoc["video"]>) => (doc: ClipEditDoc) => ({
    ...doc,
    video: { ...doc.video, ...patch },
  }),

  setBackground: (background: string) => (doc: ClipEditDoc) =>
    doc.canvas.background === background ? doc : { ...doc, canvas: { ...doc.canvas, background } },

  /** Correct a transcript word. Setting it back to the original text clears
   *  the override rather than storing a no-op. */
  correctWord:
    (word: { startSec: number; text: string; mediaId?: string }, text: string) =>
    (doc: ClipEditDoc) => {
      const key = wordEditKey(word.startSec, word.mediaId);
      const next = { ...doc.wordEdits };
      const trimmed = text.trim();
      if (!trimmed || trimmed === word.text) delete next[key];
      else next[key] = trimmed;
      return { ...doc, wordEdits: next };
    },
};
