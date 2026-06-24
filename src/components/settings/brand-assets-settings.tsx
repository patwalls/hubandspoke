"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DownloadIcon,
  UploadIcon,
  Loader2Icon,
  Trash2Icon,
  FileIcon,
} from "lucide-react";

export interface WatermarkFile {
  id: string;
  fileName: string;
  sizeBytes: number | null;
  createdAt: string;
}

interface Props {
  brand: string;
  brandLabel: string;
  initialWatermarks: WatermarkFile[];
  initialGuidelines: string | null;
}

function formatBytes(bytes: number | null) {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BrandAssetsSettings({
  brand,
  brandLabel,
  initialWatermarks,
  initialGuidelines,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [watermarks, setWatermarks] = useState<WatermarkFile[]>(initialWatermarks);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "error">("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [guidelines, setGuidelines] = useState(initialGuidelines ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadState("uploading");
    setUploadError(null);

    try {
      const presignRes = await fetch("/api/brand-assets/watermark/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          fileSize: file.size,
        }),
      });
      if (!presignRes.ok) {
        const { error } = await presignRes.json();
        throw new Error(error ?? "Failed to get upload URL");
      }
      const { uploadUrl, key } = await presignRes.json();

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload to S3 failed");

      const confirmRes = await fetch("/api/brand-assets/watermark/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          key,
          fileName: file.name,
          fileSize: file.size,
        }),
      });
      if (!confirmRes.ok) {
        const { error } = await confirmRes.json();
        throw new Error(error ?? "Failed to confirm upload");
      }
      const { id } = await confirmRes.json();

      setWatermarks((prev) => [
        {
          id,
          fileName: file.name,
          sizeBytes: file.size,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);
      setUploadState("idle");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      setUploadState("error");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/brand-assets/watermark/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      setWatermarks((prev) => prev.filter((w) => w.id !== id));
    } catch {
      // leave item in list on failure — user can retry
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSaveGuidelines() {
    setSaveState("saving");
    try {
      const res = await fetch("/api/brand-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, brandGuidelines: guidelines || null }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold">{brandLabel} — Brand Assets</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Upload brand assets that editors can download when producing content.
        </p>
      </div>

      {/* Watermarks */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Watermarks</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              ZIP or image files editors download from the Actions menu on any content item.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadState === "uploading"}
          >
            {uploadState === "uploading" ? (
              <Loader2Icon className="size-3.5 animate-spin mr-1.5" />
            ) : (
              <UploadIcon className="size-3.5 mr-1.5" />
            )}
            Upload file
          </Button>
        </div>

        {watermarks.length > 0 ? (
          <div className="rounded-md border divide-y">
            {watermarks.map((wm) => (
              <div key={wm.id} className="flex items-center gap-3 px-3 py-2.5">
                <FileIcon className="size-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{wm.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      formatBytes(wm.sizeBytes),
                      new Date(wm.createdAt).toLocaleDateString(),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    (window.location.href = `/api/brand-assets/watermark/download?id=${wm.id}`)
                  }
                >
                  <DownloadIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleDelete(wm.id)}
                  disabled={deletingId === wm.id}
                >
                  {deletingId === wm.id ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2Icon className="size-3.5" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadState === "uploading"}
            className="w-full flex flex-col items-center gap-2 p-8 rounded-md border-2 border-dashed text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploadState === "uploading" ? (
              <>
                <Loader2Icon className="size-5 animate-spin" />
                <span className="text-sm">Uploading…</span>
              </>
            ) : (
              <>
                <UploadIcon className="size-5" />
                <span className="text-sm font-medium">No watermarks uploaded yet</span>
                <span className="text-xs">ZIP or image files, up to 200 MB each</span>
              </>
            )}
          </button>
        )}

        {uploadError && (
          <p className="text-xs text-destructive">{uploadError}</p>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,.png,.jpg,.jpeg,.gif,.webp,.svg,application/zip,application/x-zip-compressed,image/*"
          className="hidden"
          onChange={handleFileChange}
        />
      </section>

      {/* Brand Guidelines */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Brand Guidelines</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Links, notes, and references for this brand — media kit, fonts,
            style guides, etc.
          </p>
        </div>

        <Textarea
          value={guidelines}
          onChange={(e) => setGuidelines(e.target.value)}
          placeholder="Paste links and notes here, e.g.&#10;Brand media kit: https://…&#10;Preferred font: Inter&#10;Color palette: #1a1a1a / #ffffff"
          className="min-h-40 font-mono text-sm resize-y"
        />

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={handleSaveGuidelines}
            disabled={saveState === "saving"}
          >
            {saveState === "saving" && (
              <Loader2Icon className="size-3.5 animate-spin mr-1.5" />
            )}
            {saveState === "saved" ? "Saved" : "Save"}
          </Button>
          {saveState === "saved" && (
            <span className="text-xs text-muted-foreground">Changes saved.</span>
          )}
          {saveState === "error" && (
            <span className="text-xs text-destructive">Failed to save.</span>
          )}
        </div>
      </section>
    </div>
  );
}
