"use client";

import { MonogramAvatar } from "../avatar";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";
import {
  DraftMediaDropZone,
  PlaceholderSlideRender,
} from "../draft-media-dropzone";
import { MediaActions } from "../media-actions";

export function InstagramStorySimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
  itemId,
  onMediaMutated,
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);
  const handle = data.author.handle ?? "you";

  return (
    <DraftMediaDropZone
      itemId={itemId}
      postType="instagram_story"
      editable={editable}
      slides={data.slides}
      onMediaMutated={onMediaMutated}
    >
      {({ slides: enrichedSlides, placeholders }) => {
        const enriched = enrichedSlides[0];
        const placeholder = placeholders[0];
        return (
          <div className="mx-auto w-full max-w-[360px] overflow-hidden rounded-xl bg-black">
            <div className="group relative aspect-[9/16] w-full">
              {enriched?.slide.kind === "video" ? (
                <video
                  src={enriched.slide.url ?? undefined}
                  poster={enriched.slide.posterUrl ?? undefined}
                  controls
                  playsInline
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : enriched?.slide.url ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={enriched.slide.url}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <MediaActions src={enriched.slide.url} />
                </>
              ) : placeholder ? (
                <div className="absolute inset-0">
                  <PlaceholderSlideRender placeholder={placeholder} />
                </div>
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-500 via-rose-500 to-amber-400" />
              )}

              {/* Remove button (only when an actual slide is present) */}
              {enriched?.removeButton}

              {/* Progress bar */}
              <div className="absolute inset-x-3 top-2 flex gap-1">
                <div className="h-0.5 flex-1 rounded-full bg-white/40">
                  <div className="h-full w-1/3 rounded-full bg-white" />
                </div>
              </div>

              {/* Author bar */}
              <div className="absolute inset-x-3 top-5 flex items-center gap-2 text-white">
                <MonogramAvatar
                  displayName={data.author.displayName}
                  handle={data.author.handle}
                  size="sm"
                />
                <span className="text-xs font-semibold drop-shadow">{handle}</span>
                <span className="text-[11px] text-white/80">· now</span>
              </div>

              {/* Story caption overlay */}
              <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 text-center">
                <div className="pointer-events-auto inline-block max-w-full rounded-md bg-black/55 px-3 py-2 backdrop-blur">
                  <EditableField
                    fieldKey={fieldMap.caption}
                    editable={editable}
                    onLocalEdit={onLocalEdit}
                    onCommit={onCommit}
                    value={caption}
                    placeholder="Story text…"
                    multiline
                    className="text-center text-base font-semibold leading-tight text-white"
                  />
                </div>
              </div>
            </div>
          </div>
        );
      }}
    </DraftMediaDropZone>
  );
}
