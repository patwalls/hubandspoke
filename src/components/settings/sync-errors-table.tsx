"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface SyncErrorItem {
  id: string;
  title: string | null;
  brand: string;
  platform: string[];
  url: string | null;
  lastPerformanceSyncAt: string | null;
  lastPerformanceSyncError: string;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function SyncErrorsTable({ items }: { items: SyncErrorItem[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [retryingId, setRetryingId] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        No sync errors. All items are up to date.
      </div>
    );
  }

  const retry = async (id: string) => {
    setRetryingId(id);
    try {
      await fetch(`/api/production-items/${id}/sync`, { method: "POST" });
    } finally {
      setRetryingId(null);
      startTransition(() => router.refresh());
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[28%]">Title</TableHead>
            <TableHead className="w-[12%]">Platform</TableHead>
            <TableHead className="w-[18%]">URL</TableHead>
            <TableHead className="w-[24%]">Error</TableHead>
            <TableHead className="w-[10%]">Last attempt</TableHead>
            <TableHead className="w-[8%] text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="font-medium">
                <Link
                  href={`/${item.brand}/content/${item.id}`}
                  className="hover:underline"
                >
                  {item.title || "(Untitled)"}
                </Link>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {item.platform.length === 0 ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    item.platform.map((p) => (
                      <Badge key={p} variant="secondary" className="text-xs">
                        {p}
                      </Badge>
                    ))
                  )}
                </div>
              </TableCell>
              <TableCell>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground truncate block max-w-[200px]"
                    title={item.url}
                  >
                    {item.url}
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No URL set
                  </span>
                )}
              </TableCell>
              <TableCell>
                <div
                  className="text-xs text-destructive line-clamp-2"
                  title={item.lastPerformanceSyncError}
                >
                  {item.lastPerformanceSyncError}
                </div>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                {timeAgo(item.lastPerformanceSyncAt)}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending || retryingId === item.id}
                  onClick={() => retry(item.id)}
                >
                  {retryingId === item.id ? "Retrying…" : "Retry"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
