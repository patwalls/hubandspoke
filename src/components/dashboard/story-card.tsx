"use client";

// The story a roundup section covers, as a card in the editor's side panel:
// thumbnail, kind, title (links out), when it was published and how often
// this newsletter ran it. "Find new story" opens a type-ahead picker: with
// nothing typed it shows recommendations (recent, unused stories); typing
// searches the brand's videos and case studies. Picking one rewrites the
// section around that story; "Let AI pick" keeps the old behavior.

import { useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, Loader2, Search, Shuffle, Sparkles, Video, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NewsletterSection } from "@/lib/newsletter-template";

export interface StoryPick {
  kind: "video" | "case_study";
  key: string;
  title: string | null;
  url: string | null;
  productionItemId: string | null;
}

interface StoryOption extends StoryPick {
  thumbnailUrl: string | null;
  publishedAt: string | null;
  subtitle: string | null;
  timesRun: number;
  lastRun: string | null;
  blocked: boolean;
  inIssue: boolean;
}

/** A YouTube URL's thumbnail. */
function youtubeThumb(url: string | null | undefined): string | null {
  const m = url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([\w-]{11})/);
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : null;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function Thumb({ kind, src, title, className }: { kind: "video" | "case_study"; src: string | null; title: string | null; className?: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className={cn("aspect-video rounded-md bg-muted object-cover", className)} />;
  }
  return (
    <span className={cn("flex aspect-video items-center justify-center rounded-md bg-gradient-to-br from-[#eef2ff] to-[#fdf2f8] text-[#6366f1]", className)} title={title ?? undefined}>
      {kind === "video" ? <Video className="size-5" /> : <FileText className="size-5" />}
    </span>
  );
}

function usageLabel(o: { timesRun: number; lastRun: string | null; blocked: boolean; inIssue?: boolean }): { text: string; tone: "good" | "muted" | "bad" } {
  if (o.inIssue) return { text: "In this issue", tone: "muted" };
  if (o.blocked) return { text: `Ran ${fmt(o.lastRun)} — too recent`, tone: "bad" };
  if (!o.timesRun) return { text: "Never featured", tone: "good" };
  return { text: `${o.timesRun}× before${o.lastRun ? `, last ${fmt(o.lastRun)}` : ""}`, tone: "muted" };
}

export function StoryCard({
  draftId,
  source,
  usage,
  canSwap,
  busy,
  onPick,
  onAuto,
}: {
  draftId: string;
  source: NewsletterSection["source"] | null | undefined;
  usage?: { count: number; lastDate: string | null; label: string; published?: string | null } | null;
  /** Roundups only: the section can change story. */
  canSwap: boolean;
  busy: boolean;
  onPick: (story: StoryPick) => void;
  /** Let the drafter find one (the old Find new story). */
  onAuto: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ q: string; list: StoryOption[] } | null>(null);
  const reqId = useRef(0);
  useEffect(() => {
    if (!open) return;
    const id = ++reqId.current;
    const t = setTimeout(
      () => {
        void fetch(`/api/newsletter-drafts/${draftId}/stories${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`)
          .then((r) => (r.ok ? r.json() : { stories: [] }))
          .then((j: { stories: StoryOption[] }) => id === reqId.current && setResults({ q: q.trim(), list: j.stories }));
      },
      q.trim() ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [open, q, draftId]);
  const loading = open && results?.q !== q.trim();

  const thumb = source?.kind === "video" ? youtubeThumb(source.url) : null;
  return (
    <div className="flex flex-col gap-2">
      {source ? (
        <div className="overflow-hidden rounded-lg border bg-background">
          <a href={source.url ?? undefined} target="_blank" rel="noreferrer" className="group flex gap-3 p-2.5 hover:bg-muted/40">
            <Thumb kind={source.kind} src={thumb} title={source.title} className="w-28 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {source.kind === "video" ? <Video className="size-3" /> : <FileText className="size-3" />}
                {source.kind === "video" ? "Video" : "Case study"}
                {(usage?.published || source.publishedAt) && <span className="font-normal normal-case tracking-normal">· {usage?.published ?? fmt(source.publishedAt)}</span>}
              </span>
              <span className="line-clamp-2 text-sm font-medium leading-snug group-hover:underline">{source.title ?? source.url ?? source.key}</span>
              <span className={cn("text-[11px]", !usage || usage.count === 0 ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                {usage?.label ?? "Never featured"} <ExternalLink className="ml-0.5 inline size-3 opacity-60" />
              </span>
            </span>
          </a>
          {canSwap && !open && (
            <button type="button" onClick={() => setOpen(true)} disabled={busy} className="flex w-full items-center justify-center gap-1.5 border-t py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-50">
              <Shuffle className="size-3.5" /> Find new story
            </button>
          )}
        </div>
      ) : (
        canSwap &&
        !open && (
          <button type="button" onClick={() => setOpen(true)} disabled={busy} className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-xs font-medium text-muted-foreground hover:bg-muted/40 disabled:opacity-50">
            <Search className="size-3.5" /> Pick a story for this section
          </button>
        )
      )}

      {open && (
        <div className="flex flex-col gap-1.5 rounded-lg border bg-background p-2 shadow-sm">
          <div className="flex items-center gap-1.5 rounded-md border px-2 focus-within:border-primary">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
                // Esc closes the picker, not the whole editor.
                if (e.key !== "Escape") return;
                e.stopPropagation();
                e.preventDefault();
                setOpen(false);
              }} placeholder="Search videos and case studies…" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none" />
            {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onAuto();
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
          >
            <Sparkles className="size-3.5 text-pink-500" /> Let AI pick a fresh one
          </button>
          <span className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{q.trim() ? "Results" : "Recommended"}</span>
          <div className="flex max-h-80 flex-col overflow-y-auto">
            {results && results.list.length === 0 && !loading && <span className="px-2 py-3 text-center text-xs text-muted-foreground">{q.trim() ? "Nothing matches." : "No fresh stories in the last few weeks — search for one."}</span>}
            {results?.list.map((o) => {
              const u = usageLabel(o);
              return (
                <button
                  key={o.key}
                  type="button"
                  disabled={o.inIssue}
                  onClick={() => {
                    setOpen(false);
                    onPick({ kind: o.kind, key: o.key, title: o.title, url: o.url, productionItemId: o.productionItemId });
                  }}
                  className="flex gap-2.5 rounded-md p-1.5 text-left hover:bg-muted disabled:opacity-50"
                >
                  <Thumb kind={o.kind} src={o.thumbnailUrl} title={o.title} className="w-20 shrink-0" />
                  <span className="flex min-w-0 flex-col">
                    <span className="line-clamp-2 text-xs font-medium leading-snug">{o.title ?? o.url}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {o.kind === "video" ? "Video" : (o.subtitle ?? "Case study")}
                      {o.publishedAt ? ` · ${fmt(o.publishedAt)}` : ""}
                    </span>
                    <span className={cn("text-[11px]", u.tone === "good" ? "text-emerald-700 dark:text-emerald-300" : u.tone === "bad" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{u.text}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
