"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { formatLift, measure } from "@/lib/winners/pick";
import { ChevronDown } from "lucide-react";
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
    winNote?: { note: string } | null;
  };
  lift: number;
}

interface FormatScoreJson {
  format: string;
  posts: number;
  wins: number;
  hitRate: number;
  bestLift: number | null;
}

const OPEN_KEY = "hs:winners-open";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/**
 * "Beat their usual" — the last 7 days' posts that did best against their own
 * account's normal (see `src/lib/winners/pick.ts`). One collapsed line under
 * the goal tiles on the brand dashboard (Pat, 2026-10-31: the open list read as
 * a junk drawer at the top of the page); expanding it — remembered per browser —
 * shows the posts, their "why" notes and the format scoreboard. Hidden entirely
 * when nothing beat its usual.
 */
export function WinnersStrip({ brand }: { brand: string }) {
  const [winners, setWinners] = useState<WinnerJson[] | null>(null);
  const [formats, setFormats] = useState<FormatScoreJson[]>([]);
  const tracked = useRef(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(localStorage.getItem(OPEN_KEY) === "1");
  }, []);

  const toggle = (next: boolean) => {
    setOpen(next);
    localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    if (next) trackUsage("home:winners:expand", brand);
  };

  useEffect(() => {
    if (brand === "all") return;
    let cancelled = false;
    fetch(`/api/reports/winners?brand=${encodeURIComponent(brand)}`)
      .then((r) => (r.ok ? r.json() : { winners: [] }))
      .then((j: { winners?: WinnerJson[]; formats?: FormatScoreJson[] }) => {
        if (cancelled) return;
        setWinners(j.winners ?? []);
        setFormats(j.formats ?? []);
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

  if (brand === "all" || winners === null || winners.length === 0) return null;

  const top = winners[0];
  const count = winners.length;

  return (
    <section
      className="rounded-lg border border-border bg-card"
      aria-labelledby="winners-heading"
      data-testid="winners-strip"
    >
      {/* Collapsed by default: one quiet line under the goal tiles. The list,
          the "why" notes and the format scoreboard are a click away — the
          dashboard's job is the week's numbers, not this. */}
      <button
        type="button"
        onClick={() => toggle(!open)}
        aria-expanded={open}
        aria-controls="winners-body"
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/40 rounded-lg"
      >
        <h2 id="winners-heading" className="shrink-0 font-medium">
          Beat their usual this week
        </h2>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {count} {count === 1 ? "post" : "posts"} · top{" "}
          <span className="tabular-nums text-emerald-600 dark:text-emerald-400">{formatLift(top.lift)}</span>{" "}
          {top.item.title || "Untitled"}
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <div id="winners-body" className="border-t border-border px-4 pb-3 pt-2">
          <p className="mb-1 text-xs text-muted-foreground">
            Views (likes where the platform hides views) against the same account&apos;s median for that post
            type over 90 days.
          </p>
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
                    <span className="w-12 shrink-0 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatLift(w.lift)}
                    </span>
                    {w.item.platform && <PlatformIcon platform={w.item.platform} size={14} />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{w.item.title || "Untitled"}</span>
                      {w.item.winNote?.note && (
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={w.item.winNote.note}
                          data-testid="win-note"
                        >
                          Why: {w.item.winNote.note}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {compact.format(m.value)} {unit}
                      <span className="hidden md:inline"> · usual {compact.format(m.usual)}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
          {formats.length > 0 && <FormatScoreboard brand={brand} formats={formats} />}
        </div>
      )}
    </section>
  );
}

/**
 * Format scoreboard (milestone 3): the formats whose posts beat their
 * account's usual most often over the last 4 weeks — "what to make more of".
 * Rules in `scoreFormats` (src/lib/winners/pick.ts).
 */
function FormatScoreboard({ brand, formats }: { brand: string; formats: FormatScoreJson[] }) {
  return (
    <div className="mt-4 border-t border-border pt-3" data-testid="format-scoreboard">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">Formats that keep beating their usual</h3>
        <p className="text-xs text-muted-foreground">Last 4 weeks · posts that beat 1.5×</p>
      </div>
      <ol className="space-y-1.5">
        {formats.map((f) => (
          <li key={f.format} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{f.format}</span>
            <span
              className="relative hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
              aria-hidden
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-emerald-500"
                style={{ width: `${Math.round(f.hitRate * 100)}%` }}
              />
            </span>
            <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              <span className="font-semibold text-foreground">{f.wins}</span> of {f.posts} posts
            </span>
            <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground md:inline">
              {f.bestLift !== null ? `best ${formatLift(f.bestLift)}` : ""}
            </span>
          </li>
        ))}
      </ol>
      <Link
        href={`/${brand}/formats`}
        onClick={() => trackUsage("home:formats-scoreboard:open", brand)}
        className="mt-2 inline-block text-xs text-muted-foreground hover:text-foreground"
      >
        All formats →
      </Link>
    </div>
  );
}
