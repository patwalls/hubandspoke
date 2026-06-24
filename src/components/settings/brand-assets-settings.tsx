"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DownloadIcon, UploadIcon, CheckIcon, Loader2Icon } from "lucide-react";

interface Props {
  brand: string;
  brandLabel: string;
  hasWatermark: boolean;
  initialGuidelines: string | null;
}

export function BrandAssetsSettings({
  brand,
  brandLabel,
  hasWatermark,
  initialGuidelines,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [watermarkUploaded, setWatermarkUploaded] = useState(hasWatermark);
  const [uploadState, setUploadState] = useState<
    "idle" | "uploading" | "success" | "error"
  >("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [guidelines, setGuidelines] = useState(initialGuidelines ?? "");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadState("uploading");
    setUploadError(null);

    try {
      // 1. Get presigned PUT URL
      const presignRes = await fetch("/api/brand-assets/watermark/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          fileName: file.name,
          contentType: file.type || "application/zip",
          fileSize: file.size,
        }),
      });
      if (!presignRes.ok) {
        const { error } = await presignRes.json();
        throw new Error(error ?? "Failed to get upload URL");
      }
      const { uploadUrl, key } = await presignRes.json();

      // 2. Upload directly to S3
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/zip" },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload to S3 failed");

      // 3. Confirm
      const confirmRes = await fetch("/api/brand-assets/watermark/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, key }),
      });
      if (!confirmRes.ok) {
        const { error } = await confirmRes.json();
        throw new Error(error ?? "Failed to confirm upload");
      }

      setWatermarkUploaded(true);
      setUploadState("success");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      setUploadState("error");
    } finally {
      // Reset input so the same file can be re-selected if needed
      if (fileInputRef.current) fileInputRef.current.value = "";
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
        <div>
          <h3 className="text-sm font-medium">Watermarks</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Upload a ZIP of watermark files for this brand. Editors download
            these from the Actions menu on any content item.
          </p>
        </div>

        {watermarkUploaded ? (
          <div className="flex items-center gap-3 p-3 rounded-md border bg-muted/40">
            <CheckIcon className="size-4 text-green-600 shrink-0" />
            <span className="text-sm flex-1">Watermarks uploaded</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                (window.location.href = `/api/brand-assets/watermark/download?brand=${brand}`)
              }
            >
              <DownloadIcon className="size-3.5 mr-1.5" />
              Download
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadState === "uploading"}
            >
              {uploadState === "uploading" ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                "Replace"
              )}
            </Button>
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
                <span className="text-sm font-medium">
                  Click to upload watermarks ZIP
                </span>
                <span className="text-xs">ZIP up to 200 MB</span>
              </>
            )}
          </button>
        )}

        {uploadState === "success" && !watermarkUploaded && (
          <p className="text-xs text-green-600">Watermarks uploaded successfully.</p>
        )}
        {uploadError && (
          <p className="text-xs text-destructive">{uploadError}</p>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
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
