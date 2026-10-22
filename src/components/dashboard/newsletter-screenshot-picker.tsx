"use client";

// Screenshots for a newsletter's placeholders (`*[Screenshot @ 4:32: …]*`),
// any newsletter whose template asks for them. A frame is picked for each
// automatically when the draft lands; here the editor can scrub the section's
// video and use any moment, try frames around the placeholder's moment, upload
// their own image, or remove it. All free (ffmpeg on our worker, no AI).

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FrameScrubber } from "@/components/design-editor/inspector";
import { cn } from "@/lib/utils";
import { startVisibleInterval } from "@/lib/visible-interval";
import { formatTimestamp, parseScreenshotMarks, type ChosenScreenshot, type ScreenshotMark } from "@/lib/newsletter-screenshots";

interface Frame {
  id: string;
  sec: number;
  status: "pending" | "done" | "failed";
  previewUrl: string | null;
  videoId: string;
}

interface ScreenshotsPayload {
  frames: Frame[];
  chosen: Record<string, ChosenScreenshot>;
  previews: Record<string, string>;
  marks: Record<string, string | null>;
  videoUrls: Record<string, string>;
}

export interface ScreenshotsState {
  frames: Frame[];
  chosen: Record<string, ChosenScreenshot>;
  /** Placeholder → its video id (null: no video, upload only). */
  marks: Record<string, string | null>;
  videoUrls: Record<string, string>;
  /** Preview link for a placeholder's image (null while its frame is still being grabbed). */
  urlFor: (c: ChosenScreenshot, markKey: string) => string | null;
  request: (markKey: string, sec: number) => Promise<void>;
  grabAt: (markKey: string, sec: number) => Promise<void>;
  choose: (markKey: string, frameId: string | null) => Promise<void>;
  upload: (markKey: string, file: File) => Promise<void>;
  busy: string | null;
  error: string | null;
}

export function useScreenshots(draftId: string, enabled: boolean, initialPreviews: Record<string, string> = {}): ScreenshotsState {
  const [state, setState] = useState<ScreenshotsPayload>({ frames: [], chosen: {}, previews: initialPreviews, marks: {}, videoUrls: {} });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    const r = await fetch(`/api/newsletter-drafts/${draftId}/screenshots`);
    return r.ok ? ((await r.json()) as ScreenshotsPayload) : null;
  }, [draftId]);
  const load = useCallback(async () => {
    const j = await fetchState();
    if (j) setState(j);
  }, [fetchState]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchState().then((j) => {
      if (!cancelled && j) setState(j);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, fetchState]);

  // Poll while frames are being grabbed (candidates, a scrubbed moment, or the automatic picks).
  const pending = state.frames.some((f) => f.status === "pending") || Object.values(state.chosen).some((c) => c.pending);
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
  const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const request = (markKey: string, sec: number) =>
    call(`grab:${markKey}`, () => fetch(`/api/newsletter-drafts/${draftId}/screenshots`, json("POST", { markKey, sec })), "Couldn't grab frames");
  const grabAt = (markKey: string, sec: number) =>
    call(`exact:${markKey}`, () => fetch(`/api/newsletter-drafts/${draftId}/screenshots`, json("POST", { markKey, sec, exact: true })), "Couldn't grab that frame");
  const choose = (markKey: string, frameId: string | null) =>
    call(`choose:${markKey}`, () => fetch(`/api/newsletter-drafts/${draftId}/screenshots`, json("PUT", { markKey, frameId })), "Couldn't save that");
  const upload = (markKey: string, file: File) => {
    const form = new FormData();
    form.set("markKey", markKey);
    form.set("file", file);
    return call(`upload:${markKey}`, () => fetch(`/api/newsletter-drafts/${draftId}/screenshots/upload`, { method: "POST", body: form }), "Couldn't upload that image");
  };

  const urlFor = (c: ChosenScreenshot, markKey: string) =>
    c.pending ? null : ((c.frameId ? state.frames.find((f) => f.id === c.frameId)?.previewUrl : null) ?? state.previews[markKey] ?? null);

  return { frames: state.frames, chosen: state.chosen, marks: state.marks, videoUrls: state.videoUrls, urlFor, request, grabAt, choose, upload, busy, error };
}

