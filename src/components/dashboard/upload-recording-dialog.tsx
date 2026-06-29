"use client";

import { useState, useRef, useCallback, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UploadCloudIcon, FileVideoIcon, XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Stage = "idle" | "creating" | "uploading" | "confirming";

interface UploadRecordingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brand: string;
  formats?: string[];
}

export function UploadRecordingDialog({
  open,
  onOpenChange,
  brand,
  formats,
}: UploadRecordingDialogProps) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle("");
    setFormat("");
    setFile(null);
    setStage("idle");
    setProgress(0);
    setError(null);
    setDragging(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function acceptFile(f: File) {
    if (!f.type.startsWith("video/")) {
      setError("Please select a video file.");
      return;
    }
    setFile(f);
    setError(null);
    if (!title && f.name) {
      const stem = f.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
      setTitle(stem.charAt(0).toUpperCase() + stem.slice(1));
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
    e.target.value = "";
  }

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) acceptFile(f);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  async function handleSubmit() {
    if (!title.trim() || !file) return;
    setError(null);

    // 1. Create the production item
    setStage("creating");
    let itemId: string;
    try {
      const res = await fetch("/api/production-items/upload-recording", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          brand,
          format: format || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `Failed to create item (HTTP ${res.status})`);
        setStage("idle");
        return;
      }
      itemId = json.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      setStage("idle");
      return;
    }

    // 2. Get presigned upload URL
    setStage("uploading");
    setProgress(0);
    const contentType = file.type || "video/mp4";
    let uploadUrl: string, key: string, bucket: string;
    try {
      const res = await fetch("/api/uploads/s3-presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          fileName: file.name,
          contentType,
          fileSize: file.size,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `Presign failed (HTTP ${res.status})`);
        setStage("idle");
        return;
      }
      uploadUrl = json.uploadUrl;
      key = json.key;
      bucket = json.bucket;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Presign failed");
      setStage("idle");
      return;
    }

    // 3. Upload file to S3
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: HTTP ${xhr.status}`));
        });
        xhr.addEventListener("error", () =>
          reject(new Error("Upload failed (network error)")),
        );
        xhr.addEventListener("abort", () =>
          reject(new Error("Upload aborted")),
        );
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.send(file);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setStage("idle");
      return;
    }

    // 4. Confirm upload (triggers Whisper transcription → clip ideas)
    setStage("confirming");
    try {
      const res = await fetch("/api/uploads/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          key,
          bucket,
          contentType,
          fileSize: file.size,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || `Confirm failed (HTTP ${res.status})`);
        setStage("idle");
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confirm failed");
      setStage("idle");
      return;
    }

    toast.success("Recording uploaded — transcription queued, clip ideas will generate automatically");
    handleOpenChange(false);
    router.push(`/${brand}/content/${itemId}`);
  }

  const busy = stage !== "idle";
  const canSubmit = !!title.trim() && !!file && !busy;

  function stageLabel() {
    if (stage === "creating") return "Creating…";
    if (stage === "uploading") return progress < 100 ? `Uploading ${progress}%` : "Uploaded";
    if (stage === "confirming") return "Finalizing…";
    return "Upload";
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Recording</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="rec-title">Title</Label>
            <Input
              id="rec-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Interview with Jane Smith"
              disabled={busy}
            />
          </div>

          {formats && formats.length > 0 && (
            <div className="space-y-1.5">
              <Label>Format <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select value={format} onValueChange={(v) => setFormat(v ?? "")} disabled={busy}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a format…" />
                </SelectTrigger>
                <SelectContent>
                  {formats.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Video file</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={handleFileChange}
              disabled={busy}
            />
            {file ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5">
                <FileVideoIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                </span>
                {!busy && (
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors",
                  dragging
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground/50 hover:bg-muted/30",
                  busy && "pointer-events-none opacity-50",
                )}
              >
                <UploadCloudIcon className="size-7 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Drop MP4 here or click to browse</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Up to 5 GB</p>
                </div>
              </div>
            )}
          </div>

          {stage === "uploading" && (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground text-right">{progress}%</p>
            </div>
          )}

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {stageLabel()}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
