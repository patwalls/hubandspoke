"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { platformClass } from "@/lib/badge-colors";
import { AccountBadge } from "@/components/ui/account-badge";
import type { ProductionItem } from "@/types";

interface ProductionPipelineTableProps {
  items: ProductionItem[];
  brand: string;
}

type SortKey = "editor" | "channel" | "content" | "format" | "views";
type SortDir = "asc" | "desc";

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
}: ProductionPipelineTableProps) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "views" ? "desc" : "asc");
    }
  };

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
          return item.platform?.[0]?.toLowerCase() ?? null;
        case "content":
          return item.title?.toLowerCase() ?? null;
        case "format":
          return item.format?.toLowerCase() ?? null;
        case "views":
          return item.prediction?.prediction ?? null;
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
        <table className="w-full text-xs table-fixed">
          <colgroup>
            <col className="w-[160px]" />
            <col className="w-[240px]" />
            <col />
            <col className="w-[220px]" />
            <col className="w-[100px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-accent/50">
              <SortableHeader
                label="Editor"
                sortKey="editor"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
                className="whitespace-nowrap"
              />
              <SortableHeader
                label="Channel"
                sortKey="channel"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Content"
                sortKey="content"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Format"
                sortKey="format"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Est. Views"
                sortKey="views"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
                align="right"
                className="whitespace-nowrap"
                title="Predicted views — based on past performance of similar content"
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
                      {item.account ? (
                        <AccountBadge
                          account={item.account}
                          postType={item.postType}
                          variant="avatar"
                        />
                      ) : (
                        item.platform?.map((p) => (
                          <span
                            key={p}
                            className={cn(
                              "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border max-w-full truncate",
                              platformClass(p)
                            )}
                            title={p}
                          >
                            {p}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 w-[40%]">
                    <div className="flex items-center gap-1.5 min-w-0">
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
