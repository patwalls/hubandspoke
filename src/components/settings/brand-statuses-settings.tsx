"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronUpIcon,
  ChevronDownIcon,
  Trash2Icon,
  PlusIcon,
  CheckIcon,
  LockIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  STATUS_COLOR_TOKENS,
  STATUS_COLOR_SWATCH,
  type StatusColorToken,
} from "@/lib/badge-colors";
import { cn } from "@/lib/utils";

type Row = {
  id: string;
  name: string;
  color: StatusColorToken;
  position: number;
  isPipelineColumn: boolean;
  isProtected: boolean;
};

const COLOR_TOKENS = Object.keys(STATUS_COLOR_TOKENS) as StatusColorToken[];

interface Props {
  brand: string;
  brandLabel: string;
  initial: Row[];
}

export function BrandStatusesSettings({ brand, brandLabel, initial }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add-form state
  const [addingName, setAddingName] = useState("");
  const [addingColor, setAddingColor] = useState<StatusColorToken>("zinc");
  const [addingPipeline, setAddingPipeline] = useState(false);

  function applyOptimistic(next: Row[]) {
    setRows(next);
  }

  async function patchRow(id: string, patch: Partial<Row>): Promise<boolean> {
    setError(null);
    const res = await fetch(`/api/brand-statuses/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json?.error ?? `Update failed (${res.status})`);
      return false;
    }
    return true;
  }

  async function handleRename(row: Row, nextName: string) {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === row.name) {
      // Revert local state if blanked / unchanged.
      applyOptimistic(rows.map((r) => (r.id === row.id ? { ...r, name: row.name } : r)));
      return;
    }
    const previous = rows;
    applyOptimistic(rows.map((r) => (r.id === row.id ? { ...r, name: trimmed } : r)));
    const ok = await patchRow(row.id, { name: trimmed });
    if (!ok) applyOptimistic(previous);
    else router.refresh();
  }

  async function handleColor(row: Row, color: StatusColorToken) {
    const previous = rows;
    applyOptimistic(rows.map((r) => (r.id === row.id ? { ...r, color } : r)));
    const ok = await patchRow(row.id, { color });
    if (!ok) applyOptimistic(previous);
    else router.refresh();
  }

  async function handlePipelineToggle(row: Row, next: boolean) {
    const previous = rows;
    applyOptimistic(
      rows.map((r) => (r.id === row.id ? { ...r, isPipelineColumn: next } : r))
    );
    const ok = await patchRow(row.id, { isPipelineColumn: next });
    if (!ok) applyOptimistic(previous);
    else router.refresh();
  }

  async function handleMove(row: Row, direction: -1 | 1) {
    const idx = rows.findIndex((r) => r.id === row.id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= rows.length) return;
    const reordered = rows.slice();
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(swapIdx, 0, moved);
    const next = reordered.map((r, i) => ({ ...r, position: i }));
    const previous = rows;
    applyOptimistic(next);
    setBusy(true);
    try {
      // Persist new positions for the two moved rows. The other rows keep
      // their existing position values; positions don't need to be densely
      // 0..N for ordering to work, just monotone.
      const a = next[idx];
      const b = next[swapIdx];
      const okA = await patchRow(a.id, { position: a.position });
      const okB = await patchRow(b.id, { position: b.position });
      if (!okA || !okB) {
        applyOptimistic(previous);
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(row: Row, force = false) {
    if (row.isProtected) return;
    setBusy(true);
    setError(null);
    try {
      const url = `/api/brand-statuses/${row.id}${force ? "?force=1" : ""}`;
      const res = await fetch(url, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409 && typeof json?.inUseCount === "number" && !force) {
        const ok = window.confirm(
          `${json.inUseCount} item(s) currently use "${row.name}". Delete the status anyway? Items will keep the text but lose the colored chip.`
        );
        if (!ok) return;
        await handleDelete(row, true);
        return;
      }
      if (!res.ok) {
        setError(json?.error ?? `Delete failed (${res.status})`);
        return;
      }
      applyOptimistic(rows.filter((r) => r.id !== row.id));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    const trimmed = addingName.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/brand-statuses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand,
          name: trimmed,
          color: addingColor,
          isPipelineColumn: addingPipeline,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error ?? `Create failed (${res.status})`);
        return;
      }
      applyOptimistic([...rows, json.status]);
      setAddingName("");
      setAddingColor("zinc");
      setAddingPipeline(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-medium text-foreground">Statuses</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Edit the production-pipeline statuses for {brandLabel}. Drag-order
          controls the dropdown and kanban column order. &quot;Published&quot;
          and &quot;Killed&quot; are locked because the app uses them in
          publish-date queries and the kill confirmation.
        </p>
      </div>

      {error ? (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      ) : null}

      <div className="rounded-md border border-border divide-y divide-border bg-background">
        {rows.map((row, idx) => (
          // Re-mount when the saved name changes so the uncontrolled input
          // resets to the new value without a setState-in-effect dance.
          <StatusRow
            key={`${row.id}:${row.name}`}
            row={row}
            isFirst={idx === 0}
            isLast={idx === rows.length - 1}
            disabled={busy}
            onRename={(next) => handleRename(row, next)}
            onColor={(color) => handleColor(row, color)}
            onPipelineToggle={(next) => handlePipelineToggle(row, next)}
            onMove={(dir) => handleMove(row, dir)}
            onDelete={() => handleDelete(row)}
          />
        ))}
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No statuses yet — add the first one below.
          </div>
        ) : null}
      </div>

      <div className="rounded-md border border-dashed border-border p-3 space-y-2">
        <div className="text-xs font-medium text-foreground">Add status</div>
        <div className="flex flex-wrap items-center gap-2">
          <ColorPicker value={addingColor} onChange={setAddingColor} />
          <Input
            value={addingName}
            onChange={(e) => setAddingName(e.target.value)}
            placeholder="Status name"
            className="h-8 w-56 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleAdd();
              }
            }}
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={addingPipeline}
              onChange={(e) => setAddingPipeline(e.target.checked)}
            />
            Pipeline column
          </label>
          <Button
            size="sm"
            onClick={() => void handleAdd()}
            disabled={busy || !addingName.trim()}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusRow({
  row,
  isFirst,
  isLast,
  disabled,
  onRename,
  onColor,
  onPipelineToggle,
  onMove,
  onDelete,
}: {
  row: Row;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onRename: (name: string) => void;
  onColor: (c: StatusColorToken) => void;
  onPipelineToggle: (next: boolean) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [draftName, setDraftName] = useState(row.name);

  const lockedTip = row.isProtected ? "Used by the app — cannot be renamed or deleted" : "";

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="flex flex-col">
        <button
          type="button"
          aria-label="Move up"
          onClick={() => onMove(-1)}
          disabled={disabled || isFirst}
          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <ChevronUpIcon className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label="Move down"
          onClick={() => onMove(1)}
          disabled={disabled || isLast}
          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <ChevronDownIcon className="h-3 w-3" />
        </button>
      </div>

      <ColorPicker value={row.color} onChange={onColor} />

      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] font-medium",
          STATUS_COLOR_TOKENS[row.color]
        )}
      >
        {row.name}
      </span>

      <Input
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        onBlur={() => onRename(draftName)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraftName(row.name);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        disabled={disabled || row.isProtected}
        title={lockedTip}
        className="h-8 flex-1 text-sm"
      />

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={row.isPipelineColumn}
          onChange={(e) => onPipelineToggle(e.target.checked)}
          disabled={disabled}
        />
        Pipeline
      </label>

      {row.isProtected ? (
        <span
          className="inline-flex items-center justify-center w-7 h-7 text-muted-foreground"
          title={lockedTip}
        >
          <LockIcon className="h-3.5 w-3.5" />
        </span>
      ) : (
        <button
          type="button"
          aria-label="Delete status"
          onClick={onDelete}
          disabled={disabled}
          className="inline-flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-red-700 hover:bg-red-50 disabled:opacity-30"
        >
          <Trash2Icon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: StatusColorToken;
  onChange: (c: StatusColorToken) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Pick color"
        className={cn(
          "shrink-0 h-6 w-6 rounded border-2 cursor-pointer",
          STATUS_COLOR_SWATCH[value]
        )}
      />
      <PopoverContent
        align="start"
        side="bottom"
        className="w-auto"
      >
        <div className="grid grid-cols-7 gap-1.5 p-0.5">
          {COLOR_TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              aria-label={token}
              onClick={() => {
                onChange(token);
                setOpen(false);
              }}
              className={cn(
                "h-6 w-6 rounded border-2 flex items-center justify-center",
                STATUS_COLOR_SWATCH[token],
                token === value ? "ring-2 ring-foreground/30" : ""
              )}
            >
              {token === value ? (
                <CheckIcon className="h-3 w-3 text-foreground/80" />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
