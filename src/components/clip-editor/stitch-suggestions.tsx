"use client";

/**
 * "Lines to stitch in" (clip stitching M2): the section picker's suggested
 * lines from elsewhere in the source, each one click to add. Adding goes
 * through `apply`, so it is one undo step like any edit; "Added" follows the
 * doc, so undoing or cutting the scene brings the button back.
 */
import { useEffect, useState } from "react";
import { CheckIcon, PlusIcon } from "lucide-react";
import type { SupportingMoment } from "@/lib/clip-stitch";
import type { ClipEditDoc } from "@/lib/clip-editor/doc";
import { momentInClip, stitchInMoment } from "@/lib/clip-editor/stitch";
import { trackUsage } from "@/lib/usage/track";

const ROLE_LABEL: Record<SupportingMoment["role"], string> = {
  setup: "Setup",
  detail: "Detail",
  payoff: "Payoff",
};
const ROLE_HINT: Record<SupportingMoment["role"], string> = {
  setup: "plays before the clip",
  detail: "plays in recording order",
  payoff: "plays at the end",
};

function fmt(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const POLL_MS = 4_000;
const POLL_FOR_MS = 120_000;

/** M3: a pre-v2 section has none yet — ask the worker once (POST), poll
 *  until they land. Nothing shows while it looks. */
export function useStitchMoments(args: {
  clipIdeaId: string;
  initial: SupportingMoment[];
  pending: boolean;
}): SupportingMoment[] {
  const { clipIdeaId, initial, pending } = args;
  const [moments, setMoments] = useState<SupportingMoment[]>(initial);
  useEffect(() => {
    setMoments(initial);
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const url = `/api/clip-ideas/${clipIdeaId}/editor/stitch`;
    const check = async (method: "POST" | "GET") => {
      try {
        const res = await fetch(url, { method });
        if (!res.ok || stopped) return;
        const body = (await res.json()) as { pending?: boolean; moments?: SupportingMoment[] };
        if (stopped) return;
        if (!body.pending) {
          setMoments(body.moments ?? []);
          return;
        }
      } catch {} // network blip: keep polling
      if (!stopped && Date.now() - startedAt < POLL_FOR_MS) {
        timer = setTimeout(() => void check("GET"), POLL_MS);
      }
    };
    void check("POST");
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // `initial` is the session's array; re-run only when the idea changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipIdeaId, pending]);
  return moments;
}

export function StitchSuggestions({
  moments,
  doc,
  apply,
  locked,
  brand,
}: {
  moments: SupportingMoment[];
  doc: ClipEditDoc;
  apply: (fn: (d: ClipEditDoc) => ClipEditDoc) => void;
  locked: boolean;
  brand: string;
}) {
  if (moments.length === 0) return null;
  return (
    <div data-testid="stitch-suggestions" className="mb-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">Lines to stitch in</p>
      <ul className="space-y-1">
        {moments.map((m) => {
          const added = momentInClip(doc, m);
          return (
            <li key={`${m.startSec}-${m.endSec}`} className="flex min-w-0 items-center gap-2 text-[11px]">
              <span className="shrink-0 rounded bg-background px-1.5 py-0.5 font-semibold text-muted-foreground ring-1 ring-border">
                {ROLE_LABEL[m.role]}
              </span>
              <span className="min-w-0 flex-1 truncate" title={`${m.why} (${fmt(m.startSec)}, ${ROLE_HINT[m.role]})`}>
                “{m.quote}”
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{fmt(m.startSec)}</span>
              {added ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckIcon className="size-3" /> Added
                </span>
              ) : (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    apply((d) => stitchInMoment(d, m));
                    trackUsage(`clip-editor:stitch-add:${m.role}`, brand);
                  }}
                  className="inline-flex shrink-0 items-center gap-0.5 font-medium text-foreground underline underline-offset-2 hover:text-primary disabled:opacity-50"
                >
                  <PlusIcon className="size-3" /> Add
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
