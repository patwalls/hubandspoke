"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type EditableCallbacks = {
  fieldKey: string | null;
  editable: boolean;
  onLocalEdit?: (fieldKey: string, value: string) => void;
  onCommit?: (fieldKey: string) => void;
};

interface Props extends EditableCallbacks {
  value: string;
  placeholder?: string;
  className?: string;
  /** Soft character limit — renders muted when exceeded. */
  maxLength?: number;
  /** Render as a single line (Input-like) or multi-line (Textarea-like). */
  multiline?: boolean;
}

// A zero-chrome text field that mirrors the surrounding platform mock's
// typography. When not editable, renders as plain text. When editable, users
// click into the same text and type — no explicit "edit" button.
export function EditableField({
  fieldKey,
  editable,
  onLocalEdit,
  onCommit,
  value,
  placeholder,
  className,
  multiline = true,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Auto-size the textarea to fit content. Runs on every value change so the
  // mock doesn't grow scrollbars mid-caption.
  useEffect(() => {
    if (!ref.current || !multiline) return;
    const el = ref.current;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, multiline]);

  if (!editable || !fieldKey || !onLocalEdit) {
    if (!value) {
      return placeholder ? (
        <span className={cn("text-muted-foreground", className)}>
          {placeholder}
        </span>
      ) : null;
    }
    return (
      <span className={cn("whitespace-pre-wrap", className)}>{value}</span>
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onLocalEdit(fieldKey, e.target.value)}
        onBlur={() => onCommit?.(fieldKey)}
        rows={1}
        className={cn(
          "block w-full resize-none border-0 bg-transparent p-0 outline-none",
          "placeholder:text-muted-foreground/60",
          "focus:ring-0 focus:outline-none",
          "focus-visible:ring-0",
          "hover:bg-foreground/[0.03] focus:bg-foreground/[0.04] rounded-sm px-1 -mx-1 transition-colors",
          className,
        )}
      />
    );
  }

  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onLocalEdit(fieldKey, e.target.value)}
      onBlur={() => onCommit?.(fieldKey)}
      className={cn(
        "block w-full border-0 bg-transparent p-0 outline-none",
        "placeholder:text-muted-foreground/60",
        "focus:ring-0 focus:outline-none",
        "hover:bg-foreground/[0.03] focus:bg-foreground/[0.04] rounded-sm px-1 -mx-1 transition-colors",
        className,
      )}
    />
  );
}
