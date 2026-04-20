"use client";

import { useEffect, useState } from "react";
import { TriageDialog } from "./triage-dialog";
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
        <div className="flex items-center gap-2 min-w-0">
          {item.sourceType === "repost" && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-900 border border-amber-200 shrink-0"
              title="Reposting an existing piece of content"
            >
              Repost
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-left text-sm font-medium text-foreground hover:text-primary hover:underline transition-colors truncate block min-w-0"
            title={item.title || "(Untitled)"}
          >
            {item.title || "(Untitled)"}
          </button>
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-7 items-center justify-center rounded-md border border-input bg-background px-2 text-xs font-medium text-foreground shadow-xs hover:bg-accent transition-colors"
        >
          Triage
        </button>
        <TriageDialog
          open={open}
          onOpenChange={setOpen}
          item={item}
          brand={brand}
          users={users}
          onDone={onDone}
        />
      </td>
    </tr>
  );
}
