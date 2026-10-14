"use client";

/**
 * The cover-style gallery: every published Instagram slideshow cover of
 * the brand, this post's format first, best first. Click one and the
 * editor rebuilds page 1 in that cover's layout (see
 * services/design-editor/cover-styles.ts — the layout is read once and
 * cached; applying it is only the text fill for this post). The panel
 * stays open so styles can be tried one after another; ⌘Z undoes each.
 */
import { useEffect, useState } from "react";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CoverStyleCard, CoverStyleGallery, CoverStyleState } from "@/lib/services/design-editor/cover-styles";

export function formatViews(n: number | null): string {
  if (n === null || n === undefined) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function CoverStylesPanel({ brand, format, busyId, onPick, onClose }: {
  brand: string;
  /** The post's format — its covers lead the gallery. */
  format: string | null;
  /** The card being applied right now (clicks are ignored meanwhile). */
  busyId: string | null;
  /** Apply a style; resolves with the style's final state (to update the card) or null. */
  onPick: (card: CoverStyleCard) => Promise<CoverStyleState | null>;
  onClose: () => void;
}) {
  const [gallery, setGallery] = useState<CoverStyleGallery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chip, setChip] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/design/styles?brand=${encodeURIComponent(brand)}${format ? `&format=${encodeURIComponent(format)}` : ""}`).catch(() => null);
      if (cancelled) return;
      const json = (await res?.json().catch(() => null)) as (CoverStyleGallery & { error?: string }) | null;
      if (!res?.ok || !json?.styles) return setError(json?.error ?? `Couldn't load the covers (${res?.status ?? "no response"})`);
      setGallery(json);
      setChip(json.formats[0] ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [brand, format]);

  const pick = async (card: CoverStyleCard) => {
    if (busyId) return;
    const state = await onPick(card);
    if (state) setGallery((g) => g && { ...g, styles: g.styles.map((s) => (s.productionItemId === card.productionItemId ? { ...s, styleId: state.id, status: state.status, summary: state.summary, error: state.error } : s)) });
  };

  const shown = gallery?.styles.filter((s) => (s.format ?? "Other") === chip) ?? [];
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-2 border-b border-border p-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Cover styles</h3>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">Covers of posts we&apos;ve already published, best first. Click one to rebuild this cover in its layout — your headline and photo, their design. ⌘Z brings the old cover back.</p>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close cover styles"><XIcon className="size-3.5" /></button>
      </div>
      {gallery && gallery.formats.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
          {gallery.formats.map((f, i) => (
            <button key={f} type="button" onClick={() => setChip(f)} className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", chip === f ? "border-pink-300 bg-pink-50 text-pink-800 dark:bg-pink-950/40 dark:text-pink-200" : "border-border text-muted-foreground hover:bg-muted")} title={i === 0 && f === format ? "This post's format" : undefined}>
              {f}{i === 0 && f === format ? " · this format" : ""}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!gallery && !error && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2Icon className="size-3.5 animate-spin" /> Loading published covers…</p>}
        {gallery && shown.length === 0 && <p className="text-xs text-muted-foreground">No published covers for this format yet.</p>}
        <div className="grid grid-cols-2 gap-2">
          {shown.map((card) => {
            const applying = busyId === card.productionItemId;
            return (
              <button
                key={card.productionItemId}
                type="button"
                onClick={() => void pick(card)}
                disabled={!!busyId}
                data-status={card.status}
                title={[card.hook, card.summary, card.status === "failed" ? `Couldn't read it: ${card.error ?? "unknown error"}` : null].filter(Boolean).join("\n")}
                className={cn("group relative aspect-square overflow-hidden rounded-md border border-border bg-muted text-left ring-pink-500 transition hover:ring-2 disabled:cursor-default", applying && "ring-2")}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URL */}
                <img src={card.thumbnailUrl} alt={card.hook ?? "Published cover"} loading="lazy" className="size-full object-cover" />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-[10px] font-medium text-white">
                  <span>{formatViews(card.views)}{card.views !== null ? " views" : ""}</span>
                  {applying ? (
                    <Loader2Icon className="size-3 animate-spin" />
                  ) : card.status === "done" ? (
                    <span className="inline-flex items-center gap-0.5 text-emerald-300" title="Layout already read — applies in one step"><CheckIcon className="size-3" /> Ready</span>
                  ) : card.status === "pending" ? (
                    <Loader2Icon className="size-3 animate-spin text-white/70" />
                  ) : card.status === "failed" ? (
                    <span className="text-rose-300">Retry</span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
