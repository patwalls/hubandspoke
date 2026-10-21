"use client";

// Screenshots for a How-To draft's placeholders (`*[Screenshot @ 4:32: …]*`):
// "Find frames" grabs three frames around that moment from the archived video
// (free — ffmpeg on our worker, no AI), and clicking one picks it. Picks show
// in the preview and go into the beehiiv draft as images.

import { useCallback, useEffect, useState } from "react";
import { Camera, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { startVisibleInterval } from "@/lib/visible-interval";
import { formatTimestamp, parseScreenshotMarks, type ChosenScreenshot } from "@/lib/newsletter-screenshots";

interface Frame {
  id: string;
  sec: number;
  status: "pending" | "done" | "failed";
  previewUrl: string | null;
}

export interface ScreenshotsState {
  frames: Frame[];
  chosen: Record<string, ChosenScreenshot>;
  /** Preview link for a pick (a fresh frame's link, else the one the draft loaded with). */
  urlFor: (c: ChosenScreenshot) => string | null;
  request: (sec: number) => Promise<void>;
  choose: (markKey: string, frameId: string | null) => Promise<void>;
  error: string | null;
}

export function useScreenshots(draftId: string, enabled: boolean, initialPreviews: Record<string, string> = {}): ScreenshotsState {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [chosen, setChosen] = useState<Record<string, ChosenScreenshot>>({});
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    const r = await fetch(`/api/newsletter-drafts/${draftId}/screenshots`);
    return r.ok ? ((await r.json()) as { frames: Frame[]; chosen: Record<string, ChosenScreenshot> }) : null;
  }, [draftId]);
  const load = useCallback(async () => {
    const j = await fetchState();
    if (!j) return;
    setFrames(j.frames);
    setChosen(j.chosen);
  }, [fetchState]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchState().then((j) => {
      if (cancelled || !j) return;
      setFrames(j.frames);
      setChosen(j.chosen);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, fetchState]);

  const pending = frames.some((f) => f.status === "pending");
  useEffect(() => {
    if (!enabled || !pending) return;
    return startVisibleInterval(() => void load(), 3000);
  }, [enabled, pending, load]);

  const request = async (sec: number) => {
    setError(null);
    const r = await fetch(`/api/newsletter-drafts/${draftId}/screenshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sec }),
    });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't grab frames");
    await load();
  };

  const choose = async (markKey: string, frameId: string | null) => {
    setError(null);
    const r = await fetch(`/api/newsletter-drafts/${draftId}/screenshots`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markKey, frameId }),
    });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save the pick");
    await load();
  };

  const urlFor = (c: ChosenScreenshot) =>
    frames.find((f) => f.id === c.frameId)?.previewUrl ?? Object.entries(initialPreviews).find(([k]) => chosen[k]?.frameId === c.frameId)?.[1] ?? null;

  return { frames, chosen, urlFor, request, choose, error };
}

/** The screenshot placeholders in one section, each with its candidate frames. */
export function ScreenshotPicker({ sectionKey, markdown, shots }: { sectionKey: string; markdown: string; shots: ScreenshotsState }) {
  const marks = parseScreenshotMarks(sectionKey, markdown);
  if (!marks.length) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Camera className="size-3.5" /> Screenshots from the video
      </span>
      {marks.map((m) => {
        const near = m.sec == null ? [] : shots.frames.filter((f) => Math.abs(f.sec - m.sec!) <= 4);
        const pick = shots.chosen[m.key];
        const busy = near.some((f) => f.status === "pending");
        return (
          <div key={m.key} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={m.label}>
                {m.sec != null ? <span className="font-mono text-muted-foreground">{formatTimestamp(m.sec)} · </span> : null}
                {m.label}
              </span>
              {m.sec == null ? (
                <span className="text-[11px] text-muted-foreground">no timestamp — redraft to get one</span>
              ) : (
                <Button size="xs" variant="outline" onClick={() => void shots.request(m.sec!)} disabled={busy} title="Grab 3 frames around this moment (free)">
                  {busy ? <Loader2 className="animate-spin" /> : <Camera />}
                  {near.length ? "Grab again" : "Find frames"}
                </Button>
              )}
              {pick && (
                <Button size="xs" variant="ghost" onClick={() => void shots.choose(m.key, null)}>
                  Clear
                </Button>
              )}
            </div>
            {near.length > 0 && (
              <div className="flex gap-2">
                {near.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    disabled={f.status !== "done"}
                    onClick={() => void shots.choose(m.key, f.id)}
                    className={cn(
                      "relative aspect-video w-36 overflow-hidden rounded border bg-muted",
                      pick?.frameId === f.id ? "ring-2 ring-primary" : "hover:ring-2 hover:ring-primary/40",
                    )}
                    title={`${formatTimestamp(f.sec)}${f.status === "failed" ? " — couldn't grab this frame" : ""}`}
                  >
                    {f.status === "done" && f.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.previewUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <span className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
                        {f.status === "failed" ? "failed" : <Loader2 className="size-4 animate-spin" />}
                      </span>
                    )}
                    {pick?.frameId === f.id && (
                      <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                        <Check className="size-3" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {shots.error && <span className="text-xs text-destructive">{shots.error}</span>}
    </div>
  );
}
