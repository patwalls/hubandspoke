"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RecentApiRequest } from "@/lib/api/keys";
import { cn } from "@/lib/utils";

export function ActivityTable({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<RecentApiRequest[] | null>(null);
  const [showAll, setShowAll] = useState(false);

  const [reloadTick, setReloadTick] = useState(0);
  const load = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/api-keys/requests?limit=50${showAll ? "&all=1" : ""}`, { cache: "no-store" });
      const body = res.ok ? ((await res.json()) as { requests: RecentApiRequest[] }) : { requests: [] };
      if (!cancelled) setRows(body.requests);
    })().catch(() => {
      if (!cancelled) setRows([]);
    });
    return () => {
      cancelled = true;
    };
  }, [showAll, reloadTick]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Recent requests</h3>
          <p className="text-xs text-muted-foreground">
            Every API call and MCP tool call made with {showAll ? "any key in the workspace" : "your keys"}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-primary" />
              Everyone
            </label>
          ) : null}
          <Button size="xs" variant="ghost" onClick={load} aria-label="Refresh">
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
      {rows === null ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing yet. Requests show up here within a few seconds of being made.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Key</th>
              {showAll ? <th className="px-4 py-2 font-medium">Who</th> : null}
              <th className="px-4 py-2 font-medium">Request</th>
              <th className="px-4 py-2 font-medium text-right">Status</th>
              <th className="px-4 py-2 font-medium text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{r.key ? r.key.name : r.source === "rest" ? "session" : "—"}</td>
                {showAll ? <td className="px-4 py-2 text-xs text-muted-foreground">{r.owner?.name ?? r.owner?.email ?? "—"}</td> : null}
                <td className="px-4 py-2 font-mono text-xs text-foreground">
                  {r.source === "mcp" ? (
                    <>
                      <span className="mr-1.5 rounded bg-violet-500/10 px-1 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-400">
                        MCP
                      </span>
                      {r.tool ?? "handshake"}
                    </>
                  ) : (
                    <>
                      <span className="mr-1.5 text-muted-foreground">{r.method}</span>
                      {r.route}
                    </>
                  )}
                </td>
                <td
                  className={cn(
                    "px-4 py-2 text-right font-mono text-xs",
                    r.status < 300 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive",
                  )}
                >
                  {r.status}
                </td>
                <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">
                  {r.durationMs === null ? "—" : `${r.durationMs} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
