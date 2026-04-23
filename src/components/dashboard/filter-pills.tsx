"use client";

import { useState } from "react";
import { addDays, format, parse, startOfYear } from "date-fns";
import { ChevronDownIcon, CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { AccountAvatar } from "@/components/ui/account-avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getQuickRange } from "@/lib/utils/dates";

export interface FilterAccount {
  id: string;
  platform: string;
  handle: string;
  avatarUrl: string | null;
  brandSlug: string;
  brandLabel: string;
}

interface FilterPillsProps {
  startDate: string;
  endDate: string;
  viewType: string;
  /** Canonical platform key (youtube, instagram, …) or "all". Replaces the
   *  legacy channel-string platform filter. */
  selectedPlatformKey: string;
  /** accounts.id or "all". */
  selectedAccountId: string;
  /** Canonical post_type or "all". */
  selectedPostType: string;
  selectedFormat: string;
  selectedSource: string;
  /** Picker options fetched from the server. Accounts drive the "Account"
   *  dropdown; post types are a static canonical set. */
  accounts: FilterAccount[];
  formats: string[];
  /** Hide the Daily/Weekly interval pill. Pages that don't render a time
   *  series (e.g. /content is a flat table) have no use for it. */
  showViewType?: boolean;
  onStartDateChange: (d: string) => void;
  onEndDateChange: (d: string) => void;
  onViewTypeChange: (v: string) => void;
  onPlatformKeyChange: (v: string) => void;
  onAccountChange: (v: string) => void;
  onPostTypeChange: (v: string) => void;
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
  const endDate = addDays(today, 1);
  if (value === "today") return { startDate: today, endDate };
  if (value === "ytd") return { startDate: startOfYear(today), endDate };
  if (value === "all-time") return { startDate: new Date(2010, 0, 1), endDate };
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

function PillContent({
  label,
  value,
  icon,
}: {
  label?: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <>
      {label && (
        <>
          <span className="text-muted-foreground">{label}</span>
          <span className="text-border">|</span>
        </>
      )}
      {icon}
      <span className="text-foreground font-medium">{value}</span>
      <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
    </>
  );
}

function OptionRow({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon?: React.ReactNode;
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
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
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

export function SelectPill({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: string;
  options: { value: string; label: string; icon?: React.ReactNode }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={PILL_TRIGGER_CLASSES}>
        <PillContent
          label={label}
          value={current?.label ?? value}
          icon={current?.icon}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-1 gap-0.5 max-h-[320px] overflow-y-auto"
      >
        {options.map((o) => (
          <OptionRow
            key={o.value}
            label={o.label}
            icon={o.icon}
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
  selectedPlatformKey,
  selectedAccountId,
  selectedPostType,
  selectedFormat,
  selectedSource,
  accounts,
  formats,
  showViewType = true,
  onStartDateChange,
  onEndDateChange,
  onViewTypeChange,
  onPlatformKeyChange,
  onAccountChange,
  onPostTypeChange,
  onFormatChange,
  onSourceChange,
}: FilterPillsProps) {
  // Canonical platforms — fixed list that the `accounts.platform` column
  // takes values from. Mirrors PLATFORM_META ordering in src/lib/platforms.ts.
  const platformKeyOptions = [
    { value: "all", label: "All platforms" },
    { value: "youtube", label: "YouTube", icon: <PlatformIcon platform="youtube" size={12} /> },
    { value: "instagram", label: "Instagram", icon: <PlatformIcon platform="instagram" size={12} /> },
    { value: "x", label: "X", icon: <PlatformIcon platform="x" size={12} /> },
    { value: "tiktok", label: "TikTok", icon: <PlatformIcon platform="tiktok" size={12} /> },
    { value: "linkedin", label: "LinkedIn", icon: <PlatformIcon platform="linkedin" size={12} /> },
    { value: "threads", label: "Threads", icon: <PlatformIcon platform="threads" size={12} /> },
    { value: "newsletter", label: "Newsletter", icon: <PlatformIcon platform="newsletter" size={12} /> },
    { value: "other", label: "Other", icon: <PlatformIcon platform="other" size={12} /> },
  ];

  // Accounts: always show the full list, but hide ones whose platform
  // doesn't match the selected platform filter (cascade).
  const visibleAccounts = selectedPlatformKey === "all"
    ? accounts
    : accounts.filter((a) => a.platform === selectedPlatformKey);
  const accountOptions = [
    { value: "all", label: "All accounts" },
    ...visibleAccounts.map((a) => ({
      value: a.id,
      label: `@${a.handle}`,
      icon: (
        <AccountAvatar
          avatarUrl={a.avatarUrl}
          platform={a.platform}
          handle={a.handle}
          size={18}
        />
      ),
    })),
  ];

  // Post types: fixed canonical set; cascade by selected platform when one
  // is picked (YouTube → long/short/community, etc.).
  const POST_TYPE_OPTS = [
    { value: "youtube_long", label: "YouTube video", platform: "youtube" },
    { value: "youtube_shorts", label: "YouTube short", platform: "youtube" },
    { value: "youtube_community", label: "YouTube community", platform: "youtube" },
    { value: "instagram_reel", label: "Instagram reel", platform: "instagram" },
    { value: "instagram_post", label: "Instagram post", platform: "instagram" },
    { value: "instagram_story", label: "Instagram story", platform: "instagram" },
    { value: "x", label: "X post", platform: "x" },
    { value: "tiktok", label: "TikTok video", platform: "tiktok" },
    { value: "linkedin", label: "LinkedIn post", platform: "linkedin" },
    { value: "threads", label: "Threads post", platform: "threads" },
    { value: "newsletter", label: "Newsletter", platform: "newsletter" },
  ];
  const visiblePostTypes = selectedPlatformKey === "all"
    ? POST_TYPE_OPTS
    : POST_TYPE_OPTS.filter((pt) => pt.platform === selectedPlatformKey);
  const postTypeOptions = [
    { value: "all", label: "All post types" },
    ...visiblePostTypes.map((pt) => ({
      value: pt.value,
      label: pt.label,
      icon: <PlatformIcon platform={pt.platform} size={12} />,
    })),
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
      {showViewType && (
        <SelectPill value={viewType} options={INTERVALS} onChange={onViewTypeChange} />
      )}
      <SelectPill
        label="Platform"
        value={selectedPlatformKey}
        options={platformKeyOptions}
        onChange={(v) => {
          onPlatformKeyChange(v);
          // Reset dependent filters when the parent changes so they
          // can't point at options that are no longer visible.
          if (v !== "all") {
            const acct = accounts.find((a) => a.id === selectedAccountId);
            if (acct && acct.platform !== v) onAccountChange("all");
            const pt = POST_TYPE_OPTS.find((p) => p.value === selectedPostType);
            if (pt && pt.platform !== v) onPostTypeChange("all");
          }
        }}
      />
      <SelectPill
        label="Account"
        value={selectedAccountId}
        options={accountOptions}
        onChange={onAccountChange}
      />
      <SelectPill
        label="Post type"
        value={selectedPostType}
        options={postTypeOptions}
        onChange={onPostTypeChange}
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
