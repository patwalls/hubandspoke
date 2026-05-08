"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlusIcon, Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { dropZoneOptionsForPostType } from "@/lib/services/draft-media";
import type { PreviewSlide } from "./resolve-preview-data";

interface DraftMediaDropZoneProps {
  itemId: string;
  /** The platform this simulator is rendering. Drives the file-picker
   *  accept string, the "add more" button label, and the per-platform
   *  cap. When the post type isn't wired (`dropZoneOptionsForPostType`
   *  returns null), the dropzone renders no add UI but still shows
   *  per-slide remove buttons via the render-prop. */
  postType: string | null;
  editable: boolean;
  slides: PreviewSlide[];
  /** Callback fired after a successful upload or delete so the parent
   *  refetches and re-renders the simulator with the canonical rows. */
  onMediaMutated?: () => void;
  /** Render-prop for the slide grid. Receives the live slides plus a
   *  per-slide "remove" affordance. The simulator stays in charge of
   *  layout — this dropzone only owns drag/drop, the picker, and the
   *  hover-X overlay. */
  children: (props: {
    slides: SlideWithRemoveButton[];
    placeholders: PlaceholderSlide[];
  }) => React.ReactNode;
}

export interface PlaceholderSlide {
  id: string;
  kind: "image" | "video";
  state: "uploading" | "error";
}

export interface SlideWithRemoveButton {
  slide: PreviewSlide;
  removeButton: React.ReactNode | null;
}

