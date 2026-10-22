"use client";

// Screenshots for a newsletter's placeholders (`*[Screenshot @ 4:32: …]*`),
// any newsletter whose template asks for them. A frame is picked for each
// automatically when the draft lands, along with a strip of 12 frames across
// that step's part of the video; here the editor can pick any of them, play
// the video with its transcript (search it for where the step is mentioned,
// click a line to jump there) and use the exact frame on screen, upload their
// own image, or remove it. All free (ffmpeg on our worker, no AI).

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TranscriptScrubber, type TranscriptLine } from "@/components/dashboard/transcript-scrubber";
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
  sectionVideos: Record<string, string | null>;
  thumbnails: Record<string, string>;
  transcripts: Record<string, TranscriptLine[]>;
}

export interface ScreenshotsState {
  frames: Frame[];
  chosen: Record<string, ChosenScreenshot>;
  /** Placeholder → its video id (null: no video, upload only). */
  marks: Record<string, string | null>;
  videoUrls: Record<string, string>;
  /** Section key → its video id; video id → its YouTube thumbnail. */
  sectionVideos: Record<string, string | null>;
  thumbnails: Record<string, string>;
  /** Video id → its transcript lines (for the picker's read-along). */
  transcripts: Record<string, TranscriptLine[]>;
  /** Preview link for a placeholder's image (null while its frame is still being grabbed). */
  urlFor: (c: ChosenScreenshot, markKey: string) => string | null;
  request: (markKey: string, sec: number) => Promise<void>;
  /** Grab the strip of 12 frames across a placeholder's moment. */
  requestWindow: (markKey: string) => Promise<void>;
  grabAt: (markKey: string, sec: number) => Promise<void>;
  choose: (markKey: string, frameId: string | null) => Promise<void>;
  upload: (markKey: string, file: File) => Promise<void>;
  busy: string | null;
  error: string | null;
}

