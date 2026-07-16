"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { PerformanceBadge } from "./performance-badge";
import { DateRangePill } from "./filter-pills";
import { CoverImg } from "./cover-img";
import { SourceBadge } from "@/components/ui/source-badge";
import { coverImageUrl } from "@/lib/cover-image";
import { PLATFORM_META, type Platform } from "@/lib/platforms";
import { cn } from "@/lib/utils";
import type { BangerItem, TopBangersResult } from "@/lib/db/queries";

interface BangersViewProps {
  brand: string;
  accounts: Array<{ platform: string }>;
}

function defaultDateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  end.setDate(end.getDate() + 1);
  const start = new Date();
  start.setDate(start.getDate() - 90);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

const POST_TYPE_SHORT_LABELS: Record<string, string> = {
  youtube_long: "Long",
  youtube_shorts: "Short",
  youtube_community: "Community",
  instagram_reel: "Reel",
  instagram_post: "Post",
  instagram_story: "Story",
  snapchat_story: "Story",
  snapchat_spotlight: "Spotlight",
  facebook_post: "Post",
};

function postTypeLabel(postType: string | null): string | null {
  if (!postType) return null;
  return POST_TYPE_SHORT_LABELS[postType] ?? null;
}

function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function BangersView({ brand, accounts }: BangersViewProps) {
  const brandPlatforms = useMemo(() => {
    const set = new Set(accounts.map((a) => a.platform));
    return [
      { value: "all", label: "All" } as { value: string; label: string; platform?: Platform },
      ...Object.entries(PLATFORM_META)
        .filter(([key]) => key !== "other" && set.has(key))
        .map(([key, meta]) => ({
          value: key,
          label: meta.label,
          platform: key as Platform,
        })),
    ];
  }, [accounts]);

  const [platform, setPlatform] = useState("all");
  const defaults = defaultDateRange();
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [data, setData] = useState<TopBangersResult | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ brand, platform, startDate, endDate });
      const res = await fetch(`/api/reports/bangers?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error("Failed to fetch bangers:", err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [brand, platform, startDate, endDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="space-y-5">
      {/* Summary stats */}
      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total Views (Top 10)" value={formatViews(data.stats.totalViews)} />
          <StatCard label="Avg Views / Banger" value={formatViews(data.stats.avgViewsPerBanger)} />
          <StatCard
            label="Best Channel"
            value={data.stats.bestChannel ? PLATFORM_META[data.stats.bestChannel as Platform]?.label ?? data.stats.bestChannel : "—"}
            isText
          />
          <StatCard label="Best Format" value={data.stats.bestFormat ?? "—"} isText />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {brandPlatforms.map((ch) => (
            <button
              key={ch.value}
              onClick={() => setPlatform(ch.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                platform === ch.value
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:bg-muted"
              )}
            >
              {ch.platform && <PlatformIcon platform={ch.platform} size={12} inheritColor={platform === ch.value} />}
              {ch.label}
            </button>
          ))}
        </div>
        <DateRangePill
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onDateRangeChange={(s, e) => { setStartDate(s); setEndDate(e); }}
        />
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex items-center gap-2 text-muted-foreground">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Loading top bangers...</span>
          </div>
        </div>
      ) : data && data.items.length > 0 ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px] text-center">#</TableHead>
                <TableHead>Content</TableHead>
                <TableHead className="text-right">Views</TableHead>
                <TableHead className="text-right">Performance</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((item) => (
                <BangerRow key={item.id} item={item} brand={brand} />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="text-center py-20">
          <p className="text-muted-foreground text-sm">No published content with views found.</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, isText }: { label: string; value: string; isText?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn("mt-1 font-bold", isText ? "text-sm" : "text-xl")}>{value}</p>
      </CardContent>
    </Card>
  );
}

function BangerRow({ item, brand }: { item: BangerItem; brand: string }) {
  const rankClass = cn(
    "text-sm font-bold",
    item.rank === 1 && "text-amber-500",
    item.rank === 2 && "text-slate-400",
    item.rank === 3 && "text-amber-700",
    item.rank > 3 && "text-muted-foreground"
  );

  const coverSrc = coverImageUrl(item);

  return (
    <TableRow className="cursor-pointer hover:bg-muted/50">
      <TableCell className="text-center">
        <Link href={`/${brand}/content/${item.id}`}>
          <span className={rankClass}>{item.rank}</span>
        </Link>
      </TableCell>
      <TableCell>
        <Link href={`/${brand}/content/${item.id}`} className="flex items-center gap-3">
          {coverSrc ? (
            <CoverImg
              src={coverSrc}
              alt=""
              className="h-8 w-14 shrink-0 rounded object-cover bg-muted"
            />
          ) : (
            <div className="flex h-8 w-14 shrink-0 items-center justify-center rounded bg-muted">
              {item.platform && <PlatformIcon platform={item.platform as Platform} size={14} />}
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium max-w-[280px]">
              {item.title || "Untitled"}
            </p>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {item.platform && <PlatformIcon platform={item.platform as Platform} size={12} />}
              {item.accountHandle && <span>@{item.accountHandle}</span>}
              {postTypeLabel(item.postType) && (
                <>
                  <span>·</span>
                  <span>{postTypeLabel(item.postType)}</span>
                </>
              )}
              <span>·</span>
              <span>{formatDate(item.publishedAt)}</span>
            </div>
          </div>
        </Link>
      </TableCell>
      <TableCell className="text-right">
        <span className="text-sm font-semibold">{formatViews(item.views)}</span>
      </TableCell>
      <TableCell className="text-right">
        <PerformanceBadge badge={item.badge} multiplier={item.vsAvg} />
      </TableCell>
      <TableCell>
        {item.format ? (
          <span className="inline-block rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {item.format}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <SourceBadge sourceType={item.sourceType as "original" | "repost" | "cross_post" | "repurposed" | "source_recording" | null} />
      </TableCell>
    </TableRow>
  );
}
