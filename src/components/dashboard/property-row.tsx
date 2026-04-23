import type React from "react";

/** Single label + value row. Mirrors the content-detail page's row shape —
 *  narrow label column on the left, editor/value on the right. Use inside a
 *  PropertyRowGroup for the divider styling. */
export function PropertyRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[130px_1fr] items-center gap-3 min-h-9 px-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Two-column group of PropertyRows with a vertical divider between cells
 *  and a horizontal border at the bottom. Pass `single` for one wide row. */
export function PropertyRowGroup({
  children,
  single = false,
}: {
  children: React.ReactNode;
  single?: boolean;
}) {
  if (single) {
    return (
      <div className="divide-y divide-border/60 border-b border-border/60 last:border-b-0">
        {children}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-border/60 border-b border-border/60 last:border-b-0">
      {children}
    </div>
  );
}

/** One PropertyRow that spans the full width (no column divider) but keeps
 *  the bottom border of the group. Good for textareas. */
export function PropertyRowSolo({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-border/60 last:border-b-0">{children}</div>
  );
}

/** Shared classname for inputs inside a PropertyRow: borderless, transparent,
 *  with a subtle hover + focus ring so the row feels inline-editable. */
export const PROPERTY_INPUT_CLASS =
  "border-0 bg-transparent shadow-none h-8 px-2 rounded-sm focus-visible:ring-1 focus-visible:ring-ring hover:bg-muted/50 transition-colors";

/** Same treatment for popover triggers / select buttons inside a
 *  PropertyRow. */
export const PROPERTY_TRIGGER_CLASS =
  "border-0 bg-transparent shadow-none h-8 px-2 rounded-sm focus:ring-1 focus:ring-ring hover:bg-muted/50 transition-colors";
