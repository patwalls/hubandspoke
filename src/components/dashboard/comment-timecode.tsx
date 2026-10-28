"use client";

import { useEffect, useState } from "react";
import { MapPinIcon, PlayIcon, XIcon } from "lucide-react";
import { formatTimecode } from "@/lib/comments/timecode";
import { trackUsage } from "@/lib/usage/track";

/**
 * Review notes pinned to a moment of the video (review-notes M1).
 *
 * The content page wraps its preview + activity columns in
 * `[data-review-player]`; whichever `<video>` in there the person is
 * watching is "the player". Found through the DOM rather than a threaded
 * ref because the preview renders a different player per platform
 * (reel, TikTok, YouTube, carousel slides).
 */
export function findReviewVideo(): HTMLVideoElement | null {
  if (typeof document === "undefined") return null;
  const videos = Array.from(
    document.querySelectorAll<HTMLVideoElement>("[data-review-player] video"),
  );
  return (
    videos.find((v) => !v.paused) ??
    videos.find((v) => v.currentTime > 0) ??
    videos.find((v) => v.readyState >= 1) ??
    null
  );
}

/** The player's current time once someone has played or scrubbed it. */
function usePlayhead(): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => {
      const v = findReviewVideo();
      setAt(v && v.currentTime > 0 ? Math.round(v.currentTime * 10) / 10 : null);
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, []);
  return at;
}

/**
 * Under the comment box: "Pin to 0:12" once the video has been played,
 * which pauses it there and stamps the note; the stamped chip's × drops it.
 */
export function TimecodePin({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (at: number | null) => void;
  disabled?: boolean;
}) {
  const live = usePlayhead();
  if (value !== null) {
    return (
      <span
        data-testid="comment-timecode-pinned"
        className="inline-flex items-center gap-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 text-xs font-medium tabular-nums"
      >
        <MapPinIcon className="size-3" />
        at {formatTimecode(value)}
        <button
          type="button"
          aria-label="Remove the time from this note"
          onClick={() => onChange(null)}
          disabled={disabled}
          className="ml-0.5 rounded-full hover:bg-indigo-100 p-0.5"
        >
          <XIcon className="size-3" />
        </button>
      </span>
    );
  }
  if (live === null) return null;
  return (
    <button
      type="button"
      data-testid="comment-timecode-pin"
      disabled={disabled}
      onClick={() => {
        const v = findReviewVideo();
        const at = v ? Math.round(v.currentTime * 10) / 10 : live;
        v?.pause();
        onChange(at);
      }}
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40 tabular-nums"
      title="Pause the video here and pin this note to the moment"
    >
      <MapPinIcon className="size-3" />
      Pin to {formatTimecode(live)}
    </button>
  );
}

/** On a posted note: the time, and a click jumps the player there. */
export function TimecodeChip({
  atSeconds,
  brand,
}: {
  atSeconds: number;
  brand: string;
}) {
  const [missing, setMissing] = useState(false);
  return (
    <button
      type="button"
      data-testid="comment-timecode-chip"
      onClick={() => {
        const v = findReviewVideo();
        if (!v) {
          setMissing(true);
          return;
        }
        v.currentTime = atSeconds;
        v.scrollIntoView({ block: "nearest", behavior: "smooth" });
        void v.play().catch(() => {});
        trackUsage("comments:seek", brand);
      }}
      title={missing ? "No video on this page to jump in" : "Play from here"}
      className="inline-flex items-center gap-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 text-xs font-medium tabular-nums hover:bg-indigo-100 mr-1.5 align-middle"
    >
      <PlayIcon className="size-3 fill-current" />
      {formatTimecode(atSeconds)}
    </button>
  );
}
