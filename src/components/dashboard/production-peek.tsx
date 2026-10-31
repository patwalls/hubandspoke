"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostTypeTag } from "@/components/my-work/up-next";
import { cn } from "@/lib/utils";
import { statusClass } from "@/lib/badge-colors";
import { trackUsage } from "@/lib/usage/track";
import { waitingFor } from "@/lib/my-work/waiting";
import { isTypingTarget, readRun, stepFocus } from "@/lib/production/run";
import type { PeekField } from "@/lib/production/peek";

interface PeekData {
  id: string;
  title: string | null;
  status: string | null;
  postType: string | null;
  format: string | null;
  editor: string | null;
  hook: string | null;
  posterUrl: string | null;
  mediaUrl: string | null;
  draft: PeekField[];
  comments: { author: string; text: string; at: string }[];
  statusSince: { at: string; by: string | null } | null;
}

const ROW = "[data-production-row]";

function rowEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(ROW));
}

/** Open the row the way a click on its title does (so the run is remembered). */
export function openRow(id: string): void {
  document.querySelector<HTMLAnchorElement>(`[data-production-row="${CSS.escape(id)}"] a[data-row-open]`)?.click();
}

/**
 * Keyboard and peek for the In Production list (production-run M2 + M4).
 *
 * j / k (or ↓ / ↑) move a cursor over every row on screen, across status
 * groups; Enter or o opens it; Space (or the row's eye button) peeks it in a
 * side panel without leaving the list, and j / k then step the peek too; Esc
 * closes the peek. Back from a post opened off this list, the cursor starts
 * on that post's row, so the next one is a keypress away.
 *
 * `peekId` is lifted to ProductionView so the rows' eye buttons can open it.
 */
