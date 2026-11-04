/**
 * What editors change in a format's clip look (the clip side of
 * design-edits): every new clip edit starts from `formats.clip_template`
 * (applyLook), so a change the editors make on clip after clip is a change
 * the look should have had. The format page's Clip look card shows the top
 * one as a quiet line ("Editors change: hook hidden on 29 of 42 clips ›").
 *
 * Compares a clip's saved doc with the look it started from. Only style and
 * layer choices count — never the cut, the hook's words (each clip keeps its
 * own AI hook) or the video framing (every speaker sits somewhere else, so
 * a per-clip pan is the job, not a template miss). The hook's size is
 * re-fitted per hook by applyLook, so it isn't compared either.
 */
import type { CaptionsLayer, ClipEditDoc, ClipLook, Layer, TextLayer } from "./doc";

export type LookChange = "hook-hidden" | "hook-restyled" | "hook-moved" | "own-text" | "image-added" | "captions-restyled" | "captions-moved" | "background";

export const LOOK_CHANGE_LABEL: Record<LookChange, string> = {
  "hook-hidden": "hook hidden",
  "hook-restyled": "hook restyled",
  "hook-moved": "hook moved",
  "own-text": "own text added",
  "image-added": "logo or image added",
  "captions-restyled": "captions restyled",
  "captions-moved": "captions moved",
  background: "background changed",
};

export interface LookEditRow {
  change: LookChange;
  label: string;
  clips: number;
}

/** A position nudge this small is a drag that landed near where it was. */
const MOVE_TOLERANCE_PCT = 3;

const hookOf = (layers: Layer[]) => layers.find((l): l is TextLayer => l.type === "text" && l.role === "hook");
const captionsOf = (layers: Layer[]) => layers.find((l): l is CaptionsLayer => l.type === "captions");

function styleKey(s: TextLayer["style"]): string {
  return JSON.stringify([s.fontId, s.color, s.uppercase, s.outlinePct, s.outlineColor, s.box ? [s.box.color, s.box.alpha, s.box.mode ?? "line"] : null]);
}

const moved = (a: { xPct: number; yPct: number; anchor: string }, b: { xPct: number; yPct: number; anchor: string }) =>
  a.anchor !== b.anchor || Math.abs(a.xPct - b.xPct) > MOVE_TOLERANCE_PCT || Math.abs(a.yPct - b.yPct) > MOVE_TOLERANCE_PCT;

/** The look changes one clip's doc made, relative to the look it started from. */
export function lookChanges(doc: ClipEditDoc, look: ClipLook): Set<LookChange> {
  const out = new Set<LookChange>();
  const lookIds = new Set(look.layers.map((l) => l.id));
  const lookHook = hookOf(look.layers);
  const hook = hookOf(doc.layers);
  if (lookHook?.visible) {
    if (!hook || !hook.visible) out.add("hook-hidden");
    else {
      if (styleKey(hook.style) !== styleKey(lookHook.style)) out.add("hook-restyled");
      if (moved(hook, lookHook)) out.add("hook-moved");
    }
  }
  if (doc.layers.some((l) => l.type === "text" && l.role === "generic" && l.visible && !lookIds.has(l.id) && l.text.trim())) out.add("own-text");
  if (doc.layers.some((l) => l.type === "image" && l.visible && !lookIds.has(l.id))) out.add("image-added");
  const lookCaps = captionsOf(look.layers);
  const caps = captionsOf(doc.layers);
  if (lookCaps && caps && lookCaps.visible && caps.visible) {
    const capsKey = (c: CaptionsLayer) => JSON.stringify([styleKey(c.style), c.style.sizePct, c.maxWordsPerCue, c.highlightColor]);
    if (capsKey(caps) !== capsKey(lookCaps)) out.add("captions-restyled");
    if (moved(caps, lookCaps)) out.add("captions-moved");
  }
  if (doc.canvas.background.toLowerCase() !== look.background.toLowerCase()) out.add("background");
  return out;
}

/** Per change, how many clips made it — most common first; changes no clip
 *  made are left out. */
export function rollUpLookEdits(samples: Array<{ doc: ClipEditDoc; look: ClipLook }>): LookEditRow[] {
  const counts = new Map<LookChange, number>();
  for (const s of samples) for (const c of lookChanges(s.doc, s.look)) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()]
    .map(([change, clips]) => ({ change, label: LOOK_CHANGE_LABEL[change], clips }))
    .sort((a, b) => b.clips - a.clips || a.label.localeCompare(b.label));
}
