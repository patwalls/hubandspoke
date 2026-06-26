"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

// Persistent TikTok publish-status banner. Driven off the item's zernioStatus
// so it survives a refresh: published (with live link) / publishing (async,
// awaiting webhook) / scheduled (cancelable) / failed (retry).

interface Props {
  itemId: string;
  zernioStatus: string | null | undefined;
  zernioError: string | null | undefined;
  zernioScheduledAt: string | null | undefined;
  /** Reopen the publish dialog (used for Retry). */
  onRetry: () => void;
  /** Refetch the item after a state change (cancel). */
  onChanged: () => void;
}

export function TiktokDraftBanner({
  itemId,
  zernioStatus,
  zernioError,
  zernioScheduledAt,
  onRetry,
  onChanged,
}: Props) {
  const [working, setWorking] = useState(false);

  // While a publish is finalizing on Zernio's side, poll the status endpoint
  // (which reconciles against Zernio and flips us to Published). Drives the
  // spinner; stops once settled or after a sane cap. No worker/webhook needed.
  const pollingRef = useRef(false);
  useEffect(() => {
    if (zernioStatus !== "publishing" || pollingRef.current) return;
    pollingRef.current = true;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const res = await fetch(
          `/api/production-items/${itemId}/tiktok-status`,
        );
        const json = await res.json().catch(() => ({}));
        if (!cancelled && json?.settled) {
          onChanged(); // reload — item is now published/failed
          return;
        }
      } catch {
        // transient — keep polling
      }
      // Publish is quick; poll fast for the first ~2 min, then give up (the
      // worker fallback / webhook will catch a genuinely slow one).
      if (!cancelled && attempts < 40) {
        setTimeout(() => void tick(), 3000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      pollingRef.current = false;
    };
  }, [zernioStatus, itemId, onChanged]);

  if (!zernioStatus || zernioStatus === "sending") return null;

  async function cancelSchedule() {
    setWorking(true);
    try {
      const res = await fetch(`/api/production-items/${itemId}/tiktok-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "cancel" }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error(json?.error || "Couldn't cancel");
        return;
      }
      toast.success("Schedule cancelled");
      onChanged();
    } catch {
      toast.error("Couldn't cancel");
    } finally {
      setWorking(false);
    }
  }

  // Published needs no banner — the header CTA already flips to "View Live
  // Post" and the status chip reads Published. A green banner here is just
  // noise. We only surface the transient / actionable states below.
  if (zernioStatus === "publishing") {
    return (
      <div className="flex items-center gap-2.5 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs text-sky-800">
        <Loader2Icon className="size-4 shrink-0 animate-spin text-sky-500" />
        <div>
          <span className="font-medium">Publishing to TikTok…</span> hang tight,
          this updates automatically the moment TikTok confirms.
        </div>
      </div>
    );
  }

  if (zernioStatus === "scheduled") {
    const when = zernioScheduledAt
      ? new Date(zernioScheduledAt).toLocaleString()
      : "the scheduled time";
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs text-sky-800">
        <div>
          <span className="font-medium">Scheduled</span> — we&apos;ll publish
          this to TikTok at {when}.
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={working}
          onClick={() => void cancelSchedule()}
        >
          {working ? "…" : "Cancel"}
        </Button>
      </div>
    );
  }

  if (zernioStatus === "failed") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
        <div className="min-w-0">
          <span className="font-medium">TikTok publish failed.</span>{" "}
          {zernioError && <span className="break-words">{zernioError}</span>}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  return null;
}
