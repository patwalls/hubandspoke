"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Hover overlay with download + copy buttons for an image. Same buttons +
 * styling as `CommentImage` in `content-activity.tsx`. The parent must be
 * `relative` and have a `group` class so `group-hover` reveals the overlay.
 *
 * Slide URLs are presigned S3 (cross-origin to the app), so we fetch +
 * blob both actions instead of leaning on the `<a download>` attribute or
 * `?download=1` — neither works against S3.
 */
export function MediaActions({
  src,
  filename,
}: {
  src: string;
  filename?: string;
}) {
  const [copied, setCopied] = useState(false);
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
      const ext = (blob.type.split("/")[1] || "png").split(";")[0];
      a.download = filename || `image.${ext}`;
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
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy failed");
      setTimeout(() => setError(null), 2500);
    }
  };

  return (
    <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={onDownload}
        title="Download"
        aria-label="Download image"
      >
        <DownloadIcon />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={onCopy}
        title={copied ? "Copied" : "Copy image"}
        aria-label="Copy image to clipboard"
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
