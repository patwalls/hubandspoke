"use client";

import { useMemo } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/ui/account-badge";
import { SourceBadge } from "@/components/ui/source-badge";
import type { ProductionItem } from "@/types";

export type SortKey =
  | "editor"
  | "channel"
  | "content"
  | "format"
  | "views"
  | "created";
export type SortDir = "asc" | "desc";

interface ProductionPipelineTableProps {
  items: ProductionItem[];
  brand: string;
  /** Global sort lifted from ProductionView so a single "Sort" pill +
   *  any column header click drives every status table at once. Null
   *  key means "preserve API-returned order". */
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

const CONFIDENCE_DOT: Record<string, string> = {
  high: "bg-emerald-500",
  med: "bg-amber-500",
  low: "bg-muted-foreground/40",
};

function personDisplay(
  displayName: string | null,
  email: string | null
): { name: string; initials: string; seed: string } {
  const source = displayName?.trim() || email?.split("@")[0] || "";
  if (!source) return { name: "—", initials: "?", seed: "" };
  const words = source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase());
  const name = displayName?.trim() || words.join(" ");
  const initials =
    words
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";
  return { name, initials, seed: email || displayName || "" };
}

const AVATAR_COLORS = [
  "bg-rose-200 text-rose-800",
  "bg-amber-200 text-amber-800",
  "bg-emerald-200 text-emerald-800",
  "bg-sky-200 text-sky-800",
  "bg-violet-200 text-violet-800",
  "bg-pink-200 text-pink-800",
  "bg-teal-200 text-teal-800",
];

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function PersonAvatar({
  avatarUrl,
  initials,
  colorClass,
  name,
}: {
  avatarUrl: string | null | undefined;
  initials: string;
  colorClass: string;
  name: string;
}) {
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={name}
        title={name}
        className="w-6 h-6 rounded-full object-cover shrink-0 bg-accent"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span
      className={cn(
        "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0",
        colorClass
      )}
      title={name}
    >
      {initials}
    </span>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  align = "left",
  className,
  title,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey | null;
  direction: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  className?: string;
  title?: string;
}) {
  const active = activeKey === sortKey;
  const arrow = !active ? "" : direction === "asc" ? "↑" : "↓";
  return (
    <th
      className={cn(
        "px-3 py-2.5 font-mono uppercase tracking-wider text-[10px] text-muted-foreground",
        align === "right" ? "text-right" : "text-left",
        className
      )}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer",
          align === "right" && "justify-end",
          active && "text-foreground"
        )}
      >
        <span>{label}</span>
        <span
          className={cn(
            "inline-block w-2 text-[10px]",
            !active && "opacity-0"
          )}
          aria-hidden
        >
          {arrow}
        </span>
      </button>
    </th>
  );
}

