"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, InboxIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { waitingSummary } from "@/lib/my-work/split";
import { trackUsage } from "@/lib/usage/track";
import { cn } from "@/lib/utils";
import { PostTypeTag } from "./up-next";

interface WaitingData {
  next: { id: string; title: string | null; brand: string; status: string | null; postType?: string | null } | null;
  toReview: number;
  yourTurn: number;
}

/**
 * "Waiting on you: 2 to review · 3 your turn — Up next: <title> [Open]" at
 * the top of the brand dashboard, the screen most people open first. Same
 * queue and order as the content page's Up next (`upNext`, no current post).
 * Hidden when nothing is waiting, so people who come for the numbers see
 * only the numbers. Fetched once per page load, never on a timer.
 */
export function HomeWaiting({ brand }: { brand: string }) {
  const [data, setData] = useState<WaitingData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/my-work/next")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: WaitingData | null) => {
        if (cancelled || !d?.next) return;
        setData(d);
        trackUsage("home:waiting", brand);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [brand]);

  if (!data?.next) return null;
  const { next } = data;
  return (
    <div
      data-testid="home-waiting"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-4 py-2.5 text-sm"
    >
      <span className="inline-flex shrink-0 items-center gap-2 font-medium">
        <InboxIcon className="size-4 text-primary" />
        Waiting on you
        <span className="font-normal text-muted-foreground">{waitingSummary(data)}</span>
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span className="shrink-0 text-muted-foreground">Up next:</span>
        <PostTypeTag postType={next.postType} />
        <span className="truncate font-medium">{next.title || "Untitled"}</span>
        {next.status && <span className="shrink-0 text-xs text-muted-foreground">({next.status})</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Link
          href="/my-work"
          onClick={() => trackUsage("home:waiting:all", brand)}
          className={buttonVariants({ size: "sm", variant: "ghost" })}
        >
          See all
        </Link>
        <Link
          href={`/${next.brand}/content/${next.id}`}
          onClick={() => trackUsage("home:waiting:open", brand)}
          className={cn(buttonVariants({ size: "sm" }), "gap-1")}
        >
          Open <ArrowRightIcon className="size-3.5" />
        </Link>
      </span>
    </div>
  );
}
