"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BellIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { NotificationPayload } from "@/lib/db/schema";

type NotificationItem = {
  id: string;
  kind: string;
  payload: NotificationPayload;
  contentItemId: string | null;
  commentId: string | null;
  readAt: string | null;
  createdAt: string;
  item: { id: string; title: string | null; brand: string } | null;
  actor: {
    id: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  } | null;
};

type ApiShape = {
  items: NotificationItem[];
  unreadCount: number;
};

const POLL_MS = 30_000;

export function NotificationBell() {
  const [data, setData] = useState<ApiShape | null>(null);
  const [open, setOpen] = useState(false);
  // Bump this to force a refetch after a mark-read action.
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/notifications?limit=20", {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const json: ApiShape = await res.json();
        if (!cancelled) setData(json);
      } catch {
        // Silent: bell stays on last known state, will retry next poll.
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refetchTick]);

  const refetch = useCallback(() => setRefetchTick((n) => n + 1), []);

  const unread = data?.unreadCount ?? 0;
  const items = data?.items ?? [];

  async function markRead(ids: string[] | "all") {
    const body = ids === "all" ? { all: true } : { ids };
    await fetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    refetch();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Notifications"
        className="relative inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <BellIcon className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-4 text-center ring-2 ring-card">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[360px] max-h-[480px] p-0 gap-0"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-sm font-semibold text-foreground">
            Notifications
          </span>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => markRead("all")}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Mark all read
            </button>
          )}
        </div>
        <div className="flex-1 overflow-auto">
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              Nothing yet. You&apos;ll see assignments and comments here.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((n) => (
                <li key={n.id}>
                  <NotificationRow
                    n={n}
                    onClick={() => {
                      if (!n.readAt) markRead([n.id]);
                      setOpen(false);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-border px-3 py-2 text-center">
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View all
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({
  n,
  onClick,
}: {
  n: NotificationItem;
  onClick: () => void;
}) {
  const href = n.item ? `/${n.item.brand}/content/${n.item.id}` : "#";
  const actorName = n.actor?.name || n.actor?.email || "A teammate";
  const title = n.item?.title || "(Untitled)";

  let summary: string;
  if (n.payload.kind === "assigned") {
    summary = `${actorName} assigned this to you`;
  } else if (n.payload.kind === "comment") {
    summary = `${actorName} commented`;
  } else if (n.payload.kind === "mention") {
    summary = `${actorName} mentioned you`;
  } else {
    summary = "Update";
  }

  const body =
    n.payload.kind === "comment" || n.payload.kind === "mention"
      ? n.payload.excerpt
      : title;

  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 px-3 py-2.5 text-sm hover:bg-accent/50 transition-colors",
        !n.readAt && "bg-primary/5"
      )}
    >
      <span
        className={cn(
          "mt-1.5 h-1.5 w-1.5 rounded-full shrink-0",
          n.readAt ? "bg-transparent" : "bg-primary"
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-muted-foreground truncate">{summary}</p>
        <p className="text-[13px] text-foreground font-medium truncate">
          {title}
        </p>
        {(n.payload.kind === "comment" || n.payload.kind === "mention") && (
          <p className="text-[12px] text-muted-foreground line-clamp-2 mt-0.5">
            {body}
          </p>
        )}
        <p className="text-[10px] text-muted-foreground mt-1 tabular-nums">
          {formatRelative(n.createdAt)}
        </p>
      </div>
    </Link>
  );
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