export function useScreenshots(draftId: string, enabled: boolean, initialPreviews: Record<string, string> = {}): ScreenshotsState {
  const [state, setState] = useState<ScreenshotsPayload>({ frames: [], chosen: {}, previews: initialPreviews, marks: {}, videoUrls: {}, sectionVideos: {}, thumbnails: {}, transcripts: {} });
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
  const requestWindow = (markKey: string) =>
    call(`window:${markKey}`, () => fetch(`/api/newsletter-drafts/${draftId}/screenshots`, json("POST", { markKey, window: true })), "Couldn't grab frames");
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

  return {
    frames: state.frames,
    chosen: state.chosen,
    marks: state.marks,
    videoUrls: state.videoUrls,
    sectionVideos: state.sectionVideos,
    thumbnails: state.thumbnails,
    transcripts: state.transcripts,
    urlFor,
    request,
    requestWindow,
    grabAt,
    choose,
    upload,
    busy,
    error,
  };
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

/** Pickable frames, 3 across, each with its time; the current pick is marked. */
function FrameGrid({ frames, pickedId, disabled, onPick }: { frames: Frame[]; pickedId: string | null; disabled: boolean; onPick: (id: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {frames.map((f) => (
        <button
          key={f.id}
          type="button"
          disabled={f.status !== "done" || disabled}
          onClick={() => onPick(f.id)}
          className={cn("relative aspect-video overflow-hidden rounded border bg-muted", pickedId === f.id ? "ring-2 ring-primary" : "hover:ring-2 hover:ring-primary/40")}
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
          <span className="absolute bottom-0.5 left-0.5 rounded bg-background/90 px-1 font-mono text-[10px]">{formatTimestamp(f.sec)}</span>
          {pickedId === f.id && (
            <span className="absolute right-0.5 top-0.5 rounded-full bg-primary p-0.5 text-primary-foreground">
              <Check className="size-3" />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * One placeholder: its image (Remove / Upload / back to the video thumbnail),
 * a grid of frames across that step's part of the video, and the video with
 * its transcript to find any other moment.
 */
export function ScreenshotMarkPanel({ mark: m, shots, onUseThumbnail }: { mark: ScreenshotMark; shots: ScreenshotsState; onUseThumbnail?: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = shots.chosen[m.key];
  const pickUrl = pick ? shots.urlFor(pick, m.key) : null;
  const videoId = shots.marks[m.key] ?? null;
  const videoUrl = videoId ? shots.videoUrls[videoId] : undefined;
  // The step's strip: frames from just before its moment to ~40s after (screenshotWindowSecs), plus anything grabbed near it.
  const strip =
    m.sec == null || !videoId
      ? []
      : shots.frames.filter((f) => f.videoId === videoId && f.sec >= m.sec! - 5 && f.sec <= m.sec! + 41 && f.status !== "failed").sort((a, b) => a.sec - b.sec);
  const loadingStrip = shots.busy === `window:${m.key}`;
  const saving = shots.busy === `choose:${m.key}` || shots.busy === `upload:${m.key}` || shots.busy === `exact:${m.key}`;

  return (
    <div className="flex flex-col gap-3">
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
        {onUseThumbnail && videoId && shots.thumbnails[videoId] && (
          <Button size="xs" variant="ghost" onClick={onUseThumbnail} disabled={saving} title="Put the video's thumbnail here instead">
            <ImageIcon /> Use the video thumbnail
          </Button>
        )}
      </div>

      {videoId && m.sec != null && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Frames from this step · {formatTimestamp(Math.max(0, m.sec - 4))} to {formatTimestamp(m.sec + 40)}</span>
          {strip.length >= 6 ? (
            <FrameGrid frames={strip} pickedId={pick?.frameId ?? null} disabled={saving} onPick={(id) => void shots.choose(m.key, id)} />
          ) : (
            <>
              {strip.length > 0 && <FrameGrid frames={strip} pickedId={pick?.frameId ?? null} disabled={saving} onPick={(id) => void shots.choose(m.key, id)} />}
              <Button size="xs" variant="outline" className="self-start" onClick={() => void shots.requestWindow(m.key)} disabled={loadingStrip || !videoUrl}>
                {loadingStrip ? <Loader2 className="animate-spin" /> : <Camera />} Show 12 frames from this step
              </Button>
            </>
          )}
        </div>
      )}

      {videoUrl ? (
        <TranscriptScrubber
          key={m.key}
          videoUrl={videoUrl}
          transcript={shots.transcripts[videoId!] ?? []}
          initialSec={m.sec ?? 0}
          busy={saving}
          onGrab={(sec) => void shots.grabAt(m.key, sec)}
        />
      ) : videoId ? (
        <span className="text-[11px] text-muted-foreground">This video isn&apos;t archived yet, so frames can&apos;t be grabbed. Upload an image instead.</span>
      ) : (
        <span className="text-[11px] text-muted-foreground">This section&apos;s story has no video (a case study). Upload an image instead.</span>
      )}
    </div>
  );
}

/**
 * An image in a draft's text (the video thumbnail, or any other): swap it for
 * an upload or a frame from the section's video, put the video thumbnail
 * back, or remove it. Swapping turns it into a screenshot placeholder (the
 * editor does that), so its picks work exactly like screenshots.
 */
export function ImagePanel({
  url,
  alt,
  isThumbnail,
  videoUrl,
  transcript,
  thumbnailUrl,
  busy,
  onUpload,
  onGrab,
  onUseThumbnail,
  onRemove,
}: {
  url: string;
  alt: string;
  isThumbnail: boolean;
  videoUrl: string | null;
  /** The section video's transcript lines, for the read-along. */
  transcript: TranscriptLine[];
  thumbnailUrl: string | null;
  busy: boolean;
  onUpload: (file: File) => void;
  onGrab: (sec: number) => void;
  onUseThumbnail: () => void;
  onRemove: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">{isThumbnail ? "Video thumbnail" : "Image"}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className="w-full rounded border" />
      {alt && <span className="text-xs text-muted-foreground">{alt}</span>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy} title="Use your own image (PNG, JPG, WebP or GIF, up to 10 MB)">
          {busy ? <Loader2 className="animate-spin" /> : <Upload />} Upload your own
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
        {thumbnailUrl && thumbnailUrl !== url && (
          <Button size="xs" variant="ghost" onClick={onUseThumbnail} disabled={busy}>
            <ImageIcon /> Use the video thumbnail
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={onRemove} disabled={busy} title="Take the image out of the section">
          <Trash2 /> Remove
        </Button>
      </div>
      {videoUrl ? (
        <TranscriptScrubber videoUrl={videoUrl} transcript={transcript} busy={busy} onGrab={onGrab} />
      ) : (
        <span className="text-[11px] text-muted-foreground">No archived video for this section, so frames can&apos;t be grabbed. Upload an image instead.</span>
      )}
    </div>
  );
}
