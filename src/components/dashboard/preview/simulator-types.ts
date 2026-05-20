import type { ContentDraftContent } from "@/lib/db/schema";
import type { PlatformFieldMap, PreviewData } from "./resolve-preview-data";

export interface SimulatorProps {
  data: PreviewData;
  // Which draft field keys back the editable spots in this platform's mock.
  fieldMap: PlatformFieldMap;
  // True when we have a writable draft; false for POC on a published item.
  editable: boolean;
  // Live content mirrors the current draft; simulators read their caption/
  // secondary values from here (NOT from `data`, which is a snapshot resolved
  // once). Falls back to `data.caption` / `data.secondaryText` when a key is
  // absent.
  liveContent: ContentDraftContent | null;
  onLocalEdit?: (fieldKey: string, value: string) => void;
  onCommit?: (fieldKey: string) => void;
  // The production_items.id this simulator is rendering. Powers the media
  // drop zone (uploads / deletes are scoped per item).
  itemId: string;
  // Fires after a successful media upload or delete so the parent can
  // refetch and re-render with the new rows.
  onMediaMutated?: () => void;
  // Fires after a successful draft mutation (e.g. AI caption regenerate)
  // so the parent can refetch and pick up the new contentDrafts row.
  onDraftMutated?: () => void;
  // Descript-render state for the placeholder UX. Drives the IG Reel
  // simulator's embed-style empty state (video left, caption right) and
  // its sub-state copy. `null` = not Descript-derived OR already rendered;
  // simulators fall back to their existing empty state. Other states drive
  // the placeholder until the actual MP4 archive lands.
  //
  //   "processing" — clip-promote work in flight before composition_id
  //                  lands. Covers the just-enqueued window, the precise-
  //                  cut import, AND the Underlord layout-pack call. The
  //                  parent supplies `descriptProcessingLabel` /
  //                  `descriptProcessingDetail` so the placeholder spells
  //                  out which phase is running.
  //   "rendering" — publish-and-archive job is in flight (MP4 render)
  //   "awaiting"  — composition exists, no publish job yet (stuck / fresh)
  //   "failed"    — last publish attempt errored; user can retry
  descriptRenderState?:
    | "processing"
    | "rendering"
    | "awaiting"
    | "failed"
    | null;
  /** Phase-specific copy for the `processing` placeholder. Two strings: a
   *  bold one-liner ("Cutting clip in Descript…") and a thinner subtitle
   *  ("Underlord is applying the layout pack — about 30–90 seconds.").
   *  Omitted when `descriptRenderState !== "processing"`. */
  descriptProcessingLabel?: string | null;
  descriptProcessingDetail?: string | null;
  // Deep link to the source Descript project for this item, when known.
  // Drives the Edit button in the per-video MediaActions overlay so editors
  // can jump from the simulator into Descript to tweak the composition.
  descriptProjectUrl?: string | null;
  /** True while a `draft-algorithm-run` graphile-worker job is queued or
   *  in flight for this production_item. When true, the caption editor
   *  goes read-only and a "Drafting…" overlay renders so the editor
   *  doesn't start typing text that's about to be overwritten by the
   *  algorithm's commit. */
  draftAlgorithmRunning?: boolean;
}

export function readLive(
  liveContent: ContentDraftContent | null,
  fieldKey: string | null,
  fallback: string,
): string {
  if (!fieldKey || !liveContent) return fallback;
  const v = liveContent[fieldKey];
  if (typeof v === "string") return v;
  return fallback;
}
