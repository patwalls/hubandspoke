"use client";

import { useEffect } from "react";
import { trackUsage } from "@/lib/usage/track";
import {
  ACTIVITY_MARK,
  ACTIVITY_SEEN_MS,
  PREVIEW_PLAY_MARK,
  dwellMarksDue,
} from "@/lib/usage/post-read-marks";

const TICK_MS = 1_000;

/**
 * Records what someone reads on a post page (see post-read-marks.ts). Keyed
 * on the post id, so opening the next post starts fresh. Best-effort: no
 * IntersectionObserver / no Activity feed → those marks just don't fire.
 */
export function usePostReadMarks(itemId: string | null | undefined, brand: string) {
  useEffect(() => {
    if (!itemId || typeof window === "undefined") return;
    const fired = new Set<string>();
    const fire = (mark: string) => {
      if (fired.has(mark)) return;
      fired.add(mark);
      trackUsage(mark, brand);
    };

    // Dwell: count only time the tab is visible.
    let visibleMs = 0;
    const dwell = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      visibleMs += TICK_MS;
      for (const m of dwellMarksDue(visibleMs, fired)) fire(m);
      if (dwellMarksDue(Number.MAX_SAFE_INTEGER, fired).length === 0) window.clearInterval(dwell);
    }, TICK_MS);

    // Preview play: `play` doesn't bubble, so listen in the capture phase.
    const onPlay = (e: Event) => {
      const t = e.target as Element | null;
      if (t && typeof t.closest === "function" && t.closest("[data-review-player]")) fire(PREVIEW_PLAY_MARK);
    };
    document.addEventListener("play", onPlay, true);

    // Activity in view for a moment. The feed mounts after the post loads,
    // so look for it for a few seconds.
    let observer: IntersectionObserver | null = null;
    let seenTimer: number | undefined;
    let tries = 0;
    const findFeed = window.setInterval(() => {
      const el = document.querySelector("[data-post-activity]");
      if (!el && ++tries < 20) return;
      window.clearInterval(findFeed);
      if (!el || typeof IntersectionObserver === "undefined") return;
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry?.isIntersecting) {
            seenTimer ??= window.setTimeout(() => {
              fire(ACTIVITY_MARK);
              observer?.disconnect();
            }, ACTIVITY_SEEN_MS);
          } else if (seenTimer !== undefined) {
            window.clearTimeout(seenTimer);
            seenTimer = undefined;
          }
        },
        { threshold: 0.5 },
      );
      observer.observe(el);
    }, 250);

    return () => {
      window.clearInterval(dwell);
      window.clearInterval(findFeed);
      if (seenTimer !== undefined) window.clearTimeout(seenTimer);
      observer?.disconnect();
      document.removeEventListener("play", onPlay, true);
    };
  }, [itemId, brand]);
}
