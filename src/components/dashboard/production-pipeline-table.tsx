"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { platformClass } from "@/lib/badge-colors";
import type { ProductionItem } from "@/types";

interface ProductionPipelineTableProps {
  items: ProductionItem[];
  brand: string;
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

export function ProductionPipelineTable({
  items,
  brand,
}: ProductionPipelineTableProps) {
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
            <col className="w-[160px]" />
            <col className="w-[160px]" />
            <col />
            <col className="w-[220px]" />
            <col className="w-[100px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-accent/50">
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap">
                Producer
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap">
                Editor
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Channel
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Content
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Format
              </th>
              <th
                className="px-3 py-2.5 text-right font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap"
                title="Predicted views — based on past performance of similar content"
              >
                Est. Views
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const producer = personDisplay(item.producerName, item.producerEmail);
              const editor = personDisplay(item.editorName, item.editorEmail);
              const producerColor = avatarColor(producer.seed || item.id);
              const editorColor = avatarColor(editor.seed || item.id);
              return (
                <tr
                  key={item.id}
                  className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                >
                  <td className="px-3 py-2">
                    {item.producerName || item.producerEmail ? (
                      <div className="flex items-center gap-2 min-w-0">
                        <PersonAvatar
                          avatarUrl={item.producerAvatarUrl}
                          initials={producer.initials}
                          colorClass={producerColor}
                          name={producer.name}
                        />
                        <span
                          className="text-sm text-foreground truncate"
                          title={producer.name}
                        >
                          {producer.name}
                        </span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </td>
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
                      {item.platform?.map((p) => (
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
                      ))}
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