/** Text view: the screenshot placeholders in one section, each with its panel. */
export function ScreenshotPicker({ sectionKey, markdown, shots }: { sectionKey: string; markdown: string; shots: ScreenshotsState }) {
  const marks = parseScreenshotMarks(sectionKey, markdown);
  if (!marks.length) return null;
  return (
    <div className="flex flex-col gap-3 rounded-md bg-muted/40 p-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Camera className="size-3.5" /> Screenshots
      </span>
      {marks.map((m) => (
        <ScreenshotMarkPanel key={m.key} mark={m} shots={shots} />
      ))}
      {shots.error && <span className="text-xs text-destructive">{shots.error}</span>}
    </div>
  );
}

/** One placeholder: its image, a scrubber over its video, frames near its moment, Upload, Remove. */
export function ScreenshotMarkPanel({ mark: m, shots }: { mark: ScreenshotMark; shots: ScreenshotsState }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = shots.chosen[m.key];
  const pickUrl = pick ? shots.urlFor(pick, m.key) : null;
  const videoId = shots.marks[m.key] ?? null;
  const videoUrl = videoId ? shots.videoUrls[videoId] : undefined;
  const near = m.sec == null || !videoId ? [] : shots.frames.filter((f) => f.videoId === videoId && Math.abs(f.sec - m.sec!) <= 4);
  const grabbing = near.some((f) => f.status === "pending") || shots.busy === `grab:${m.key}`;
  const saving = shots.busy === `choose:${m.key}` || shots.busy === `upload:${m.key}` || shots.busy === `exact:${m.key}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs" title={m.label}>
        {m.sec != null && <span className="font-mono text-muted-foreground">{formatTimestamp(m.sec)} · </span>}
        {m.label}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pick?.pending ? (
          <span className="flex aspect-video w-36 items-center justify-center gap-1 rounded border bg-muted text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Grabbing {pick.sec != null ? formatTimestamp(pick.sec) : "frame"}…
          </span>
        ) : (
          pick &&
          pickUrl && (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pickUrl} alt="" className="aspect-video w-36 rounded border object-cover ring-2 ring-primary" />
              <span className="absolute left-1 top-1 rounded bg-background/90 px-1 text-[10px]">
                {pick.source === "upload" ? "Uploaded" : pick.source === "auto" ? "Auto-picked" : "In the email"}
                {pick.sec != null && pick.source !== "upload" ? ` · ${formatTimestamp(pick.sec)}` : ""}
              </span>
            </div>
          )
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
      </div>

      {videoUrl ? (
        <FrameScrubber key={m.key} videoUrl={videoUrl} initialSec={m.sec ?? 0} busy={saving} onGrab={(sec) => void shots.grabAt(m.key, sec)} />
      ) : videoId ? (
        <span className="text-[11px] text-muted-foreground">This video isn&apos;t archived yet, so frames can&apos;t be grabbed. Upload an image instead.</span>
      ) : (
        <span className="text-[11px] text-muted-foreground">This section&apos;s story has no video (a case study). Upload an image instead.</span>
      )}

      {videoId && m.sec != null && (
        <div className="flex flex-col gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            onClick={() => void shots.request(m.key, m.sec!)}
            disabled={grabbing}
            title="Grab 3 frames around the placeholder's moment (free)"
          >
            {grabbing ? <Loader2 className="animate-spin" /> : <Camera />}
            {near.length ? "Frames around " : "Show frames around "}
            {formatTimestamp(m.sec)}
          </Button>
          {near.length > 0 && (
            <div className="flex gap-2">
              {near.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  disabled={f.status !== "done" || saving}
                  onClick={() => void shots.choose(m.key, f.id)}
                  className={cn(
                    "relative aspect-video w-28 overflow-hidden rounded border bg-muted",
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
        </div>
      )}
    </div>
  );
}
