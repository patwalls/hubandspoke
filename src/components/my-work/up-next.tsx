"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { trackUsage } from "@/lib/usage/track";

interface UpNextData {
  next: { id: string; title: string | null; brand: string; status: string | null } | null;
  remaining: number;
}

/**
 * "Up next: <title> →" on the content page: the next post waiting on you
 * (rules in `upNext`, src/lib/my-work/split.ts), so people who work one item
 * page at a time go straight to the next one instead of back to a list.
 * Refetched when this post's status or editor changes; hidden when nothing
 * else is waiting.
 */
export function UpNext({ itemId, status, editorUserId }: { itemId: string; status: string; editorUserId: string }) {
  const [data, setData] = useState<UpNextData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/my-work/next?current=${encodeURIComponent(itemId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: UpNextData | null) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [itemId, status, editorUserId]);

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