export function ProductionPipelineTable({
  items,
  brand,
  sortKey,
  sortDir,
  onSort,
}: ProductionPipelineTableProps) {
  const sortedItems = useMemo(() => {
    if (!sortKey) return items;
    const dir = sortDir === "asc" ? 1 : -1;
    const keyFn = (item: ProductionItem): string | number | null => {
      switch (sortKey) {
        case "editor":
          return (
            item.editorName?.toLowerCase() ??
            item.editorEmail?.toLowerCase() ??
            null
          );
        case "channel":
          return item.account
            ? `${item.account.platform}:${item.account.handle.toLowerCase()}`
            : null;
        case "content":
          return item.title?.toLowerCase() ?? null;
        case "format":
          return item.format?.toLowerCase() ?? null;
        case "views":
          return item.prediction?.prediction ?? null;
        case "created":
          return item.createdAt ? new Date(item.createdAt).getTime() : null;
      }
    };
    return [...items].sort((a, b) => {
      const av = keyFn(a);
      const bv = keyFn(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [items, sortKey, sortDir]);

  if (items.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-muted-foreground text-xs border border-border rounded-lg bg-card">
        No items.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        {/* min-w floors the table so the only flexible column (Content) can't
            collapse to 0 when the fixed columns (160+240+220+100+90 = 810px)
            exceed the viewport — without it, Content shrank to width:0 at narrow
            widths and its contents spilled over the Format column. The wrapper's
            overflow-x-auto scrolls horizontally instead. */}
        <table className="w-full min-w-[1024px] text-xs table-fixed">
          <colgroup>
            <col className="w-[160px]" />
            <col className="w-[240px]" />
            <col />
            <col className="w-[220px]" />
            <col className="w-[100px]" />
            <col className="w-[90px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-accent/50">
              <SortableHeader
                label="Editor"
                sortKey="editor"
                activeKey={sortKey}
                direction={sortDir}
                onSort={onSort}
                className="whitespace-nowrap"
              />
              <SortableHeader
                label="Channel"
                sortKey="channel"
                activeKey={sortKey}
                direction={sortDir}
                onSort={onSort}
              />
              <SortableHeader
                label="Content"
                sortKey="content"
                activeKey={sortKey}
                direction={sortDir}
                onSort={onSort}
              />
              <SortableHeader
                label="Format"
                sortKey="format"
                activeKey={sortKey}
                direction={sortDir}
                onSort={onSort}
              />
              <SortableHeader
                label="Est. Views"
                sortKey="views"
                activeKey={sortKey}
                direction={sortDir}
                onSort={onSort}
                align="right"
                className="whitespace-nowrap"
                title="Predicted views — based on past performance of similar content"
              />
              <SortableHeader
                label="Created"
                sortKey="created"
                activeKey={sortKey}
                direction={sortDir}
                onSort={onSort}
                align="right"
                className="whitespace-nowrap"
                title="When the production_item row was created"
              />
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item) => {
              const editor = personDisplay(item.editorName, item.editorEmail);
              const editorColor = avatarColor(editor.seed || item.id);
              return (
                <tr
                  key={item.id}
                  className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                >
                  <td className="px-3 py-2">
                    {item.editorName || item.editorEmail ? (
                      <div className="flex items-center gap-2 min-w-0">
                        <PersonAvatar
                          avatarUrl={item.editorAvatarUrl}
                          initials={editor.initials}
                          colorClass={editorColor}
                          name={editor.name}
                        />
                        <span
                          className="text-sm text-foreground truncate"
                          title={editor.name}
                        >
                          {editor.name}
                        </span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1 min-w-0">
                      <AccountBadge
                        account={item.account}
                        postType={item.postType}
                        variant="avatar"
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2 w-[40%]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <SourceBadge sourceType={item.sourceType} />
                      <Link
                        href={`/${brand}/content/${item.id}`}
                        className="text-sm font-medium text-foreground hover:text-primary hover:underline transition-colors truncate min-w-0"
                        title={item.title || "(Untitled)"}
                      >
                        {item.title || "(Untitled)"}
                      </Link>
                      {item.publishedLink && (
                        <a
                          href={item.publishedLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground shrink-0"
                          title="Open published post"
                          aria-label="Open published post"
                        >
                          ↗
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm text-muted-foreground max-w-[220px]">
                    <div className="truncate" title={item.format || ""}>
                      {item.format || "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm text-right tabular-nums">
                    {item.prediction && item.prediction.prediction != null ? (
                      <div
                        className="inline-flex items-center gap-1.5 justify-end"
                        title={`Range ${formatCompact(item.prediction.p25)}–${formatCompact(
                          item.prediction.p75
                        )} · ${item.prediction.confidence} confidence${
                          item.prediction.cohortBreakdown.length
                            ? ` · ${item.prediction.cohortBreakdown
                                .map(
                                  (c) =>
                                    `${c.label}: ${c.n} posts, median ${formatCompact(c.median)}`
                                )
                                .join(" · ")}`
                            : ""
                        }`}
                      >
                        <span
                          className={cn(
                            "w-1.5 h-1.5 rounded-full",
                            CONFIDENCE_DOT[item.prediction.confidence] ??
                              CONFIDENCE_DOT.low
                          )}
                          aria-hidden
                        />
                        <span className="text-foreground">
                          {formatCompact(item.prediction.prediction)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td
                    className="px-3 py-2 text-sm text-right tabular-nums text-muted-foreground"
                    title={
                      item.createdAt
                        ? new Date(item.createdAt).toLocaleString()
                        : undefined
                    }
                  >
                    {formatRelativeTime(item.createdAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
