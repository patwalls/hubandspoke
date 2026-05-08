"use client";

import { useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  RefreshCwIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Hover overlay with download / copy / (optional) resync buttons for an
 * image OR video. Same buttons + styling as `CommentImage` in
 * `content-activity.tsx`. The parent must be `relative` and have a `group`
 * class so `group-hover` reveals the overlay.
 *
 * Slide URLs are presigned S3 (cross-origin to the app), so we fetch +
 * blob the download instead of leaning on the `<a download>` attribute or
 * `?download=1` — neither works against S3.
 *
 * For images, Copy writes the bitmap to the clipboard. For videos the
 * Clipboard API doesn't support video bytes, so Copy writes the presigned
 * URL as text instead — useful for pasting into Slack / a Notion comment.
 *
 * The Resync button is optional and shown when `onResync` is provided —
 * the IG Reel simulator passes it for Descript-derived clips so editors
 * can re-render the MP4 after edits in Descript without leaving the page.
 */
export function MediaActions({
  src,
  filename,
  kind = "image",
  onResync,
  editUrl,
}: {
  src: string;
  filename?: string;
  /** "image" → bitmap copy + image.<ext> default filename. "video" → URL
   *  copy + video.mp4 default filename. */
  kind?: "image" | "video";
  /** When set, render a small "Resync" button alongside Download/Copy. The
   *  callback is async and should return when the resync request has been
   *  acknowledged by the server (we toast on entry/exit). */
  onResync?: () => Promise<void>;
  /** When set, render an "Edit" button (leftmost) that opens the source
   *  composition for this media in a new tab. Used for Descript-derived
   *  videos so editors can jump to the project from the simulator. */
  editUrl?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBlob = async (): Promise<Blob> => {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  };

  const onDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setError(null);
    try {
      const blob = await fetchBlob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      const fallbackExt = kind === "video" ? "mp4" : "png";
      const ext = (blob.type.split("/")[1] || fallbackExt).split(";")[0];
      const fallbackName = kind === "video" ? `video.${ext}` : `image.${ext}`;
      a.download = filename || fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
      setTimeout(() => setError(null), 2500);
    }
  };

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setError(null);
    try {
      if (kind === "video") {
        // Browsers don't allow clipboard.write() with video MIME types.
        // Copy the presigned URL as text — useful for pasting into Slack
        // / Descript / a draft so an editor can grab the file elsewhere.
        await navigator.clipboard.writeText(src);
      } else {
        const blob = await fetchBlob();
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob }),
          ]);
        } catch {
          const png = await blobToPng(blob);
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": png }),
          ]);
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy failed");
      setTimeout(() => setError(null), 2500);
    }
  };

  const handleResync = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onResync || resyncing) return;
    setResyncing(true);
    try {
      await onResync();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Resync failed");
    } finally {
      setResyncing(false);
    }
  };

  return (
    <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      {editUrl && (
        <a
          href={editUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Edit in Descript"
          aria-label="Edit in Descript"
          className={buttonVariants({ variant: "outline", size: "icon-xs" })}
        >
          <PencilIcon />
        </a>
      )}
      {onResync && (
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={handleResync}
          disabled={resyncing}
          title={resyncing ? "Resyncing…" : "Re-sync from Descript"}
          aria-label="Re-sync from Descript"
        >
          <RefreshCwIcon className={resyncing ? "animate-spin" : undefined} />
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={onDownload}
        title="Download"
        aria-label={kind === "video" ? "Download video" : "Download image"}
      >
        <DownloadIcon />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={onCopy}
        title={
          copied
            ? "Copied"
            : kind === "video"
              ? "Copy video URL"
              : "Copy image"
        }
        aria-label={
          kind === "video"
            ? "Copy video URL to clipboard"
            : "Copy image to clipboard"
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
      {error && (
        <span className="absolute -bottom-7 left-0 whitespace-nowrap rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white">
          {error}
        </span>
      )}
    </div>
  );
}

async function blobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not supported");
  ctx.drawImage(bitmap, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
}
