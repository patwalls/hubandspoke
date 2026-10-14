"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { estimatedProgress } from "@/lib/estimated-progress";

const TICK_MS = 250;

/**
 * A thin bar for a wait with no real progress signal. Time-based: it fills
 * toward ~85% at `expectedMs` and never completes on its own — unmount it
 * when the work finishes. Set `expectedMs` to the typical duration and bump
 * it when the work behind the wait grows.
 */
export function EstimatedProgressBar({ expectedMs, className }: { expectedMs: number; className?: string }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const start = performance.now();
    const id = window.setInterval(() => {
      setProgress(estimatedProgress(performance.now() - start, expectedMs));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [expectedMs]);

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className="h-full rounded-full bg-pink-500 transition-[width] duration-300 ease-linear"
        style={{ width: `${progress * 100}%` }}
      />
    </div>
  );
}
