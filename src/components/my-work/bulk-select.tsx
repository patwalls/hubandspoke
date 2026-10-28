"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BulkKillDialog } from "@/components/dashboard/bulk-kill-dialog";
import { CheckboxCell } from "@/components/dashboard/idea-queue-table";
import { trackUsage } from "@/lib/usage/track";
import { bulkMoveTargets, inBatches } from "@/lib/my-work/bulk";
import { useEditableBrands } from "@/components/brand-access";

const VIEW_ONLY_TITLE = "View only — you don't have edit access to every selected post's brand";

/**
 * Bulk changes on My Work (rules in src/lib/my-work/bulk.ts): a checkbox on
 * every row and a select-all per section; once something is selected, a bar
 * at the bottom moves it all to one status, kills it (one reason for all) or
 * deletes it. Every change goes through the same PUT / DELETE the content
 * page uses, a few at a time, so events and notifications are unchanged.
 */

type Selection = {
  selected: ReadonlyMap<string, string>; // id → brand
  toggle: (rows: { id: string; brand: string }[], on: boolean) => void;
};

const SelectionContext = createContext<Selection | null>(null);

function useSelection(): Selection {
  const s = useContext(SelectionContext);
  if (!s) throw new Error("My Work selection used outside <MyWorkSelection>");
  return s;
}

export function MyWorkSelection({
  statusesByBrand,
  children,
}: {
  statusesByBrand: Record<string, string[]>;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const value = useMemo<Selection>(
    () => ({
      selected,
      toggle: (rows, on) =>
        setSelected((prev) => {
          const next = new Map(prev);
          for (const r of rows) {
            if (on) next.set(r.id, r.brand);
            else next.delete(r.id);
          }
          return next;
        }),
    }),
    [selected],
  );
  return (
    <SelectionContext.Provider value={value}>
      {children}
      <BulkBar statusesByBrand={statusesByBrand} clear={() => setSelected(new Map())} />
    </SelectionContext.Provider>
  );
}

export function SelectRow({ id, brand, title }: { id: string; brand: string; title: string }) {
  const { selected, toggle } = useSelection();
  return (
    <CheckboxCell
      checked={selected.has(id)}
      onChange={(on) => toggle([{ id, brand }], on)}
      ariaLabel={`Select “${title}”`}
    />
  );
}

export function SelectAll({ rows, label }: { rows: { id: string; brand: string }[]; label: string }) {
  const { selected, toggle } = useSelection();
  const n = rows.filter((r) => selected.has(r.id)).length;
  return (
    <CheckboxCell
      checked={n > 0 && n === rows.length}
      indeterminate={n > 0 && n < rows.length}
      onChange={(on) => toggle(rows, on)}
      ariaLabel={`Select all in ${label}`}
    />
  );
}

async function send(method: "PUT" | "DELETE", body: object) {
  const res = await fetch("/api/production-items", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
}

function BulkBar({
  statusesByBrand,
  clear,
}: {
  statusesByBrand: Record<string, string[]>;
  clear: () => void;
}) {
  const router = useRouter();
  const { selected } = useSelection();
  const editable = useEditableBrands();
  const [busy, setBusy] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const count = selected.size;
  const ids = [...selected.keys()];
  const brands = [...selected.values()];
  const targets = bulkMoveTargets(brands, statusesByBrand);
  const posts = (n: number) => `${n} post${n === 1 ? "" : "s"}`;
  // Bulk changes only when every selected row is on a brand the user can edit.
  const canEdit = editable === "all" || brands.every((b) => editable.includes(b));
  const lockedTitle = canEdit ? undefined : VIEW_ONLY_TITLE;

  async function run(mark: string, verb: string, fn: (id: string) => Promise<unknown>) {
    if (!canEdit) return;
    setBusy(true);
    trackUsage(`my-work:${mark}`, brands[0]);
    try {
      const { ok, failed, firstError } = await inBatches(ids, 5, fn);
      if (failed === 0) toast.success(`${verb} ${posts(ok)}`);
      else if (ok === 0) toast.error(`Couldn't change ${posts(failed)}: ${firstError}`);
      else toast.warning(`${verb} ${posts(ok)}; ${failed} failed: ${firstError}`, { duration: 8000 });
      setKillOpen(false);
      setDeleteOpen(false);
      clear();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (count === 0) return null;

  return (
    <>
      {/* Room at the bottom so the bar never covers the last row. */}
      <div aria-hidden className="h-16" />
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100vw-2rem)]">
        <div
          data-my-work-bulk
          className="inline-flex flex-wrap items-center gap-2 rounded-full border border-border bg-card/95 backdrop-blur pl-4 pr-1.5 py-1.5 shadow-lg"
        >
          <span className="text-xs text-foreground">
            <span className="font-semibold tabular-nums">{count}</span>
            <span className="text-muted-foreground"> selected</span>
          </span>
          <button
            type="button"
            onClick={clear}
            disabled={busy}
            className="text-xs text-muted-foreground hover:text-foreground px-1"
          >
            Clear
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy || !canEdit || targets.length === 0}
              title={lockedTitle ?? (targets.length === 0 ? "These brands share no status to move to" : undefined)}
              className="inline-flex items-center gap-1 rounded-full border border-input bg-background px-3 h-7 text-xs font-medium hover:bg-accent disabled:opacity-50"
            >
              Move to <ChevronDownIcon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="top" className="w-48">
              {targets.map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => void run("bulk-move", `Moved to ${s}:`, (id) => send("PUT", { id, status: s }))}
                >
                  {s}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => setKillOpen(true)}
            disabled={busy || !canEdit}
            title={lockedTitle}
            className="inline-flex items-center rounded-full border border-input bg-background px-3 h-7 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            Kill
          </button>
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            disabled={busy || !canEdit}
            title={lockedTitle}
            className="inline-flex items-center rounded-full bg-red-600 px-3 h-7 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>

      <BulkKillDialog
        open={killOpen}
        onOpenChange={(o) => !busy && setKillOpen(o)}
        count={count}
        saving={busy}
        noun="post"
        onConfirm={(reason) =>
          run("bulk-kill", "Killed", (id) => send("PUT", { id, status: "Killed", killReason: reason }))
        }
      />

      <Dialog open={deleteOpen} onOpenChange={(o) => !busy && setDeleteOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {posts(count)}?</DialogTitle>
            <DialogDescription>
              They&apos;re gone for good, along with their comments, history, transcripts, media and clip
              ideas. This can&apos;t be undone. To keep a record of why, use Kill instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void run("bulk-delete", "Deleted", (id) => send("DELETE", { id }))}
              disabled={busy}
            >
              {busy ? `Deleting ${count}…` : `Delete ${posts(count)}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
