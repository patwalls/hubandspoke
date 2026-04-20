"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserChip } from "./user-chip";
import type { ProductionItem } from "@/types";

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface IdeaQueueTableProps {
  items: ProductionItem[];
  brand: string;
  emptyMessage: string;
  onMutate: () => void;
}

export function IdeaQueueTable({
  items,
  brand,
  emptyMessage,
  onMutate,
}: IdeaQueueTableProps) {
  const [users, setUsers] = useState<AssignableUser[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/users/assignable");
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setUsers(json.users || []);
      } catch {
        // Non-fatal — the picker just won't suggest anyone.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-muted-foreground text-sm border border-border rounded-lg bg-card">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs table-fixed">
          <colgroup>
            <col className="w-[180px]" />
            <col />
            <col className="w-[220px]" />
            <col className="w-[120px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-accent/50">
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap">
                Channel
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Content
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Format
              </th>
              <th className="px-3 py-2.5 text-right font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <IdeaQueueRow
                key={item.id}
                item={item}
                brand={brand}
                users={users}
                onDone={onMutate}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IdeaQueueRow({
  item,
  brand,
  users,
  onDone,
}: {
  item: ProductionItem;
  brand: string;
  users: AssignableUser[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assignTo(userId: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          editorUserId: userId,
          status: "Assigned",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign");
    } finally {
      setSaving(false);
    }
  }

  async function killIt() {
    if (!confirm(`Kill "${item.title || "(Untitled)"}"?`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status: "Killed" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to kill");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-b border-border/50 hover:bg-accent/30 transition-colors">
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1 min-w-0">
          {item.platform?.map((p) => (
            <span
              key={p}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border max-w-full truncate"
              title={p}
            >
              {p}
            </span>
          ))}
          {!item.platform?.length && (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <Link
          href={`/${brand}/content/${item.id}`}
          className="text-sm font-medium text-foreground hover:text-primary hover:underline transition-colors truncate block"
          title={item.title || "(Untitled)"}
        >
          {item.title || "(Untitled)"}
        </Link>
      </td>
      <td className="px-3 py-2 text-sm text-muted-foreground">
        <div className="truncate" title={item.format || ""}>
          {item.format || "—"}
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            disabled={saving}
            className="inline-flex h-7 items-center justify-center rounded-md border border-input bg-background px-2 text-xs font-medium text-foreground shadow-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            {saving ? "…" : "Triage"}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1 pb-1">
              Assign editor
            </div>
            <div className="max-h-60 overflow-y-auto flex flex-col gap-0.5">
              {users.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  No assignable users found.
                </div>
              ) : (
                users.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => assignTo(u.id)}
                    disabled={saving}
                    className="flex items-center w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                  >
                    <UserChip user={u} size="xs" />
                  </button>
                ))
              )}
            </div>
            <div className="border-t border-border -mx-2.5 my-1" />
            <button
              type="button"
              onClick={killIt}
              disabled={saving}
              className="flex items-center w-full text-left rounded-md px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Kill this idea
            </button>
            {error && (
              <p className="text-[11px] text-red-600 px-1 pt-1">{error}</p>
            )}
          </PopoverContent>
        </Popover>
      </td>
    </tr>
  );
}
