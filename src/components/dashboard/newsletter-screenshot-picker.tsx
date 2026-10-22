"use client";

// Screenshots for a How-To draft's placeholders (`*[Screenshot @ 4:32: …]*`):
// "Find frames" grabs three frames around that moment from the archived video
// (free — ffmpeg on our worker, no AI) and clicking one picks it; "Grab at"
// tries another moment; "Upload" uses your own image; "Remove" takes the image
// off. Picks show in the preview and go into the beehiiv draft as images.

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { startVisibleInterval } from "@/lib/visible-interval";
import { formatTimestamp, parseScreenshotMarks, parseTimestamp, type ChosenScreenshot, type ScreenshotMark } from "@/lib/newsletter-screenshots";

interface Frame {
  id: string;
  sec: number;
  status: "pending" | "done" | "failed";
  previewUrl: string | null;
}

interface ScreenshotsPayload {
  frames: Frame[];
  chosen: Record<string, ChosenScreenshot>;
  previews: Record<string, string>;
}

export interface ScreenshotsState {
  frames: Frame[];
  chosen: Record<string, ChosenScreenshot>;
  /** Preview link for a placeholder's image (a fresh frame's link, else the pick's own preview). */
  urlFor: (c: ChosenScreenshot, markKey: string) => string | null;
  request: (sec: number) => Promise<void>;
  choose: (markKey: string, frameId: string | null) => Promise<void>;
  upload: (markKey: string, file: File) => Promise<void>;
  busy: string | null;
  error: string | null;
}

export function useScreenshots(draftId: string, enabled: boolean, initialPreviews: Record<string, string> = {}): ScreenshotsState {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [chosen, setChosen] = useState<Record<string, ChosenScreenshot>>({});
  const [previews, setPreviews] = useState<Record<string, string>>(initialPreviews);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    const r = await fetch(`/api/newsletter-drafts/${draftId}/screenshots`);
    return r.ok ? ((await r.json()) as ScreenshotsPayload) : null;
  }, [draftId]);
  const apply = (j: ScreenshotsPayload) => {
    setFrames(j.frames);
    setChosen(j.chosen);
    setPreviews(j.previews);
  };
  const load = useCallback(async () => {
    const j = await fetchState();
    if (j) apply(j);
  }, [fetchState]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchState().then((j) => {
      if (!cancelled && j) apply(j);
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

  const call = async (label: string, run: () => Promise<Response>, fallback: string) => {
    setError(null);
    setBusy(label);
    try {
      const r = await run();
      if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? fallback);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const request = (sec: number) =>
    call(
      `grab:${sec}`,
      () => fetch(`/api/newsletter-drafts/${draftId}/screenshots`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sec }) }),
      "Couldn't grab frames",
    );
  const choose = (markKey: string, frameId: string | null) =>
    call(
      `choose:${markKey}`,
      () => fetch(`/api/newsletter-drafts/${draftId}/screenshots`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markKey, frameId }) }),
      "Couldn't save that",
    );
  const upload = (markKey: string, file: File) => {
    const form = new FormData();
    form.set("markKey", markKey);
    form.set("file", file);
    return call(`upload:${markKey}`, () => fetch(`/api/newsletter-drafts/${draftId}/screenshots/upload`, { method: "POST", body: form }), "Couldn't upload that image");
  };

  const urlFor = (c: ChosenScreenshot, markKey: string) => (c.frameId ? frames.find((f) => f.id === c.frameId)?.previewUrl : null) ?? previews[markKey] ?? null;

  return { frames, chosen, urlFor, request, choose, upload, busy, error };
}

/** The screenshot placeholders in one section: the current image, frames to pick from, upload, remove. */
export function ScreenshotPicker({ sectionKey, markdown, shots }: { sectionKey: string; markdown: string; shots: ScreenshotsState }) {
  const marks = parseScreenshotMarks(sectionKey, markdown);
  if (!marks.length) return null;
  return (
    <div className="flex flex-col gap-3 rounded-md bg-muted/40 p-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Camera className="size-3.5" /> Screenshots
      </span>
      {marks.map((m) => (
        <MarkRow key={m.key} mark={m} shots={shots} />
      ))}
      {shots.error && <span className="text-xs text-destructive">{shots.error}</span>}
    </div>
  );
}

