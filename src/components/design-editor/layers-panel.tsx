"use client";

/**
 * The page's layers, top of the stack first — pick things that are hard to
 * click on the stage (under a shade, behind a photo) and reorder by drag or
 * the arrows. Every change goes through `apply`, so it's undoable.
 */
import { useState } from "react";
import {
  AtSignIcon,
  CaptionsIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  ClapperboardIcon,
  ImageIcon,
  LockIcon,
  SquareIcon,
  TypeIcon,
  UnlockIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DesignElement, DesignPage } from "@/lib/design-editor/doc";
import { commands, useDesign } from "./store";

const TYPE_ICON: Record<DesignElement["type"], typeof TypeIcon> = {
  text: TypeIcon,
  image: ImageIcon,
  video: ClapperboardIcon,
  captions: CaptionsIcon,
  rect: SquareIcon,
  channel: AtSignIcon,
};

function preview(el: DesignElement): string | null {
  if (el.type !== "text") return null;
  const text = el.spans.map((s) => s.text).join("").replace(/\s+/g, " ").trim();
  return text && text !== el.name ? text : null;
}

export function LayersPanel({ page, pageIndex, disabled, onClose }: { page: DesignPage; pageIndex: number; disabled: boolean; onClose: () => void }) {
  const apply = useDesign((s) => s.apply);
  const select = useDesign((s) => s.select);
  const selectedId = useDesign((s) => (s.selection.pageIndex === pageIndex ? s.selection.elementId : null));
  const [dragId, setDragId] = useState<string | null>(null);
  const [overZ, setOverZ] = useState<number | null>(null);

  const n = page.elements.length;
  const move = (id: string, to: number | "front" | "back") => apply(commands.moveElementTo(pageIndex, id, to));

  return (
    <div className="flex max-h-full w-64 flex-col overflow-hidden rounded-lg border border-border bg-popover text-sm shadow-lg" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2.5 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Layers · top first</span>
        <button type="button" aria-label="Close layers" onClick={onClose} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <XIcon className="size-3.5" />
        </button>
      </div>
      {n === 0 ? (
        <p className="px-2.5 py-3 text-[11px] text-muted-foreground">Nothing on this page yet.</p>
      ) : (
        <ul role="list" aria-label="Layers" className="min-h-0 overflow-y-auto p-1">
          {[...page.elements].reverse().map((el, d) => {
            const z = n - 1 - d;
            const Icon = TYPE_ICON[el.type];
            const selected = el.id === selectedId;
            const sub = preview(el);
            return (
              <li
                key={el.id}
                draggable={!disabled}
                onDragStart={(e) => { setDragId(el.id); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverZ(z); } }}
                onDragLeave={() => setOverZ((o) => (o === z ? null : o))}
                onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== el.id) move(dragId, z); setDragId(null); setOverZ(null); }}
                onDragEnd={() => { setDragId(null); setOverZ(null); }}
                onClick={() => select({ pageIndex, elementId: el.id })}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                  selected ? "bg-sky-100 text-sky-950 dark:bg-sky-950/60 dark:text-sky-100" : "hover:bg-muted",
                  dragId === el.id && "opacity-40",
                  overZ === z && dragId !== el.id && "ring-2 ring-sky-400",
                )}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-[12px] font-medium">{el.name || el.type}</span>
                  {sub && <span className="truncate text-[10px] text-muted-foreground">{sub}</span>}
                </span>
                <span className={cn("flex shrink-0 items-center", !selected && "opacity-0 group-hover:opacity-100")}>
                  {selected && <RowBtn label="Bring to front (⇧⌘])" disabled={disabled || z === n - 1} onClick={() => move(el.id, "front")}><ChevronsUpIcon className="size-3.5" /></RowBtn>}
                  <RowBtn label="Bring forward (⌘])" disabled={disabled || z === n - 1} onClick={() => apply(commands.reorderElement(pageIndex, el.id, "forward"))}><ChevronUpIcon className="size-3.5" /></RowBtn>
                  <RowBtn label="Send backward (⌘[)" disabled={disabled || z === 0} onClick={() => apply(commands.reorderElement(pageIndex, el.id, "backward"))}><ChevronDownIcon className="size-3.5" /></RowBtn>
                  {selected && <RowBtn label="Send to back (⇧⌘[)" disabled={disabled || z === 0} onClick={() => move(el.id, "back")}><ChevronsDownIcon className="size-3.5" /></RowBtn>}
                </span>
                <RowBtn
                  label={el.locked ? "Unlock" : "Lock"}
                  disabled={disabled}
                  onClick={() => apply(commands.patchElement(pageIndex, el.id, (x) => ({ ...x, locked: !x.locked })))}
                  className={cn(!el.locked && !selected && "opacity-0 group-hover:opacity-100")}
                >
                  {el.locked ? <LockIcon className="size-3.5" /> : <UnlockIcon className="size-3.5" />}
                </RowBtn>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RowBtn({ label, disabled, onClick, className, children }: { label: string; disabled?: boolean; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn("flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-25 disabled:hover:bg-transparent", className)}
    >
      {children}
    </button>
  );
}