export function ProductionListKeys({
  brand,
  ready,
  focusedId,
  onFocus,
  peekId,
  onPeek,
}: {
  brand: string;
  /** The list has rendered its rows (not loading). */
  ready: boolean;
  /** The keyboard cursor, held by ProductionView so it survives the status
   *  sections re-rendering (they remount when the brand's statuses load). */
  focusedId: string | null;
  onFocus: (id: string | null) => void;
  peekId: string | null;
  onPeek: (id: string | null) => void;
}) {
  const tracked = useRef(false);

  // Back from the content page: land on the post you had open.
  useEffect(() => {
    if (!ready) return;
    const current = readRun(brand)?.current;
    // Not on the list any more (filtered out, moved on)? The next key starts from the top.
    if (current) onFocus(current);
  }, [ready, brand, onFocus]);

  // Keep the cursor's row on screen.
  useEffect(() => {
    if (!focusedId) return;
    document
      .querySelector<HTMLElement>(`[data-production-row="${CSS.escape(focusedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
    // (Re-run when the list first renders, so a restored cursor scrolls too.)
  }, [focusedId, ready]);

  // A peek opened with the mouse moves the cursor to that row.
  useEffect(() => {
    if (peekId) onFocus(peekId);
  }, [peekId, onFocus]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      // Popovers / select menus own the keyboard.
      if (document.querySelector('[role="dialog"], [role="listbox"], [role="menu"]')) return;
      // The DOM is the source of truth for on-screen order (filters, sort and
      // group order already applied by the tables). A filter change can drop
      // the focused row; then the next key starts from the top.
      const list = rowEls();
      const at = focusedId ? list.findIndex((r) => r.getAttribute("data-production-row") === focusedId) : -1;

      const step = stepFocus(at, e.key, list.length);
      if (step != null) {
        e.preventDefault();
        const id = list[step].getAttribute("data-production-row");
        onFocus(id);
        if (!tracked.current) {
          tracked.current = true;
          trackUsage("production:keys", brand);
        }
        if (peekId && id) onPeek(id);
        return;
      }
      const id = at >= 0 ? list[at].getAttribute("data-production-row") : null;
      if (e.key === "Escape" && peekId) {
        e.preventDefault();
        onPeek(null);
        return;
      }
      if (!id) return;
      if (e.key === "Enter" || e.key === "o") {
        e.preventDefault();
        openRow(id);
        return;
      }
      if (e.key === " " || e.key === "p") {
        e.preventDefault();
        if (peekId === id) {
          onPeek(null);
        } else {
          trackUsage("production:peek", brand);
          onPeek(id);
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [brand, focusedId, onFocus, peekId, onPeek]);

  return (
    <p className="hidden text-[11px] text-muted-foreground sm:block" data-testid="production-keys-hint">
      Keys: <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> move ·{" "}
      <kbd className="font-mono">Space</kbd> peek · <kbd className="font-mono">Enter</kbd> open
    </p>
  );
}

/**
 * The peek panel: a post's cover / video, hook, draft, last comments and how
 * long it has sat in its status, beside the list. Not a modal, so the list
 * keys keep working under it.
 */
export function ProductionPeek({ id, brand, onClose }: { id: string; brand: string; onClose: () => void }) {
  const [data, setData] = useState<PeekData | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const failed = failedId === id;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/production-items/${encodeURIComponent(id)}/peek`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: PeekData) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailedId(id);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Keep the previous post on screen until the next one arrives (j held down
  // shouldn't flash an empty panel), but never show it as this one.
  const shown = data;
  const stale = !!data && data.id !== id;
  const since = waitingFor(shown?.statusSince?.at);

  return (
    <aside
      aria-label="Peek"
      data-testid="production-peek"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-background shadow-xl"
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        {shown?.status && (
          <span className={cn("rounded border px-1.5 py-0.5 text-[11px] font-medium", statusClass(shown.status))}>
            {shown.status}
          </span>
        )}
        {since && (
          <span className="text-xs text-muted-foreground" title={new Date(shown!.statusSince!.at).toLocaleString()}>
            {since.label}
            {shown?.statusSince?.by ? ` · moved by ${shown.statusSince.by.split(/\s+/)[0]}` : ""}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close peek"
          title="Close (Esc)"
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      <div className={cn("flex-1 space-y-4 overflow-y-auto px-4 py-4 transition-opacity", stale && "opacity-50")}>
        {!shown && !failed && <p className="text-sm text-muted-foreground">Loading…</p>}
        {failed && !shown && <p className="text-sm text-muted-foreground">Couldn&apos;t load this post.</p>}
        {shown && (
          <>
            <div className="space-y-1">
              <h2 className="text-base font-semibold leading-snug" data-testid="production-peek-title">
                {shown.title || "(Untitled)"}
              </h2>
              <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <PostTypeTag postType={shown.postType} />
                {shown.format && <span>{shown.format}</span>}
                {shown.editor && <span>· {shown.editor}</span>}
              </p>
            </div>

            {shown.mediaUrl ? (
              <video
                key={shown.mediaUrl}
                src={shown.mediaUrl}
                poster={shown.posterUrl ?? undefined}
                controls
                muted
                playsInline
                preload="metadata"
                className="max-h-80 w-full rounded-md bg-black object-contain"
              />
            ) : shown.posterUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shown.posterUrl} alt="" className="max-h-80 w-full rounded-md bg-muted object-contain" />
            ) : null}

            {shown.hook && (
              <PeekSection label="Hook">
                <p className="text-sm">{shown.hook}</p>
              </PeekSection>
            )}

            {shown.draft.map((f) => (
              <PeekSection key={f.label} label={f.label}>
                <p className="whitespace-pre-wrap text-sm">{f.text}</p>
              </PeekSection>
            ))}

            {!shown.hook && shown.draft.length === 0 && !shown.mediaUrl && !shown.posterUrl && (
              <p className="text-sm text-muted-foreground">Nothing written or uploaded yet.</p>
            )}

            {shown.comments.length > 0 && (
              <PeekSection label="Latest comments">
                <ul className="space-y-2">
                  {shown.comments.map((c, i) => (
                    <li key={i} className="text-sm">
                      <span className="font-medium">{c.author.split(/\s+/)[0]}</span>{" "}
                      <span className="text-xs text-muted-foreground">{waitingFor(c.at)?.label} ago</span>
                      <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{c.text}</p>
                    </li>
                  ))}
                </ul>
              </PeekSection>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 border-t px-4 py-3">
        <span className="text-[11px] text-muted-foreground">
          <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> next post
        </span>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => {
            trackUsage("production:peek:open", brand);
            openRow(id);
          }}
        >
          Open post <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </aside>
  );
}

function PeekSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}
