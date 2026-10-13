/**
 * Which framing (fit / zoom / position of the video) an edit applies to.
 *
 * A scene picked on the timeline → that scene alone. Nothing picked → the
 * scene under the playhead if it already has its own framing, else the whole
 * clip (`doc.video`, which every scene without its own follows). The preview,
 * the Video panel and the arrow-key nudge all go through this, so they always
 * agree on what they're changing.
 */
import { useEffect, useState } from "react";
import type { ClipEditDoc, VideoPlacement } from "@/lib/clip-editor/doc";
import type { RenderPlan } from "@/lib/clip-editor/plan";
import type { PlaybackEngine } from "./playback-engine";
import { commands, useEditor } from "./store";

export interface Framing {
  /** The scene being framed; null = the whole clip. */
  sectionId: string | null;
  /** 1-based play order of that scene. */
  sceneIndex: number | null;
  /** True when that scene has framing of its own. */
  own: boolean;
  video: VideoPlacement;
  patch: (p: Partial<VideoPlacement>) => (doc: ClipEditDoc) => ClipEditDoc;
}

export function framingFor(doc: ClipEditDoc, sceneSelection: string | null, playingSectionId: string | null): Framing {
  const picked = sceneSelection ? doc.sections.find((s) => s.id === sceneSelection) : undefined;
  const playing = playingSectionId ? doc.sections.find((s) => s.id === playingSectionId) : undefined;
  const scene = picked ?? (playing?.video ? playing : undefined);
  if (!scene) return { sectionId: null, sceneIndex: null, own: false, video: doc.video, patch: (p) => commands.patchVideo(p) };
  return {
    sectionId: scene.id,
    sceneIndex: doc.sections.indexOf(scene) + 1,
    own: !!scene.video,
    video: scene.video ?? doc.video,
    patch: (p) => commands.patchSceneVideo(scene.id, p),
  };
}

/** The section under the playhead; re-renders only when it changes. */
export function usePlayingSectionId(engine: PlaybackEngine, plan: RenderPlan): string | null {
  const [id, setId] = useState<string | null>(() => plan.segments[engine.snapshot().segmentIndex]?.sectionId ?? null);
  useEffect(
    () =>
      engine.subscribe((snap) => {
        const next = snap.mode === "preview" ? null : (plan.segments[snap.segmentIndex]?.sectionId ?? null);
        setId((prev) => (prev === next ? prev : next));
      }),
    [engine, plan],
  );
  return id;
}

export function useFraming(engine: PlaybackEngine, plan: RenderPlan, doc: ClipEditDoc): Framing {
  const sceneSelection = useEditor((s) => s.sceneSelection);
  const playing = usePlayingSectionId(engine, plan);
  return framingFor(doc, sceneSelection, playing);
}
