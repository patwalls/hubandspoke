"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** Monospace block with a copy button. `label` names what it is (curl, JSON…). */
export function CodeBlock({
  code,
  label,
  className,
  wrap = false,
}: {
  code: string;
  label?: string;
  className?: string;
  wrap?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (http, permissions) — the text is still selectable
    }
  }
  return (
    <div className={cn("relative rounded-lg border border-border bg-muted/40 text-[12.5px]", className)}>
      {label ? (
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span>{label}</span>
        </div>
      ) : null}
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy"}
        className="absolute right-2 top-1.5 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className={cn("overflow-x-auto p-3 pr-20 font-mono leading-relaxed", wrap && "whitespace-pre-wrap break-all")}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