function MarkRow({ mark: m, shots }: { mark: ScreenshotMark; shots: ScreenshotsState }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [at, setAt] = useState(m.sec != null ? formatTimestamp(m.sec) : "");
  const pick = shots.chosen[m.key];
  const pickUrl = pick ? shots.urlFor(pick, m.key) : null;
  const atSec = /^\d{1,2}(:\d{2}){1,2}$/.test(at.trim()) ? parseTimestamp(at.trim()) : null;
  const center = atSec ?? m.sec;
  const near = center == null ? [] : shots.frames.filter((f) => Math.abs(f.sec - center) <= 4);
  const grabbing = near.some((f) => f.status === "pending") || shots.busy === `grab:${center}`;
  const saving = shots.busy === `choose:${m.key}` || shots.busy === `upload:${m.key}`;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs" title={m.label}>
        {m.sec != null && <span className="font-mono text-muted-foreground">{formatTimestamp(m.sec)} · </span>}
        {m.label}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pick && pickUrl && (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pickUrl} alt="" className="aspect-video w-36 rounded border object-cover ring-2 ring-primary" />
            <span className="absolute left-1 top-1 rounded bg-background/90 px-1 text-[10px]">{pick.source === "upload" ? "Uploaded" : "In the email"}</span>
          </div>
        )}
        {pick && (
          <Button size="xs" variant="ghost" onClick={() => void shots.choose(m.key, null)} disabled={saving} title="Take the image off (the placeholder stays)">
            <Trash2 /> Remove
          </Button>
        )}
        <Button size="xs" variant="outline" onClick={() => fileRef.current?.click()} disabled={saving} title="Use your own image (PNG, JPG, WebP or GIF, up to 10 MB)">
          {shots.busy === `upload:${m.key}` ? <Loader2 className="animate-spin" /> : <Upload />}
          {pick ? "Replace with upload" : "Upload"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void shots.upload(m.key, f);
            e.target.value = "";
          }}
        />
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          Grab at
          <Input className="h-7 w-16 font-mono text-xs" value={at} placeholder="M:SS" onChange={(e) => setAt(e.target.value)} />
        </span>
        <Button size="xs" variant="outline" onClick={() => center != null && void shots.request(center)} disabled={center == null || grabbing} title="Grab 3 frames around this moment from the video (free)">
          {grabbing ? <Loader2 className="animate-spin" /> : <Camera />}
          {near.length ? "Grab again" : "Find frames"}
        </Button>
      </div>

      {near.length > 0 && (
        <div className="flex gap-2">
          {near.map((f) => (
            <button
              key={f.id}
              type="button"
              disabled={f.status !== "done" || saving}
              onClick={() => void shots.choose(m.key, f.id)}
              className={cn(
                "relative aspect-video w-36 overflow-hidden rounded border bg-muted",
                pick?.frameId === f.id ? "ring-2 ring-primary" : "hover:ring-2 hover:ring-primary/40",
              )}
              title={`${formatTimestamp(f.sec)}${f.status === "failed" ? " — couldn't grab this frame" : " — click to use"}`}
            >
              {f.status === "done" && f.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.previewUrl} alt="" className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
                  {f.status === "failed" ? "failed" : <Loader2 className="size-4 animate-spin" />}
                </span>
              )}
              <span className="absolute bottom-1 left-1 rounded bg-background/90 px-1 font-mono text-[10px]">{formatTimestamp(f.sec)}</span>
              {pick?.frameId === f.id && (
                <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                  <Check className="size-3" />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {m.sec == null && !atSec && <span className="text-[11px] text-muted-foreground">No timestamp on this placeholder: type a time to grab frames, or upload an image.</span>}
    </div>
  );
}
