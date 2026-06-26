"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProductionItem } from "@/types";
import { parseNaturalTime, formatScheduledTime } from "@/lib/parse-natural-time";

// TikTok Publish-or-Schedule dialog. Publishes the video LIVE to the connected
// account via Zernio (pre-audited client), with the caption + chosen privacy —
// no app step. Two-column: the actual video on the left, the actual caption +
// controls on the right, so it reads wide instead of tall.
//
// "Go to the old way" drops back to the generic mark-as-published modal (paste
// a live link) — the path for un-connected accounts and every other platform.

interface PreviewBlock {
  code: string;
  message: string;
}

interface PrivacyLevel {
  value: string;
  label: string;
}

interface PublishPreview {
  caption: string;
  videoUrl: string | null;
  videoPosterUrl: string | null;
  mediaId: string | null;
  accountConnected: boolean;
  privacyLevels: PrivacyLevel[];
  zernioStatus: string | null;
  blockingReasons: PreviewBlock[];
  warnings: PreviewBlock[];
}

type Mode = "publish" | "schedule";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ProductionItem;
  onSuccess?: () => void;
  onGoOldWay?: () => void;
}

const QUICK_CHIPS = ["in 1 hour", "in 3 hours", "tonight", "tomorrow 9am"];

export function TiktokDraftDialog({
  open,
  onOpenChange,
  item,
  onSuccess,
  onGoOldWay,
}: Props) {
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("publish");
  const [privacy, setPrivacy] = useState<string>("PUBLIC_TO_EVERYONE");
  const [whenText, setWhenText] = useState("");
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hard guard against a double-fire racing the server idempotency claim.
  const submittingRef = useRef(false);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/production-items/${item.id}/tiktok-draft`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error || "Couldn't load the TikTok preview");
        setPreview(null);
        return;
      }
      const p = json.preview as PublishPreview;
      setPreview(p);
      // Default privacy to Public if available, else the first allowed value.
      const pub = p.privacyLevels.find((l) => l.value === "PUBLIC_TO_EVERYONE");
      setPrivacy(pub?.value ?? p.privacyLevels[0]?.value ?? "PUBLIC_TO_EVERYONE");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load preview");
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [item.id]);

  useEffect(() => {
    if (!open) return;
    setMode("publish");
    setWhenText("");
    setScheduledAt(null);
    setSubmitting(false);
    setError(null);
    submittingRef.current = false;
    void loadPreview();
  }, [open, loadPreview]);

  useEffect(() => {
    if (mode !== "schedule") return;
    setScheduledAt(whenText.trim() ? parseNaturalTime(whenText) : null);
  }, [whenText, mode]);

  const blocked = (preview?.blockingReasons.length ?? 0) > 0;
  const scheduleValid =
    mode === "publish" ||
    (!!scheduledAt && scheduledAt.getTime() > Date.now());
  const canSubmit =
    !loading && !submitting && !blocked && !!preview && scheduleValid;

  async function handleSubmit() {
    if (!canSubmit || !preview || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> =
        mode === "publish"
          ? {
              mode: "send-now",
              privacyLevel: privacy,
              expectedMediaId: preview.mediaId,
              expectedCaption: preview.caption,
            }
          : {
              mode: "schedule",
              privacyLevel: privacy,
              scheduledAt: scheduledAt!.toISOString(),
            };

      const res = await fetch(`/api/production-items/${item.id}/tiktok-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error || "Couldn't publish to TikTok");
        void loadPreview();
        return;
      }
      if (mode === "publish") {
        toast.success(
          json.status === "published"
            ? "Published to TikTok 🎉"
            : "Publishing to TikTok — we'll update when it's live",
        );
      } else {
        toast.success(
          `Scheduled for ${formatScheduledTime(scheduledAt!)} — we'll publish it then`,
        );
      }
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't publish to TikTok");
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  const submitLabel = submitting
    ? mode === "schedule"
      ? "Scheduling…"
      : "Publishing…"
    : mode === "schedule"
      ? "Schedule"
      : "Publish now";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Publish or schedule to TikTok</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Loading preview…
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-[210px_1fr]">
            {/* LEFT — the actual video that will be posted. */}
            <div className="space-y-1.5">
              <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg border border-border bg-black">
                {preview?.videoUrl ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video
                    src={preview.videoUrl}
                    poster={preview.videoPosterUrl ?? undefined}
                    controls
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
                    no video
                  </div>
                )}
              </div>
              <p className="text-center text-[11px] text-muted-foreground">
                Exactly what will be posted
              </p>
            </div>

            {/* RIGHT — caption + controls. */}
            <div className="space-y-4">
              <div className="space-y-1">
                <Label>Caption</Label>
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                  {preview?.caption || "(no caption written yet)"}
                </div>
              </div>

              {!preview?.accountConnected && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  This TikTok account isn&apos;t connected. Connect it on the
                  Accounts page, or use the old way to mark it published.
                </div>
              )}

              {preview && preview.blockingReasons.length > 0 && (
                <div className="space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {preview.blockingReasons.map((b) => (
                    <div key={b.code}>• {b.message}</div>
                  ))}
                </div>
              )}

              {preview && preview.warnings.length > 0 && (
                <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  {preview.warnings.map((w) => (
                    <div key={w.code}>• {w.message}</div>
                  ))}
                </div>
              )}

              {!blocked && (
                <>
                  {/* Privacy. */}
                  {preview && preview.privacyLevels.length > 0 && (
                    <div className="space-y-1">
                      <Label htmlFor="tiktok-privacy">Privacy</Label>
                      <select
                        id="tiktok-privacy"
                        value={privacy}
                        onChange={(e) => setPrivacy(e.target.value)}
                        className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                      >
                        {preview.privacyLevels.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Publish now vs schedule. */}
                  <div className="flex w-full rounded-md border border-border bg-muted/40 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setMode("publish")}
                      className={cn(
                        "flex-1 rounded-sm px-3 py-1.5 font-medium transition-colors",
                        mode === "publish"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Publish now
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("schedule")}
                      className={cn(
                        "flex-1 rounded-sm px-3 py-1.5 font-medium transition-colors",
                        mode === "schedule"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Schedule
                    </button>
                  </div>

                  {mode === "schedule" && (
                    <div className="space-y-2">
                      <Label htmlFor="tiktok-when">When</Label>
                      <Input
                        id="tiktok-when"
                        placeholder="in 2 hours, tomorrow 9am, 7pm…"
                        value={whenText}
                        onChange={(e) => setWhenText(e.target.value)}
                        autoFocus
                      />
                      <div className="flex flex-wrap gap-1.5">
                        {QUICK_CHIPS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setWhenText(c)}
                            className="rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                      {scheduledAt ? (
                        <p className="text-xs text-emerald-700">
                          → {formatScheduledTime(scheduledAt)}
                        </p>
                      ) : whenText.trim() ? (
                        <p className="text-xs text-red-600">
                          Couldn&apos;t read that time — try “in 2 hours” or “tomorrow 9am”.
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          Type a time in plain English. Shown in your local
                          timezone.
                        </p>
                      )}
                    </div>
                  )}

                  <p className="text-[11px] text-muted-foreground">
                    {mode === "publish"
                      ? "Posts live to your TikTok now — caption and all."
                      : "We publish it live at that time."}{" "}
                    By publishing you confirm it meets TikTok&apos;s content
                    policies.
                  </p>
                </>
              )}

              {error && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {error}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => onGoOldWay?.()}
            disabled={submitting}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            Go to the old way
          </button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {submitLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
