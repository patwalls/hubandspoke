"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { formatLift, measure } from "@/lib/winners/pick";
import { trackUsage } from "@/lib/usage/track";

interface WinnerJson {
  item: {
    id: string;
    title: string | null;
    views: number;
    baselineMedian: number;
    metric?: "views" | "likes";
    likes?: number;
    baselineLikesMedian?: number;
    format: string | null;
    platform: string | null;
    accountHandle: string | null;
    thumbnail: string | null;
    publishedAt: string;
  };
  lift: number;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/**
 * "Beat their usual" — the last 7 days' posts that did best against their own
 * account's normal (see `src/lib/winners/pick.ts`). Sits under the goal tiles
 * on the brand dashboard; each row opens the post's content page.
 */
export function WinnersStrip({ brand }: { brand: string }) {
  const [winners, setWinners] = useState<WinnerJson[] | null>(null);
  const tracked = useRef(false);

  useEffect(() => {
    if (brand === "all") return;
    let cancelled = false;
    fetch(`/api/reports/winners?brand=${encodeURIComponent(brand)}`)
      .then((r) => (r.ok ? r.json() : { winners: [] }))
      .then((j: { winners?: WinnerJson[] }) => {
        if (!cancelled) setWinners(j.winners ?? []);
      })
      .catch(() => {
        if (!cancelled) setWinners([]);
      });
    return () => {
      cancelled = true;
    };
  }, [brand]);

  useEffect(() => {
    if (winners && winners.length > 0 && !tracked.current) {
      tracked.current = true;
      trackUsage("home:winners", brand);
    }
  }, [winners, brand]);

  if (brand === "all" || winners === null) return null;

  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      aria-labelledby="winners-heading"
      data-testid="winners-strip"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="winners-heading" className="text-sm font-semibold">
          Beat their usual this week
        </h2>
        <p className="text-xs text-muted-foreground">
          Views (likes where the platform hides views) vs. the same account&apos;s median for that
          post type, last 90 days
        </p>
      </div>
      {winners.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No post from the last 7 days has beaten its account&apos;s usual by 1.5× yet.
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {winners.map((w) => {
            const m = measure({ ...w.item, baselinePosts: 0 });
            const unit = w.item.metric === "likes" ? "likes" : "views";
            return (
              <li key={w.item.id}>
                <Link
                  href={`/${brand}/content/${w.item.id}`}
                  onClick={() => trackUsage("home:winners:open", brand)}
                  className="flex items-center gap-3 py-2 text-sm hover:bg-muted/40 -mx-2 px-2 rounded-md"
                >
                  <span className="w-14 shrink-0 text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatLift(w.lift)}
                  </span>
                  {w.item.platform && <PlatformIcon platform={w.item.platform} size={14} />}
                  <span className="min-w-0 flex-1 truncate">{w.item.title || "Untitled"}</span>
                  {w.item.format && (
                    <span className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground sm:inline">
                      {w.item.format}
                    </span>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {compact.format(m.value)} {unit}
                    <span className="hidden md:inline"> · usual {compact.format(m.usual)}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
