"use client";

import { useEffect, useState } from "react";
import { PropertyRow } from "@/components/dashboard/property-row";

interface Route {
  editor: "clip" | "design" | "classic";
  because: string;
}

/**
 * Read-only "Opens in" row on the format page: which editor this format's
 * posts on X open in, and why. Nothing to set — it follows the Skill and the
 * format's history (src/lib/clip-editor/clip-post-route.ts). Hidden for
 * formats with no X channel. `refreshKey` bumps after the Skill or the
 * accounts are saved, so the row re-reads.
 */
export function ClipPostRouteRow({ formatId, refreshKey }: { formatId: string; refreshKey: number }) {
  const [state, setState] = useState<{ key: string; route: Route | null } | null>(null);
  const key = `${formatId}:${refreshKey}`;
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/clip-editor/post-route?formatId=${encodeURIComponent(formatId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { route?: Route | null } | null) => {
        if (!cancelled) setState({ key, route: j?.route ?? null });
      })
      .catch(() => {
        if (!cancelled) setState({ key, route: null });
      });
    return () => {
      cancelled = true;
    };
  }, [formatId, key]);

  // Keep showing the last answer while a refresh is in flight.
  const route = state?.route;
  if (!route) return null;
  return (
    <PropertyRow
      label="Opens in"
      tooltip="Which editor this format's posts on X open in from the queue. Nothing to set: it opens in the clip editor when the Skill says to cut a clip from the video, or when most of its posts on X carried a video. A Skill that posts the whole video stays in the classic view, and a format with a design template always opens the design editor. Unrelated to Clippable format."
    >
      <div className="py-1.5 text-sm" data-testid="clip-post-route" data-editor={route.editor}>
        <span className="font-medium">{route.editor === "clip" ? "Clip editor" : route.editor === "design" ? "Design editor" : "Classic view"}</span>
        <span className="text-muted-foreground"> · {route.because}</span>
      </div>
    </PropertyRow>
  );
}