export function DraftMediaDropZone({
  itemId,
  postType,
  editable,
  slides,
  onMediaMutated,
  children,
}: DraftMediaDropZoneProps) {
  const options = dropZoneOptionsForPostType(postType);
  const accept = options?.accept ?? "";
  const maxTotal = options?.maxTotal ?? 0;
  const addButtonLabel = options?.addButtonLabel ?? "Add media";
  const [dragOver, setDragOver] = useState(false);
  const [placeholders, setPlaceholders] = useState<PlaceholderSlide[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // dragenter/leave fire for every child element under the cursor; track a
  // counter so the overlay only hides once the cursor truly leaves the card.
  const dragDepthRef = useRef(0);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!editable || !options) return;
      const acceptedTypes = accept.split(",");
      const accepted = files.filter((f) => acceptedTypes.includes(f.type));
      const rejected = files.length - accepted.length;
      if (rejected > 0) {
        toast.error(
          `${rejected} file${rejected === 1 ? "" : "s"} skipped (unsupported type).`,
        );
      }
      if (accepted.length === 0) return;
      if (accepted.length > maxTotal) {
        toast.error(
          `Up to ${maxTotal} file${maxTotal === 1 ? "" : "s"} at a time.`,
        );
        return;
      }

      // Optimistic placeholders — one per file. Replaced on success.
      const ids = accepted.map(
        () =>
          // crypto.randomUUID exists in modern browsers; fall back just in case
          (typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `tmp-${Math.random().toString(36).slice(2)}`),
      );
      setPlaceholders((prev) => [
        ...prev,
        ...accepted.map((f, i) => ({
          id: ids[i],
          kind: (f.type.startsWith("video/") ? "video" : "image") as
            | "image"
            | "video",
          state: "uploading" as const,
        })),
      ]);

      try {
        // Step 1: presign
        const presignRes = await fetch(
          `/api/production-items/${itemId}/media/presign`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              files: accepted.map((f) => ({
                name: f.name,
                contentType: f.type,
                sizeBytes: f.size,
              })),
            }),
          },
        );
        const presignJson = (await presignRes.json().catch(() => ({}))) as {
          files?: Array<{
            uploadUrl: string;
            key: string;
            bucket: string;
            contentType: string;
            sizeBytes: number;
            kind: "image" | "video";
          }>;
          error?: string;
        };
        if (!presignRes.ok || !presignJson.files) {
          throw new Error(presignJson.error || "Failed to start upload");
        }

        // Step 2: PUT each file directly to S3
        await Promise.all(
          accepted.map(async (file, i) => {
            const slot = presignJson.files![i];
            const putRes = await fetch(slot.uploadUrl, {
              method: "PUT",
              body: file,
              headers: { "Content-Type": file.type },
            });
            if (!putRes.ok) {
              throw new Error(`S3 upload failed for ${file.name}`);
            }
          }),
        );

        // Step 3: confirm + write rows
        const confirmRes = await fetch(
          `/api/production-items/${itemId}/media`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              uploads: presignJson.files.map((f) => ({
                key: f.key,
                bucket: f.bucket,
                contentType: f.contentType,
                sizeBytes: f.sizeBytes,
                kind: f.kind,
              })),
            }),
          },
        );
        const confirmJson = (await confirmRes.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!confirmRes.ok) {
          throw new Error(confirmJson.error || "Failed to save media");
        }

        // Drop placeholders; refetch reseeds the simulator with the real rows.
        setPlaceholders((prev) => prev.filter((p) => !ids.includes(p.id)));
        onMediaMutated?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        toast.error(message);
        setPlaceholders((prev) =>
          prev.map((p) =>
            ids.includes(p.id) ? { ...p, state: "error" as const } : p,
          ),
        );
        // Leave error placeholders in place so the user sees what failed;
        // they auto-clear on the next successful mutation.
      }
    },
    [editable, itemId, onMediaMutated, options, accept, maxTotal],
  );

  // Wipe error placeholders whenever the canonical slide set changes (a
  // refetch happened, the user has fresh state).
  useEffect(() => {
    setPlaceholders((prev) => prev.filter((p) => p.state !== "error"));
  }, [slides]);

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!editable) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setDragOver(true);
    },
    [editable],
  );
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!editable) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [editable],
  );
  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!editable) return;
      e.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragOver(false);
    },
    [editable],
  );
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!editable) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      void handleFiles(files);
    },
    [editable, handleFiles],
  );

  const onPickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      void handleFiles(files);
      // Reset so picking the same file twice still fires.
      e.target.value = "";
    },
    [handleFiles],
  );

  const handleRemove = useCallback(
    async (mediaId: string) => {
      if (!editable) return;
      if (!confirm("Remove this media?")) return;
      try {
        const res = await fetch(
          `/api/production-items/${itemId}/media/${mediaId}`,
          { method: "DELETE" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!res.ok) throw new Error(json.error || "Failed to remove media");
        onMediaMutated?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove");
      }
    },
    [editable, itemId, onMediaMutated],
  );

  const enrichedSlides: SlideWithRemoveButton[] = slides.map((slide) => ({
    slide,
    removeButton:
      editable && slide.mediaId ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleRemove(slide.mediaId!);
          }}
          className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/80"
          aria-label="Remove media"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      ) : null,
  }));

  const totalCount = slides.length + placeholders.length;
  const wired = options !== null;
  const canAddMore = wired && editable && totalCount < maxTotal;
  const allowMultiple = maxTotal > 1;

  return (
    <div
      // h-full w-full so the wrapper inherits its parent's dimensions —
      // matters for simulators that fix the parent height via aspect ratio
      // (IG Reel 9:16, IG Post 1:1) and rely on absolutely-positioned
      // children (the video element is `absolute inset-0`). Without these
      // the wrapper collapses to 0×0 and the video renders invisible.
      className="relative h-full w-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children({ slides: enrichedSlides, placeholders })}

      {canAddMore && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <ImagePlusIcon className="h-3.5 w-3.5" />
            {addButtonLabel}
          </button>
          <span className="text-[11px] text-muted-foreground">
            or drop files anywhere on the card
          </span>
        </div>
      )}

      {dragOver && editable && wired && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-primary/5">
          <span className="rounded-md bg-background/90 px-3 py-1.5 text-sm font-medium text-foreground shadow">
            Drop to add media
          </span>
        </div>
      )}

      {wired && (
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          multiple={allowMultiple}
          className="hidden"
          onChange={onPickerChange}
        />
      )}
    </div>
  );
}

/**
 * Renderer for an in-flight or errored upload placeholder. Exported so the
 * simulator can drop these into its grid alongside real slides.
 */
export function PlaceholderSlideRender({
  placeholder,
}: {
  placeholder: PlaceholderSlide;
}) {
  return (
    <div className="relative flex h-full w-full items-center justify-center bg-muted/60">
      {placeholder.state === "uploading" ? (
        <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <span className="text-xs font-medium text-destructive">Failed</span>
      )}
    </div>
  );
}
