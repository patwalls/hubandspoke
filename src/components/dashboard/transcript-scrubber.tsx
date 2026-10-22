"use client";

// The newsletter screenshot picker's video + transcript: play the section's
// video with sound, read along in the transcript (the current line is
// highlighted and kept in view), search it for where a step is mentioned,
// click any line to jump there, then "Use this frame" grabs the exact moment
// on screen. Free: the grab is ffmpeg on our worker.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Camera, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/lib/newsletter-screenshots";

export interface TranscriptLine {
  sec: number;
  text: string;
}

/** The query's matches in `text`, marked. */
function marked(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-amber-200 px-0.5 text-inherit">{text.slice(i, i + q.length)}</mark>
      {marked(text.slice(i + q.length), q)}
    </>
  );
}

export function TranscriptScrubber({
  videoUrl,
  transcript,
  initialSec = 0,
  busy = false,
  onGrab,
}: {
  videoUrl: string;
  transcript: TranscriptLine[];
  initialSec?: number;
  busy?: boolean;
  onGrab: (sec: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(initialSec);
  // Ignore the video's own time events until it has loaded and jumped to the start moment
  // (an early "0:00" would otherwise pull the transcript away from the step).
  const ready = useRef(false);
  const [q, setQ] = useState("");

  // The line being spoken: the last one starting at or before the playhead.
  const active = useMemo(() => {
    let i = -1;
    for (let k = 0; k < transcript.length && transcript[k].sec <= now + 0.25; k++) i = k;
    return i;
  }, [now, transcript]);

  useEffect(() => {
    if (q.trim()) return;
    listRef.current?.querySelector(`[data-line="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, q]);

  const lines = transcript.map((l, i) => ({ ...l, i }));
  const shown = q.trim() ? lines.filter((l) => l.text.toLowerCase().includes(q.trim().toLowerCase())) : lines;
  const seek = (sec: number) => {
    if (videoRef.current && ready.current) videoRef.current.currentTime = sec;
    setNow(sec);
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-2">
      <span className="text-[11px] text-muted-foreground">Play or scrub the video, or click a line of the transcript to jump there, then use the frame on screen.</span>
      <video
        ref={videoRef}
        src={videoUrl}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          ready.current = true;
          e.currentTarget.currentTime = now;
        }}
        onTimeUpdate={(e) => ready.current && setNow(e.currentTarget.currentTime)}
        onSeeked={(e) => ready.current && setNow(e.currentTarget.currentTime)}
        className="w-full rounded bg-black"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{formatTimestamp(now)}</span>
        <button
          type="button"
          onClick={() => onGrab(ready.current && videoRef.current ? videoRef.current.currentTime : now)}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Camera className="size-3" />} Use this frame
        </button>
      </div>
      {transcript.length > 0 ? (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-8 pl-7 text-xs" placeholder="Search the transcript, e.g. 'copy prompt'" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div ref={listRef} className="max-h-64 overflow-y-auto rounded border bg-background text-xs">
            {shown.length ? (
              shown.map((l) => (
                <button
                  key={l.i}
                  type="button"
                  data-line={l.i}
                  onClick={() => seek(l.sec)}
                  className={cn("flex w-full gap-2 px-2 py-1 text-left leading-snug hover:bg-muted", l.i === active && "bg-[#eef6ff]")}
                >
                  <span className="w-9 shrink-0 font-mono text-muted-foreground">{formatTimestamp(l.sec)}</span>
                  <span>{marked(l.text, q.trim())}</span>
                </button>
              ))
            ) : (
              <p className="px-2 py-2 text-muted-foreground">Nothing in the transcript matches.</p>
            )}
          </div>
        </>
      ) : (
        <span className="text-[11px] text-muted-foreground">No transcript for this video, so scrub the video to find the moment.</span>
      )}
    </div>
  );
}
