"use client";

// The New menu's pillar picker (newsletter + post dialogs): a dropdown whose
// rows show what you need to choose — the YouTube thumbnail, title, date,
// channel, views (leads when there are any) and a 🔥 when the video is at
// least twice its channel's typical views (`withPillarHeat`) — and, under it,
// the picked video embedded so you can scrub through it before writing an
// angle. Picking another video swaps the embed.

import { useState } from "react";
import { ChevronDown, Flame } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { HOT_HEAT } from "@/lib/pillar-heat";

export interface PillarVideo {
  id: string;
  title: string | null;
  publishedAt: string | null;
  youtubeId?: string | null;
  channel?: string | null;
  views?: number | null;
  leads?: number | null;
  heat?: number | null;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Thumb({ youtubeId }: { youtubeId?: string | null }) {
  return youtubeId ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg`}
      alt=""
      loading="lazy"
      className="aspect-video w-24 shrink-0 rounded object-cover bg-muted"
    />
  ) : (
    <span className="aspect-video w-24 shrink-0 rounded bg-muted" />
  );
}

function Row({ v, note }: { v: PillarVideo; note?: string | null }) {
  const hot = v.heat != null && v.heat >= HOT_HEAT;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3 text-left">
      <Thumb youtubeId={v.youtubeId} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-sm font-medium leading-snug">{v.title ?? "Untitled"}</span>
        <span className="truncate text-xs text-muted-foreground">
          {fmtDate(v.publishedAt)}
          {v.channel && ` · @${v.channel}`}
        </span>
        {note && <span className="text-xs text-amber-600 dark:text-amber-400">{note}</span>}
      </span>
      <span className="flex w-16 shrink-0 flex-col items-end gap-0.5 text-xs tabular-nums">
        {v.views != null && (
          <span className="font-medium text-foreground">{compact.format(v.views)}</span>
        )}
        {v.views != null && <span className="text-muted-foreground">views</span>}
        {!!v.leads && <span className="text-muted-foreground">{compact.format(v.leads)} leads</span>}
        {hot && (
          <span
            className="inline-flex items-center gap-0.5 rounded bg-orange-500/10 px-1 font-medium text-orange-600 dark:text-orange-400"
            title={`${v.heat}× the channel's typical views`}
            data-testid="pillar-hot"
          >
            <Flame className="size-3" />
            {v.heat}×
          </span>
        )}
      </span>
    </span>
  );
}

export function PillarVideoPicker({
  videos,
  value,
  onChange,
  noteFor,
  placeholder = "Pick the pillar video…",
  emptyText,
  testId,
  previewTestId,
}: {
  videos: PillarVideo[];
  value: string;
  onChange: (id: string) => void;
  /** A note on the row ("no transcript yet"); `blocks` makes it unpickable. */
  noteFor?: (v: PillarVideo) => { text: string; blocks: boolean } | null;
  placeholder?: string;
  emptyText: string;
  testId: string;
  previewTestId: string;
}) {
  const [open, setOpen] = useState(false);
  const picked = videos.find((v) => v.id === value) ?? null;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          disabled={videos.length === 0}
          className="flex w-full items-center gap-2 rounded-lg border border-input bg-background p-1.5 pr-2.5 text-left shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
          data-testid={testId}
          data-value={value}
        >
          {picked ? (
            <Row v={picked} />
          ) : (
            <span className="flex h-6 flex-1 items-center px-1.5 text-sm text-muted-foreground">
              {videos.length === 0 ? emptyText : placeholder}
            </span>
          )}
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="max-h-[min(26rem,var(--available-height))] w-(--anchor-width) gap-0 overflow-y-auto p-1"
          role="listbox"
          data-testid={`${testId}-list`}
        >
          {videos.map((v) => {
            const note = noteFor?.(v) ?? null;
            return (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={v.id === value}
                disabled={note?.blocks}
                onClick={() => {
                  onChange(v.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center rounded-md p-1.5 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                  v.id === value && "bg-accent",
                )}
                data-testid="pillar-option"
                data-id={v.id}
              >
                <Row v={v} note={note?.text} />
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      {picked?.youtubeId && (
        <iframe
          key={picked.youtubeId}
          src={`https://www.youtube-nocookie.com/embed/${picked.youtubeId}?rel=0`}
          title={picked.title ?? "Pillar video"}
          allow="encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          className="aspect-video w-full shrink-0 rounded-lg border bg-muted"
          data-testid={previewTestId}
        />
      )}
    </>
  );
}
