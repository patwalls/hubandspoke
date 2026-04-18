"use client";

import { useState } from "react";
import { format, parse, startOfYear } from "date-fns";
import { ChevronDownIcon, CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getQuickRange } from "@/lib/utils/dates";

interface FilterPillsProps {
  startDate: string;
  endDate: string;
  viewType: string;
  selectedPlatform: string;
  selectedFormat: string;
  selectedSource: string;
  platforms: string[];
  formats: string[];
  onStartDateChange: (d: string) => void;
  onEndDateChange: (d: string) => void;
  onViewTypeChange: (v: string) => void;
  onPlatformChange: (v: string) => void;
  onFormatChange: (v: string) => void;
  onSourceChange: (v: string) => void;
}

const PRESETS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "this-quarter", label: "This quarter" },
  { value: "last-quarter", label: "Last quarter" },
  { value: "ytd", label: "Year to date" },
  { value: "all-time", label: "All time" },
] as const;

const INTERVALS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const SOURCES = [
  { value: "all", label: "All sources" },
  { value: "internal", label: "Internal" },
  { value: "external", label: "External" },
];

function resolvePreset(
  value: string
): { startDate: Date; endDate: Date } | null {
  const today = new Date();
  if (value === "today") return { startDate: today, endDate: today };
  if (value === "ytd") return { startDate: startOfYear(today), endDate: today };
  if (value === "all-time") return { startDate: new Date(2010, 0, 1), endDate: today };
  return getQuickRange(value);
}

function activePresetValue(startDate: string, endDate: string): string | null {
  for (const p of PRESETS) {
    const r = resolvePreset(p.value);
    if (
      r &&
      format(r.startDate, "yyyy-MM-dd") === startDate &&
      format(r.endDate, "yyyy-MM-dd") === endDate
    ) {
      return p.value;
    }
  }
  return null;
}

function rangeLabel(startDate: string, endDate: string): string {
  const preset = activePresetValue(startDate, endDate);
  if (preset) return PRESETS.find((p) => p.value === preset)!.label;
  try {
    const s = parse(startDate, "yyyy-MM-dd", new Date());
    const e = parse(endDate, "yyyy-MM-dd", new Date());
    const sameYear = s.getFullYear() === e.getFullYear();
    return sameYear
      ? `${format(s, "MMM d")} – ${format(e, "MMM d, yyyy")}`
      : `${format(s, "MMM d, yyyy")} – ${format(e, "MMM d, yyyy")}`;
  } catch {
    return `${startDate} – ${endDate}`;
  }
}

const PILL_TRIGGER_CLASSES =
  "inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border bg-card text-sm hover:bg-accent transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function PillContent({ label, value }: { label?: string; value: string }) {
  return (
    <>
      {label && (
        <>
          <span className="text-muted-foreground">{label}</span>
          <span className="text-border">|</span>
        </>
      )}
      <span className="text-foreground font-medium">{value}</span>
      <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
    </>
  );
}

function OptionRow({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm text-left transition-colors",
        active
          ? "bg-accent text-foreground font-medium"
          : "text-foreground hover:bg-accent"
      )}
    >
      <span className="truncate">{label}</span>
      {active && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}

function DateRangePill({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
}: Pick<
  FilterPillsProps,
  "startDate" | "endDate" | "onStartDateChange" | "onEndDateChange"
>) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(startDate);
  const [draftEnd, setDraftEnd] = useState(endDate);

  function handleOpenChange(next: boolean) {
    if (next) {
      setDraftStart(startDate);
      setDraftEnd(endDate);
    }
    setOpen(next);
  }

  function applyPreset(value: string) {
    const r = resolvePreset(value);
    if (!r) return;
    const s = format(r.startDate, "yyyy-MM-dd");
    const e = format(r.endDate, "yyyy-MM-dd");
    onStartDateChange(s);
    onEndDateChange(e);
    setOpen(false);
  }

  function applyCustom() {
    onStartDateChange(draftStart);
    onEndDateChange(draftEnd);
    setOpen(false);
  }

  const activeValue = activePresetValue(startDate, endDate);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger className={PILL_TRIGGER_CLASSES}>
        <PillContent label="Date range" value={rangeLabel(startDate, endDate)} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2 gap-1">
        <div className="flex flex-col">
          {PRESETS.map((p) => (
            <OptionRow
              key={p.value}
              label={p.label}
              active={activeValue === p.value}
              onClick={() => applyPreset(p.value)}
            />
          ))}
        </div>
        <div className="border-t border-border my-1" />
        <div className="px-1 pb-1 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-muted-foreground w-10">Start</label>
            <input
              type="date"
              value={draftStart}
              onChange={(e) => setDraftStart(e.target.value)}
              className="flex-1 h-8 px-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-muted-foreground w-10">End</label>
            <input
              type="date"
              value={draftEnd}
              onChange={(e) => setDraftEnd(e.target.value)}
              className="flex-1 h-8 px-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-7 px-3 text-xs font-medium rounded-md border border-border text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={applyCustom}
              className="h-7 px-3 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Apply
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SelectPill({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={PILL_TRIGGER_CLASSES}>
        <PillContent label={label} value={current?.label ?? value} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-1 gap-0.5 max-h-[320px] overflow-y-auto"
      >
        {options.map((o) => (
          <OptionRow
            key={o.value}
            label={o.label}
            active={o.value === value}
            onClick={() => {
              onChange(o.value);
              setOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function FilterPills({
  startDate,
  endDate,
  viewType,
  selectedPlatform,
  selectedFormat,
  selectedSource,
  platforms,
  formats,
  onStartDateChange,
  onEndDateChange,
  onViewTypeChange,
  onPlatformChange,
  onFormatChange,
  onSourceChange,
}: FilterPillsProps) {
  const platformOptions = [
    { value: "all", label: "All platforms" },
    ...platforms.map((p) => ({ value: p, label: p })),
  ];
  const formatOptions = [
    { value: "all", label: "All formats" },
    ...formats.map((f) => ({ value: f, label: f })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangePill
        startDate={startDate}
        endDate={endDate}
        onStartDateChange={onStartDateChange}
        onEndDateChange={onEndDateChange}
      />
      <SelectPill value={viewType} options={INTERVALS} onChange={onViewTypeChange} />
      <SelectPill
        label="Platform"
        value={selectedPlatform}
        options={platformOptions}
        onChange={onPlatformChange}
      />
      <SelectPill
        label="Format"
        value={selectedFormat}
        options={formatOptions}
        onChange={onFormatChange}
      />
      <SelectPill
        label="Source"
        value={selectedSource}
        options={SOURCES}
        onChange={onSourceChange}
      />
    </div>
  );
}
