"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { trackUsage } from "@/lib/usage/track";
import { paceSummary, type BrandPaceRow, type Pace } from "@/lib/brand-pace/pace";

const OPEN_KEY = "hs:brand-pace-open";
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

const PACE_LABEL: Record<Pace, string> = {
  behind: "Behind",
  on: "On pace",
  ahead: "Ahead",
  quiet: "Quiet",
};
const PACE_CLASS: Record<Pace, string> = {
  behind: "text-amber-600 dark:text-amber-400",
  on: "text-muted-foreground",
  ahead: "text-emerald-600 dark:text-emerald-400",
  quiet: "text-muted-foreground/70",
};

/**
 * "Brands this week" — /all only. One quiet line under the goal tiles
 * ("2 behind pace · 5 on pace"); expanding it (remembered per browser) lists
 * every brand's week so far, off-pace first, each row a link to that brand's
 * dashboard. For the people who flip 3–4 brand dashboards in a row just to
 * read the week's numbers. Rules: src/lib/brand-pace/pace.ts.
 */
export function BrandPaceStrip({ brand }: { brand: string }) {
  const [rows, setRows] = useState<BrandPaceRow[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(localStorage.getItem(OPEN_KEY) === "1");
  }, []);

  useEffect(() => {
    if (brand !== "all") return;
    let cancelled = false;
    fetch("/api/reports/brand-pace")
      .then((r) => (r.ok ? r.json() : { brands: [] }))
      .then((j: { brands?: BrandPaceRow[] }) => {
        if (!cancelled) setRows(j.brands ?? []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [brand]);

  const toggle = (next: boolean) => {
    setOpen(next);
    localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    if (next) trackUsage("all:brand-pace:open", "all");
  };

  if (brand !== "all" || rows === null || rows.length === 0) return null;

  return (
    <section
      className="rounded-lg border border-border bg-card"
      aria-labelledby="brand-pace-heading"
      data-testid="brand-pace-strip"
    >
      <button
        type="button"
        onClick={() => toggle(!open)}
        aria-expanded={open}
        aria-controls="brand-pace-body"
        className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-sm hover:bg-muted/40"
      >
        <h2 id="brand-pace-heading" className="font-medium">
          Brands this week
        </h2>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" data-testid="brand-pace-summary">
          {paceSummary(rows)}
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <div id="brand-pace-body" className="border-t border-border px-4 pb-3 pt-1">
          <ol className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.slug}>
                <Link
                  href={`/${r.slug}`}
                  onClick={() => trackUsage("all:brand-pace:brand-open", "all")}
                  className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/40"
                  data-testid="brand-pace-row"
                >
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  <span
                    className="shrink-0 tabular-nums text-muted-foreground"
                    title={
                      r.basis === "goal"
                        ? `Weekly goal ${r.weeklyGoal}; about ${Math.round(r.expected)} expected by now`
                        : `${r.priorPosts} by this point last week`
                    }
                  >
                    {r.posts} {r.posts === 1 ? "post" : "posts"}
                    {r.basis === "goal" ? (
                      <> / {r.weeklyGoal}</>
                    ) : (
                      <span className="hidden sm:inline"> · {r.priorPosts} last week</span>
                    )}
                  </span>
                  <span className="hidden w-20 shrink-0 text-right tabular-nums text-muted-foreground sm:inline">
                    {compact.format(r.views)} views
                  </span>
                  <span className={`w-16 shrink-0 text-right text-xs font-medium ${PACE_CLASS[r.pace]}`}>
                    {PACE_LABEL[r.pace]}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
