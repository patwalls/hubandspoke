"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon, XIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { trackUsage } from "@/lib/usage/track";

interface UpNextData {
  next: { id: string; title: string | null; brand: string; status: string | null } | null;
  remaining: number;
  /** Is the post you're on still waiting on you? */
  currentWaiting: boolean;
}

/**
 * "Up next: <title> →" on the content page: the next post waiting on you
 * (rules in `upNext`, src/lib/my-work/split.ts), so people who work one item
 * page at a time go straight to the next one instead of back to a list.
 * Refetched when this post's status or editor changes; hidden when nothing
 * else is waiting.
 *
 * The moment this post leaves your plate (you approved it, sent it to review,
 * handed it on), a card offers the next one: reviewers kept going back to the
 * production list after every approval and never noticed the small link.
 */
export function UpNext({ itemId, status, editorUserId }: { itemId: string; status: string; editorUserId: string }) {
  const [data, setData] = useState<UpNextData | null>(null);
  // The post you just sent on (keyed, so the card never follows you to the next page).
  const [sentOnId, setSentOnId] = useState<string | null>(null);
  const sentOn = sentOnId === itemId;
  // Was this post waiting on you at the last fetch? Only a true → false flip
  // shows the card, so opening a post that was never yours shows nothing.
  const wasWaiting = useRef<{ itemId: string; waiting: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/my-work/next?current=${encodeURIComponent(itemId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: UpNextData | null) => {
        if (cancelled || !d) return;
        const before = wasWaiting.current;
        const flipped = before?.itemId === itemId && before.waiting && !d.currentWaiting;
        wasWaiting.current = { itemId, waiting: d.currentWaiting };
        setData(d);
        if (flipped) {
          setSentOnId(itemId);
          trackUsage("my-work:next-card", d.next?.brand);
        } else if (d.currentWaiting) {
          setSentOnId(null);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [itemId, status, editorUserId]);

  // Nothing else waiting: the card just says so, then gets out of the way.
  useEffect(() => {
    if (!sentOn || data?.next) return;
    const t = setTimeout(() => setSentOnId(null), 6000);
    return () => clearTimeout(t);
  }, [sentOn, data?.next]);

  return (
    <>
      <UpNextLink data={data} />
      {sentOn && data && <NextCard data={data} onClose={() => setSentOnId(null)} />}
    </>
  );
}

function NextCard({ data, onClose }: { data: UpNextData; onClose: () => void }) {
  const { next, remaining } = data;
  return (
    <div
      role="status"
      data-testid="up-next-card"
      className="fixed bottom-6 right-6 z-50 w-80 rounded-lg border bg-background p-3 shadow-lg"
    >
      <div className="flex items-start gap-2">
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1 text-sm">
          {next ? (
            <>
              <p className="text-muted-foreground">
                Sent on. Next waiting on you{remaining > 1 ? ` (${remaining} left)` : ""}:
              </p>
              <p className="mt-0.5 truncate font-medium">{next.title || "Untitled"}</p>
            </>
          ) : (
            <p className="font-medium">Sent on. That&apos;s everything waiting on you.</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {next && (
        <div className="mt-2 flex justify-end">
          <Link
            href={`/${next.brand}/content/${next.id}`}
            onClick={() => trackUsage("my-work:next-card:open", next.brand)}
            className={buttonVariants({ size: "sm" })}
          >
            Open next <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}

function UpNextLink({ data }: { data: UpNextData | null }) {
  if (!data?.next) return null;
  const { next, remaining } = data;
  return (
    <Link
      href={`/${next.brand}/content/${next.id}`}
      onClick={() => trackUsage("my-work:up-next", next.brand)}
      data-testid="up-next"
      title={`${remaining} waiting on you besides this one`}
      className="inline-flex h-7 max-w-[22rem] items-center gap-1 rounded-md border-l border-border pl-3 pr-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
    >
      <span className="shrink-0">Up next{remaining > 1 ? ` (${remaining})` : ""}:</span>
      <span className="truncate font-medium text-foreground">{next.title || "Untitled"}</span>
      <ArrowRightIcon className="size-3 shrink-0" />
    </Link>
  );
}
