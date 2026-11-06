"use client";

import { Eye, Heart } from "lucide-react";
import { compactNumber, postTypeLabel, type CardBlock, type ContentCard, type StatsCard } from "@/lib/assistant/cards";

/**
 * Result cards under an assistant answer (Starter Story's Ask-the-Data
 * pattern): content cards for lists of posts, a stats tile for totals.
 * Everything here comes from the database via the tools, not model text.
 */
export function AssistantCards({ blocks }: { blocks: CardBlock[] }) {
  return (
    <div className="!mt-3 space-y-3">
      {blocks.map((b, i) => (b.kind === "stats" ? <Stats key={i} stats={b.stats} /> : <ContentList key={i} heading={b.heading} items={b.items} />))}
    </div>
  );
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ContentList({ heading, items }: { heading: string | null; items: ContentCard[] }) {
  return (
    <div className="space-y-1.5">
      {heading && <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{heading}</div>}
      {items.map((item, i) => (
        <a
          key={item.id}
          href={item.app_url}
          className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-2 !no-underline transition-colors hover:border-orange-300 hover:bg-orange-50/40 dark:hover:bg-orange-950/20"
        >
          <span className="w-4 shrink-0 text-center text-xs font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
          <span className="relative size-11 shrink-0 overflow-hidden rounded-lg bg-muted">
            {item.thumbnail_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.thumbnail_url} alt="" className="size-full object-cover" loading="lazy" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">{item.title || "Untitled"}</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {[postTypeLabel(item.post_type), item.account, shortDate(item.published_at)].filter(Boolean).join(" · ")}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="flex items-center justify-end gap-1 text-[13px] font-semibold tabular-nums text-foreground">
              <Eye className="size-3 text-muted-foreground" />
              {compactNumber(item.views)}
            </span>
            {item.likes !== null && (
              <span className="flex items-center justify-end gap-1 text-[11px] tabular-nums text-muted-foreground">
                <Heart className="size-2.5" />
                {compactNumber(item.likes)}
              </span>
            )}
          </span>
        </a>
      ))}
    </div>
  );
}

function Stats({ stats }: { stats: StatsCard }) {
  const tiles: [string, number][] = [
    ["Posts", stats.totals.posts],
    ["Clicks", stats.totals.clicks],
    ["Leads", stats.totals.leads],
  ];
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{stats.label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{stats.range}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">{compactNumber(stats.totals.views)}</span>
        <span className="text-xs text-muted-foreground">views</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {tiles.map(([label, n]) => (
          <div key={label} className="rounded-lg bg-muted/50 px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="text-sm font-semibold tabular-nums text-foreground">{compactNumber(n)}</div>
          </div>
        ))}
      </div>
      {stats.breakdown.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Top accounts</div>
          {stats.breakdown.map((row) => {
            const pct = stats.totals.views > 0 ? Math.max(2, Math.round((row.views / stats.totals.views) * 100)) : 0;
            return (
              <div key={row.name} className="text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-foreground/90">{row.name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {compactNumber(row.views)} · {row.posts} posts
                  </span>
                </div>
                <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-orange-400" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
