"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import type { PickerAccount } from "@/components/ui/account-post-type-picker";

type Stage = "idle" | "fetching" | "submitting";

interface PreviewData {
  title: string | null;
  publishedDate: string | null;
  thumbnail: string | null;
}

interface UploadExternalLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brand: string;
  formats?: string[];
  accounts?: PickerAccount[];
}

export function UploadExternalLinkDialog({
  open,
  onOpenChange,
  brand,
  formats,
  accounts,
}: UploadExternalLinkDialogProps) {
  const router = useRouter();
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("");
  const [accountId, setAccountId] = useState("");
  const youtubeAccounts = accounts?.filter((a) => a.platform === "youtube" && a.isActive) ?? [];
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setYoutubeUrl("");
    setTitle("");
    setFormat("");
    setAccountId("");
    setPreview(null);
    setStage("idle");
    setError(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleFetch() {
    const url = youtubeUrl.trim();
    if (!url) return;
    setError(null);
    setStage("fetching");
    try {
      const res = await fetch("/api/production-items/preview-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, brand }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((json as { error?: string }).error || `Failed to fetch metadata (HTTP ${res.status})`);
        setStage("idle");
        return;
      }
      const data = json as { title?: string | null; publishedDate?: string | null; thumbnail?: string | null };
      setPreview({
        title: data.title ?? null,
        publishedDate: data.publishedDate ?? null,
        thumbnail: data.thumbnail ?? null,
      });
      if (data.title && !title) setTitle(data.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setStage("idle");
    }
  }

  async function handleSubmit() {
    const url = youtubeUrl.trim();
    const t = title.trim();
    if (!url || !t) return;
    setError(null);
    setStage("submitting");
    try {
      const res = await fetch("/api/production-items/upload-external-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          youtubeUrl: url,
          title: t,
          brand,
          format: format || undefined,
          accountId: accountId || undefined,
          publishedDate: preview?.publishedDate ?? undefined,
          thumbnail: preview?.thumbnail ?? undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((json as { error?: string }).error || `Server error (HTTP ${res.status}) — check logs`);
        setStage("idle");
        return;
      }
      const data = json as { id: string; alreadyExists?: boolean };
      if (data.alreadyExists) {
        toast.info("This video is already in the library — taking you there now");
      } else {
        toast.success("External video added — download queued, clip ideas will generate after transcription");
      }
      handleOpenChange(false);
      router.push(`/${brand}/content/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      setStage("idle");
    }
  }

  const busy = stage !== "idle";
  const canFetch = !!youtubeUrl.trim() && !busy;
  const canSubmit = !!youtubeUrl.trim() && !!title.trim() && !busy;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload External Link</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="ext-url">YouTube URL</Label>
            <div className="flex gap-2">
              <Input
                id="ext-url"
                value={youtubeUrl}
                onChange={(e) => {
                  setYoutubeUrl(e.target.value);
                  setPreview(null);
                }}
                placeholder="https://www.youtube.com/watch?v=…"
                disabled={busy}
                onKeyDown={(e) => e.key === "Enter" && canFetch && handleFetch()}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleFetch}
                disabled={!canFetch}
                className="shrink-0"
              >
                {stage === "fetching" ? "Fetching…" : "Fetch"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste the URL then click Fetch to auto-fill the title.
            </p>
          </div>

          {preview?.thumbnail && (
            <div className="overflow-hidden rounded-md border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview.thumbnail}
                alt=""
                className="w-full object-cover"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ext-title">Title</Label>
            <Input
              id="ext-title"
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

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
              {stage === "submitting" ? "Adding…" : "Add video"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
