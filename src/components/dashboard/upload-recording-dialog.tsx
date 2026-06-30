"use client";

import { useState, useRef, useCallback, useEffect, type DragEvent } from "react";
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
import type { PickerAccount } from "@/components/ui/account-post-type-picker";

type Stage = "idle" | "creating" | "uploading" | "confirming";

interface UploadRecordingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brand: string;
  formats?: string[];
  accounts?: PickerAccount[];
}

export function UploadRecordingDialog({
  open,
  onOpenChange,
  brand,
  formats,
  accounts,
}: UploadRecordingDialogProps) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("");
  const [accountId, setAccountId] = useState("");
  const youtubeAccounts = accounts?.filter((a) => a.platform === "youtube" && a.isActive) ?? [];
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProgressRef = useRef<number>(0);
  // Holds the in-flight multipart upload so a cancel/unmount can abort it on
  // S3 (best-effort) instead of leaving orphaned parts behind.
  const multipartRef = useRef<{ key: string; uploadId: string } | null>(null);
  const cancelledRef = useRef(false);

  function clearStallTimer() {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }

  function resetStallTimer() {
    clearStallTimer();
    setStalled(false);
    stallTimerRef.current = setTimeout(() => setStalled(true), 60_000);
  }

  // Best-effort: tell S3 to discard a partially-uploaded multipart upload.
  function abortMultipart() {
    const mp = multipartRef.current;
    if (!mp) return;
    multipartRef.current = null;
    // Fire-and-forget; keepalive lets it survive an unmount/navigation.
    fetch("/api/uploads/multipart/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mp),
      keepalive: true,
    }).catch(() => {});
  }

  // Clean up XHR and stall timer if the dialog is closed mid-upload
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      xhrRef.current?.abort();
      clearStallTimer();
      abortMultipart();
    };
  }, []);

  function reset() {
    cancelledRef.current = true;
    xhrRef.current?.abort();
    xhrRef.current = null;
    clearStallTimer();
    abortMultipart();
    setTitle("");
    setFormat("");
    setAccountId("");
    setFile(null);
    setStage("idle");
    setProgress(0);
    setStalled(false);
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

  // PUT one part to S3 with a per-part timeout. Resolves on success, rejects
  // on HTTP error / network error / timeout / abort. `onLoaded` reports the
  // bytes sent so far for this part so the caller can aggregate overall %.
  function putPart(
    url: string,
    blob: Blob,
    onLoaded: (loaded: number) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      // Per-part timeout. Parts are ~8MB; 3 min is generous even on a slow
      // link, and a stalled part is retried rather than hanging forever.
      xhr.timeout = 3 * 60 * 1000;
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          onLoaded(e.loaded);
          resetStallTimer();
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`HTTP ${xhr.status}`));
      });
      xhr.addEventListener("error", () => reject(new Error("network error")));
      xhr.addEventListener("timeout", () => reject(new Error("timed out")));
      xhr.addEventListener("abort", () => reject(new Error("cancelled")));
      xhr.open("PUT", url);
      xhr.send(blob);
    });
  }

  async function handleSubmit() {
    if (!title.trim() || !file) return;
    setError(null);
    cancelledRef.current = false;
    const uploadFile = file;

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
          accountId: accountId || undefined,
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

    // 2. Start a multipart upload — returns a presigned URL per part. We PUT
    //    parts directly to S3 (each small + independently retryable), which is
    //    far more reliable than one giant presigned PUT that stalls forever.
    setStage("uploading");
    setProgress(0);
    const contentType = uploadFile.type || "video/mp4";
    let key: string, bucket: string, uploadId: string, partSize: number;
    let partUrls: { partNumber: number; url: string }[];
    try {
      const res = await fetch("/api/uploads/multipart/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          fileName: uploadFile.name,
          contentType,
          fileSize: uploadFile.size,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `Could not start upload (HTTP ${res.status})`);
        setStage("idle");
        return;
      }
      key = json.key;
      bucket = json.bucket;
      uploadId = json.uploadId;
      partSize = json.partSize;
      partUrls = json.partUrls;
      multipartRef.current = { key, uploadId };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start upload");
      setStage("idle");
      return;
    }

    // 3. Upload each part, retrying a stalled/failed part in isolation. Overall
    //    progress = (bytes in completed parts + current part's bytes) / total.
    lastProgressRef.current = 0;
    resetStallTimer();
    const totalBytes = uploadFile.size;
    let completedBytes = 0;
    const MAX_PART_ATTEMPTS = 4;
    try {
      for (const { partNumber, url } of partUrls) {
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, totalBytes);
        const blob = uploadFile.slice(start, end);

        let attempt = 0;
        for (;;) {
          attempt++;
          try {
            await putPart(url, blob, (loaded) => {
              const pct = Math.round(
                ((completedBytes + loaded) / totalBytes) * 100,
              );
              if (pct !== lastProgressRef.current) {
                lastProgressRef.current = pct;
                setProgress(pct);
              }
            });
            break; // part succeeded
          } catch (err) {
            if (cancelledRef.current) throw new Error("cancelled");
            if (attempt >= MAX_PART_ATTEMPTS) {
              const why = err instanceof Error ? err.message : "upload error";
              throw new Error(
                `Part ${partNumber} failed after ${attempt} tries (${why})`,
              );
            }
            // Brief backoff before retrying the same part.
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
        completedBytes = end;
        setProgress(Math.round((completedBytes / totalBytes) * 100));
      }
    } catch (err) {
      clearStallTimer();
      setStalled(false);
      abortMultipart();
      setError(err instanceof Error ? err.message : "Upload failed");
      setStage("idle");
      return;
    }
    clearStallTimer();

    // 4. Complete: the server lists parts (reads ETags it can see; the browser
    //    can't) and finalizes the object, then enqueues Whisper transcription.
    setStage("confirming");
    try {
      const res = await fetch("/api/uploads/multipart/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          key,
          bucket,
          uploadId,
          contentType,
          fileSize: uploadFile.size,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || `Finalize failed (HTTP ${res.status})`);
        setStage("idle");
        return;
      }
      multipartRef.current = null; // completed — nothing to abort
    } catch (err) {
      setError(err instanceof Error ? err.message : "Finalize failed");
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

          {youtubeAccounts.length > 0 && (
            <div className="space-y-1.5">
              <Label>YouTube channel <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select value={accountId} onValueChange={(v) => setAccountId(v ?? "")} disabled={busy}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a channel…" />
                </SelectTrigger>
                <SelectContent>
                  {youtubeAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.handle}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

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
              {stalled && (
                <p className="text-xs text-amber-600">
                  Upload seems slow — still running, but you can Cancel and retry if it doesn&apos;t move soon.
                </p>
              )}
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
