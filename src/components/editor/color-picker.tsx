"use client";

/**
 * The colour control every editor uses (design editor, clip editor).
 *
 *   swatch + hex you can type or paste · copy · the native picker
 *   In this design   colours already used in the document (passed in)
 *   Recent           the last colours picked anywhere, remembered per browser
 *   Brand & common   the palette the posts are made of
 *
 * Every pick calls `onChange` with "#RRGGBB" — the same contract as an
 * <input type="color">, so it drops into any existing colour field.
 */
import { useMemo, useRef, useState } from "react";
import { CheckIcon, CopyIcon, PipetteIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export const BRAND_PALETTE: Array<{ hex: string; name: string }> = [
  { hex: "#FFFFFF", name: "White" },
  { hex: "#000000", name: "Black" },
  { hex: "#0B0B0B", name: "Near black" },
  { hex: "#1C1C1E", name: "Ink" },
  { hex: "#5C5C5C", name: "Grey" },
  { hex: "#8E8E93", name: "Light grey" },
  { hex: "#F7F5EF", name: "Notes cream" },
  { hex: "#F5F3EE", name: "Band cream" },
  { hex: "#FF3B3B", name: "Highlight red" },
  { hex: "#22E07A", name: "Highlight green" },
  { hex: "#FFE14D", name: "Highlight yellow" },
  { hex: "#6B5BFF", name: "Pill purple" },
  { hex: "#C7891E", name: "Notes accent" },
  { hex: "#FF0000", name: "YouTube red" },
  { hex: "#38BDF8", name: "Sky" },
  { hex: "#4ADE80", name: "Mint" },
  { hex: "#FB7185", name: "Rose" },
];

const RECENT_KEY = "hs:editor:recent-colors";
const RECENT_MAX = 14;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === "string" && isHex(c)) : [];
  } catch {
    return [];
  }
}

function pushRecent(hex: string): void {
  try {
    const next = [hex, ...readRecent().filter((c) => c !== hex)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode etc. — recents are a convenience */
  }
}

export function isHex(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

/** "#abc", "abc123", "rgb(1, 2, 3)" → "#RRGGBB" (or null). */
export function normalizeColor(input: string): string | null {
  const v = input.trim();
  const m3 = /^#?([0-9a-fA-F]{3})$/.exec(v);
  if (m3) return `#${m3[1].split("").map((c) => c + c).join("")}`.toUpperCase();
  const m6 = /^#?([0-9a-fA-F]{6})$/.exec(v);
  if (m6) return `#${m6[1]}`.toUpperCase();
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(v);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return null;
}

export function ColorPicker({
  value,
  onChange,
  usedColors = [],
  label,
  className,
}: {
  value: string;
  onChange: (hex: string) => void;
  /** Colours already in the document, shown as "In this design". */
  usedColors?: string[];
  /** Accessible name for the swatch button. */
  label?: string;
  className?: string;
}) {
  const [open, setOpenState] = useState(false);
  const [text, setText] = useState(value.toUpperCase());
  const [recent, setRecent] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const nativeRef = useRef<HTMLInputElement | null>(null);
  // The hex field follows the value (derived-state pattern, no effect).
  const [seenValue, setSeenValue] = useState(value);
  if (seenValue !== value) {
    setSeenValue(value);
    setText(value.toUpperCase());
  }
  const setOpen = (o: boolean) => {
    if (o) setRecent(readRecent());
    setOpenState(o);
  };

  const current = normalizeColor(value) ?? "#000000";
  const pick = (hex: string) => {
    const n = normalizeColor(hex);
    if (!n || n === current) return;
    onChange(n);
    pushRecent(n);
    setRecent(readRecent());
  };
  const used = useMemo(() => {
    const seen = new Set<string>();
    for (const c of usedColors) {
      const n = normalizeColor(c);
      if (n) seen.add(n);
    }
    return [...seen];
  }, [usedColors]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label ? `${label}: ${current}` : current}
        title={current}
        className={cn("flex items-center gap-1.5 rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono hover:bg-muted", className)}
      >
        <span className="size-4 rounded-sm border border-black/15" style={{ background: current }} />
        {current}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 gap-2"
        // Escape closes the picker only — never the editor dialog behind it.
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            setOpen(false);
          }
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className="size-7 shrink-0 rounded-md border border-black/15" style={{ background: current }} />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") pick(text);
            }}
            onBlur={() => {
              if (normalizeColor(text)) pick(text);
              else setText(current);
            }}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text");
              if (normalizeColor(pasted)) {
                e.preventDefault();
                pick(pasted);
              }
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px] uppercase text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
          <IconBtn
            label={copied ? "Copied" : "Copy"}
            onClick={() => {
              void navigator.clipboard.writeText(current);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? <CheckIcon className="size-3.5 text-emerald-600" /> : <CopyIcon className="size-3.5" />}
          </IconBtn>
          <IconBtn label="Pick any colour" onClick={() => nativeRef.current?.click()}>
            <PipetteIcon className="size-3.5" />
          </IconBtn>
          <input ref={nativeRef} type="color" value={current} onChange={(e) => pick(e.target.value)} className="sr-only" tabIndex={-1} aria-hidden />
        </div>
        {used.length > 0 && <Swatches title="In this design" colors={used} current={current} onPick={pick} />}
        <Swatches title="Recent" colors={recent} current={current} onPick={pick} empty="Colours you pick show up here" />
        <Swatches title="Brand & common" colors={BRAND_PALETTE.map((p) => p.hex)} names={Object.fromEntries(BRAND_PALETTE.map((p) => [p.hex, p.name]))} current={current} onPick={pick} />
      </PopoverContent>
    </Popover>
  );
}

function Swatches({ title, colors, names = {}, current, onPick, empty }: { title: string; colors: string[]; names?: Record<string, string>; current: string; onPick: (hex: string) => void; empty?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
      <div className="flex min-h-6 flex-wrap gap-1">
        {colors.length === 0 && empty && <span className="text-[11px] text-muted-foreground">{empty}</span>}
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            title={names[c] ? `${names[c]} · ${c}` : c}
            aria-label={names[c] ? `${names[c]} ${c}` : c}
            onClick={() => onPick(c)}
            className={cn("size-6 rounded-md border border-black/15 transition-transform hover:scale-110", c === current && "ring-2 ring-sky-500 ring-offset-1 ring-offset-popover")}
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border hover:bg-muted">
      {children}
    </button>
  );
}
