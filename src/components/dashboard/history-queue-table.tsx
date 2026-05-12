"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { SourceBadge } from "@/components/ui/source-badge";
import type { QueueHistoryEvent } from "@/app/api/queue/history/route";

interface HistoryQueueTableProps {
  events: QueueHistoryEvent[];
  brand: string;
  loading: boolean;
  emptyMessage: string;
}

// Map a content_events row to a human-readable outcome label + color.
// `payload.from='Idea'` is already filtered server-side, so every row here
// represents an item leaving the triage queue.
function outcomeFromEvent(event: QueueHistoryEvent): {
  label: string;
  className: string;
} {
  const p = event.payload;
  if (p.type === "killed") {
    return {
      label: "Killed",
      className: "bg-rose-100 text-rose-800 border-rose-200",
    };
  }
  if (p.type === "accepted") {
    return {
      label: "Accepted",
      className: "bg-emerald-100 text-emerald-800 border-emerald-200",
    };
  }
  if (p.type === "status_change") {
    const to = p.to ?? "(unknown)";
    return {
      label: to,
      className:
        to === "Killed"
          ? "bg-rose-100 text-rose-800 border-rose-200"
          : to === "Published"
          ? "bg-blue-100 text-blue-800 border-blue-200"
          : "bg-amber-100 text-amber-800 border-amber-200",
    };
  }
  return {
    label: event.eventType,
    className: "bg-muted text-muted-foreground border-border",
  };
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const delta = (Date.now() - d.getTime()) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 7 * 86400) return `${Math.floor(delta / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function actorLabel(event: QueueHistoryEvent): string {
  if (event.actor) return event.actor.name || event.actor.email || "(unknown)";
  // No user means a system / cron action — matches our convention where
  // automated transitions (cron-driven sweeps) leave userId null.
  return "system";
}

function reasonLabel(event: QueueHistoryEvent): string | null {
  const p = event.payload;
  if (p.type === "killed" || p.type === "accepted") {
    return p.reason ? p.reason : null;
  }
  return null;
}

export function HistoryQueueTable({
  events,
  brand,
  loading,
  emptyMessage,
}: HistoryQueueTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-muted-foreground">Loading history…</div>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-md border border-border py-20 text-center">
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 w-[44%]">Content</th>
            <th className="text-left px-3 py-2 w-24">Source</th>
            <th className="text-left px-3 py-2 w-28">Outcome</th>
            <th className="text-left px-3 py-2 w-40">By</th>
            <th className="text-left px-3 py-2 w-20">When</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const outcome = outcomeFromEvent(event);
            const reason = reasonLabel(event);
            const title = event.item.title || "(untitled)";
            return (
              <tr
                key={event.id}
                className="border-t border-border hover:bg-accent/40"
              >
                <td className="px-3 py-2 align-top">
                  <Link
                    href={`/${brand}/content/${event.contentItemId}`}
                    className="text-foreground hover:text-primary hover:underline"
                  >
                    {title}
                  </Link>
                  {event.item.format && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {event.item.format}
                    </div>
                  )}
                  {reason && (
                    <div className="text-xs text-muted-foreground mt-0.5 italic">
                      “{reason}”
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  {event.item.sourceType &&
                  ["original", "repost", "cross_post", "repurposed"].includes(
                    event.item.sourceType,
                  ) ? (
                    <SourceBadge
                      sourceType={
                        event.item.sourceType as
                          | "original"
                          | "repost"
                          | "cross_post"
                          | "repurposed"
                      }
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  <span
                    className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border",
                      outcome.className,
                    )}
                  >
                    {outcome.label}
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-muted-foreground truncate">
                  {actorLabel(event)}
                </td>
                <td
                  className="px-3 py-2 align-top text-xs text-muted-foreground tabular-nums"
                  title={new Date(event.createdAt).toLocaleString()}
                >
                  {formatRelative(event.createdAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
