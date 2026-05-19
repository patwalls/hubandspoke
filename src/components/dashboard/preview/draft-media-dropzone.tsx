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
   *  per-slide "remove" affordance, plus a callback to open the file
   *  picker (useful when the simulator wants its own "Add media" button
   *  outside the aspect-ratio'd container that would otherwise clip the
   *  default one). The simulator stays in charge of layout — this
   *  dropzone only owns drag/drop, the picker, and the hover-X overlay. */
  children: (props: {
    slides: SlideWithRemoveButton[];
    placeholders: PlaceholderSlide[];
    openPicker: () => void;
    canAddMore: boolean;
  }) => React.ReactNode;
  /** When true, suppress the dropzone's auto-rendered "Add media" button.
   *  Simulators that render their own Add button via the `openPicker`
   *  callback (LinkedIn / X / TikTok) opt in here so they don't end up
   *  with two stacked Add affordances. */
  hideDefaultAddButton?: boolean;
}

export interface PlaceholderSlide {
  id: string;
  kind: "image" | "video";
  state: "uploading" | "error";
  /** Original file name — shown in the placeholder so the user can
   *  recognize what they're uploading (especially useful for big videos
   *  where the upload takes a while). */
  fileName?: string;
  /** Pretty-printed file size, e.g. "12.4 MB". Set at upload start. */
  fileSizeLabel?: string;
  /** Upload progress 0–100. `undefined` while we're still in the
   *  presign / pre-PUT phase or after the PUT completes. */
  progress?: number;
  /** Error message when state==='error'. Shown under the file name. */
  errorMessage?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** PUT a file to a presigned S3 URL with progress reporting. fetch() can't
 *  observe upload progress (only download), so we drop to XHR here. Resolves
 *  on 2xx; rejects on network error or non-2xx HTTP. */
function putToS3WithProgress(args: {
  url: string;
  file: File;
  onProgress: (percent: number) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", args.url, true);
    xhr.setRequestHeader("Content-Type", args.file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        args.onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        args.onProgress(100);
        resolve();
      } else {
        reject(new Error(`S3 upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () =>
      reject(new Error(`S3 upload failed (network error) for ${args.file.name}`));
    xhr.onabort = () =>
      reject(new Error(`S3 upload aborted for ${args.file.name}`));
    xhr.send(args.file);
  });
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
  hideDefaultAddButton = false,
}: DraftMediaDropZoneProps) {
  const options = dropZoneOptionsForPostType(postType);
  const accept = options?.accept ?? "";
  const maxTotal = options?.maxTotal ?? 0;
  const replaceOnUpload = options?.replaceOnUpload ?? false;
  // Slide count is the source-of-truth count for cap decisions.
  const slideCount = slides.length;
  const atCap = slideCount >= maxTotal;
  // Show the replace label whenever a single-* platform's slot is full and
  // we'd swap on the next drop. Otherwise show the standard "Add ..." label.
  const buttonLabel =
    options && replaceOnUpload && atCap
      ? options.replaceButtonLabel
      : (options?.addButtonLabel ?? "Add media");
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

      // Replace flow: on single-* platforms (Reel, TikTok, Story) when the
      // slot is full, treat a new drop as "swap the existing media for the
      // new one." Delete every existing row first; the upload then takes
      // its place. We do this before the optimistic-placeholder phase so
      // the simulator briefly shows the empty state instead of two stacked
      // videos.
      if (replaceOnUpload && slides.length >= maxTotal) {
        try {
          await Promise.all(
            slides
              .filter((s) => s.mediaId)
              .map((s) =>
                fetch(
                  `/api/production-items/${itemId}/media/${s.mediaId}`,
                  { method: "DELETE" },
                ),
              ),
          );
          // Don't refetch here — we'll do one refetch after the upload
          // confirms, which catches both the deletes and the new row.
        } catch (err) {
          toast.error(
            err instanceof Error
              ? err.message
              : "Failed to remove existing media before upload.",
          );
          return;
        }
      }

      // Optimistic placeholders — one per file. Carry the file name + size
      // so the simulator's render slot is recognizable even before the S3
      // URL exists (especially for big videos where the upload takes 30s+).
      const ids = accepted.map(
        () =>
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
          fileName: f.name,
          fileSizeLabel: formatBytes(f.size),
          progress: 0,
        })),
      ]);

      // Top-level toast — guaranteed feedback even if a simulator forgets
      // to render the placeholder slot. Updated as progress comes in,
      // dismissed on completion / replaced with success or error.
      const totalBytes = accepted.reduce((sum, f) => sum + f.size, 0);
      const toastSubject =
        accepted.length === 1
          ? accepted[0].name
          : `${accepted.length} files (${formatBytes(totalBytes)})`;
      const toastId = toast.loading(`Uploading ${toastSubject}…`, {
        description: "Don't close this tab — we'll let you know when it's done.",
        duration: Infinity,
      });

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

        // Step 2: PUT each file directly to S3 with XHR-based progress.
        // Per-file progress updates the placeholder; aggregate progress
        // updates the toast description.
        const perFileBytesUploaded = new Array(accepted.length).fill(0);
        await Promise.all(
          accepted.map((file, i) => {
            const slot = presignJson.files![i];
            return putToS3WithProgress({
              url: slot.uploadUrl,
              file,
              onProgress: (percent) => {
                perFileBytesUploaded[i] = Math.round((percent / 100) * file.size);
                setPlaceholders((prev) =>
                  prev.map((p) =>
                    p.id === ids[i] ? { ...p, progress: percent } : p,
                  ),
                );
                const uploadedTotal = perFileBytesUploaded.reduce(
                  (a, b) => a + b,
                  0,
                );
                const overall = Math.round((uploadedTotal / totalBytes) * 100);
                toast.loading(`Uploading ${toastSubject}…`, {
                  id: toastId,
                  description: `${overall}% • ${formatBytes(uploadedTotal)} of ${formatBytes(totalBytes)}`,
                  duration: Infinity,
                });
              },
            });
          }),
        );

        // Step 3: confirm + write rows
        toast.loading(`Saving ${toastSubject}…`, {
          id: toastId,
          description: "Almost done — recording the upload.",
          duration: Infinity,
        });
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
        toast.success(
          accepted.length === 1
            ? `Uploaded ${accepted[0].name}`
            : `Uploaded ${accepted.length} files`,
          { id: toastId, duration: 4000 },
        );
        onMediaMutated?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        toast.error(`Upload failed: ${message}`, {
          id: toastId,
          duration: 10_000,
        });
        setPlaceholders((prev) =>
          prev.map((p) =>
            ids.includes(p.id)
              ? { ...p, state: "error" as const, errorMessage: message }
              : p,
          ),
        );
        // Leave error placeholders in place so the user sees what failed;
        // they auto-clear on the next successful mutation.
      }
    },
    [
      editable,
      itemId,
      onMediaMutated,
      options,
      accept,
      maxTotal,
      replaceOnUpload,
      slides,
    ],
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
    // Always-visible (not hover-gated) on the assumption that the editor
    // needs to find this fast — a hover-only X was invisible on broken
    // poster frames, which is exactly when the user wants to delete. The
    // bg-black/60 chip is small enough to not fight the media for
    // attention.
    removeButton:
      editable && slide.mediaId ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleRemove(slide.mediaId!);
          }}
          className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white shadow-sm transition-colors hover:bg-black/80"
          aria-label="Remove media"
          title="Remove media"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      ) : null,
  }));

  const totalCount = slides.length + placeholders.length;
  const wired = options !== null;
  // "Add" affordance is shown when:
  //   - there's room under the cap (normal add flow), OR
  //   - we're in single-* replace mode and at-cap (drop swaps in-place).
  const canAddMore =
    wired &&
    editable &&
    (totalCount < maxTotal || (replaceOnUpload && totalCount >= maxTotal));
  // Multi-file picker only when the underlying mode supports >1 slide AND
  // we're not in replace-mode at-cap (where the next drop is one file).
  const allowMultiple = maxTotal > 1 && !(replaceOnUpload && atCap);

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
      {children({
        slides: enrichedSlides,
        placeholders,
        openPicker: () => fileInputRef.current?.click(),
        canAddMore,
      })}

      {canAddMore && !hideDefaultAddButton && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <ImagePlusIcon className="h-3.5 w-3.5" />
            {buttonLabel}
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
 * simulator can drop these into its grid alongside real slides. Shows the
 * file name, size, and live upload progress so large videos don't feel
 * like a frozen UI.
 */
export function PlaceholderSlideRender({
  placeholder,
}: {
  placeholder: PlaceholderSlide;
}) {
  const isUploading = placeholder.state === "uploading";
  const progress = placeholder.progress ?? 0;
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/60 px-4 text-center">
      {isUploading ? (
        <>
          <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
          {placeholder.fileName && (
            <div className="flex flex-col gap-0.5">
              <span className="line-clamp-1 text-xs font-medium text-foreground">
                {placeholder.fileName}
              </span>
              {placeholder.fileSizeLabel && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {progress}% • {placeholder.fileSizeLabel}
                </span>
              )}
            </div>
          )}
          <div className="h-1 w-full max-w-[160px] overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-200"
              style={{ width: `${Math.max(2, progress)}%` }}
            />
          </div>
        </>
      ) : (
        <>
          <span className="text-xs font-semibold text-destructive">
            Upload failed
          </span>
          {placeholder.fileName && (
            <span className="line-clamp-1 text-[11px] text-muted-foreground">
              {placeholder.fileName}
            </span>
          )}
          {placeholder.errorMessage && (
            <span className="line-clamp-2 text-[10px] text-destructive/80">
              {placeholder.errorMessage}
            </span>
          )}
        </>
      )}
    </div>
  );
}
