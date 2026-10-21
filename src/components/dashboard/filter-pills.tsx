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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { getQuickRange } from "@/lib/utils/dates";
import { PLATFORM_META, POST_TYPE_SHORT_LABEL, toPlatform } from "@/lib/platforms";
import type { PostType } from "@/lib/platform-field-schemas";
import {
  channelKey,
  multiFilterAllows,
  parseMultiFilter,
  serializeMultiFilter,
  type MultiFilter,
} from "@/lib/multi-filter";

export interface FilterAccount {
  id: string;
  platform: string;
  handle: string;
  avatarUrl: string | null;
  brandSlug: string;
  brandLabel: string;
}

export interface ScopePatch {
  platform?: string;
  accountId?: string;
  postType?: string;
  channels?: string;
}

interface FilterPillsProps {
  startDate: string;
  endDate: string;
  viewType: string;
  /** How the primary breakdown table buckets its rows:
   *  "brand" | "platform" | "account" | "postType". Only rendered when
   *  `onGroupByChange` is supplied. */
  selectedGroupBy?: string;
  /** Whether to offer "Brand" as a group-by option. Only meaningful on the
   *  cross-brand /all view; hidden on single-brand dashboards. */
  showBrandGroup?: boolean;
  /** Platform, Account, Post type, Channels, Format and Source are all
   *  multi-select: each value is "all" or a comma-separated list
   *  (src/lib/multi-filter.ts).
   *  Platform: canonical platform keys (youtube, instagram, …). */
  selectedPlatformKey: string;
  /** accounts.id list. */
  selectedAccountId: string;
  /** Canonical post_type list. */
  selectedPostType: string;
  /** `<accountId>|<postType>` channel keys. */
  selectedChannels: string;
  /** Format names. */
  selectedFormat: string;
  /** sourceType values (original / repurposed / cross_post / repost). */
  selectedSource: string;
  /** When true, items whose format isn't currently proven are excluded
   *  from the report aggregations. Defaults to false. */
  provenOnly?: boolean;
  /** Provenance filter — "all" | "hubandspoke" | "synced". Maps to
   *  `productionItems.createdVia` ranges on the server. Only rendered when
   *  both `selectedOrigin` and `onOriginChange` are provided — other pages
   *  (brand dashboard, content report) don't surface this filter. */
  selectedOrigin?: string;
  /** Picker options fetched from the server. Accounts drive the "Account"
   *  dropdown; post types are a static canonical set. */
  accounts: FilterAccount[];
  formats: string[];
  /** Hide the Daily/Weekly interval pill. Pages that don't render a time
   *  series (e.g. /content is a flat table) have no use for it. */
  showViewType?: boolean;
  onStartDateChange: (d: string) => void;
  onEndDateChange: (d: string) => void;
  /** Optional atomic setter — when provided, the date pill calls this instead
   *  of firing `onStartDateChange` + `onEndDateChange` back-to-back. Avoids a
   *  race where useUrlState's two consecutive `set()` calls each build off the
   *  same pre-update URL snapshot, so only the second key sticks. Consumers
   *  that drive their state through `useUrlState` should pass:
   *    (s, e) => filters.setMany({ startDate: s, endDate: e })
   *  to write both URL params in one update. */
  onDateRangeChange?: (startDate: string, endDate: string) => void;
  onViewTypeChange: (v: string) => void;
  onGroupByChange?: (v: string) => void;
  /** Platform / Account / Post type / Channels cascade into each other, so
   *  a change to one can prune the others. All of it arrives as ONE patch
   *  (keyed by URL param) so consumers can write it atomically:
   *    (patch) => filters.setMany(patch)
   *  — separate `set()` calls race (see onDateRangeChange). */
  onScopeChange: (patch: ScopePatch) => void;
  onFormatChange: (v: string) => void;
  onSourceChange: (v: string) => void;
  onProvenOnlyChange?: (v: boolean) => void;
  onOriginChange?: (v: string) => void;
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
  { value: "monthly", label: "Monthly" },
];

const SOURCES = [
  { value: "all", label: "All sources" },
  { value: "original", label: "Original" },
  { value: "repurposed", label: "Repurposed" },
  { value: "cross_post", label: "Cross-post" },
  { value: "repost", label: "Repost" },
];

// Provenance filter — distinguishes content created/edited inside H&S from
// items we pulled in from the platform after-the-fact (agency / manual posts).
// NULL createdVia (pre-2026-05-11 rows) is treated as "synced".
const ORIGINS = [
  { value: "all", label: "All origins" },
  { value: "hubandspoke", label: "Made in Hub & Spoke" },
  { value: "synced", label: "Synced from platform" },
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
  // whitespace-nowrap + shrink-0: pills keep their intrinsic width on phones
  // instead of wrapping their label onto two lines inside the pill.
  "inline-flex shrink-0 items-center gap-1.5 h-8 px-3 rounded-full border border-border bg-card text-sm whitespace-nowrap hover:bg-accent transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function PillContent({
  label,
  value,
  icon,
  reserve,
}: {
  label?: string;
  value: string;
  icon?: React.ReactNode;
  /** Text whose width the value slot always reserves (stacked invisibly
   *  under the value), so the pill doesn't resize — and the filter row
   *  doesn't re-wrap — as the value changes. */
  reserve?: string;
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
      {reserve ? (
        <span className="grid max-w-[10rem] text-foreground font-medium">
          <span aria-hidden className="invisible col-start-1 row-start-1 truncate">
            {reserve}
          </span>
          <span className="col-start-1 row-start-1 truncate">{value}</span>
        </span>
      ) : (
        <span className="text-foreground font-medium truncate max-w-[20rem]">
          {value}
        </span>
      )}
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

export function DateRangePill({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onDateRangeChange,
}: Pick<
  FilterPillsProps,
  | "startDate"
  | "endDate"
  | "onStartDateChange"
  | "onEndDateChange"
  | "onDateRangeChange"
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

  // Prefer the atomic setter when provided (avoids the
  // back-to-back-set race documented on FilterPillsProps.onDateRangeChange).
  function commit(s: string, e: string) {
    if (onDateRangeChange) {
      onDateRangeChange(s, e);
    } else {
      onStartDateChange(s);
      onEndDateChange(e);
    }
  }

  function applyPreset(value: string) {
    const r = resolvePreset(value);
    if (!r) return;
    const s = format(r.startDate, "yyyy-MM-dd");
    const e = format(r.endDate, "yyyy-MM-dd");
    commit(s, e);
    setOpen(false);
  }

  function applyCustom() {
    commit(draftStart, draftEnd);
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
  contentClassName,
}: {
  label?: string;
  value: string;
  options: { value: string; label: string; icon?: React.ReactNode }[];
  onChange: (v: string) => void;
  /** Overrides the popover width etc. — e.g. "w-96" for long labels. */
  contentClassName?: string;
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
        className={cn(
          "w-56 p-1 gap-0.5 max-h-[320px] overflow-y-auto",
          contentClassName
        )}
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

interface MultiOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  /** Small right-aligned tag, e.g. the post type on a channel row. */
  meta?: string;
}

/** Checklist dropdown shared by every multi-select filter. `value` is "all"
 *  or a comma-separated list (src/lib/multi-filter.ts). "All" shows every
 *  row ticked, so excluding one option is a single click; "Only" on a row
 *  picks just that one. Stays open while toggling, and the pill keeps a
 *  steady width so the popover doesn't jump. */
function MultiSelectPill({
  label,
  allLabel,
  value,
  options,
  onChange,
  searchPlaceholder = "Search…",
}: {
  label: string;
  allLabel: string;
  value: string;
  options: MultiOption[];
  onChange: (v: string) => void;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const optionValues = options.map((o) => o.value);
  const parsed = parseMultiFilter(value);
  const selected = optionValues.filter((v) => multiFilterAllows(parsed, v));
  const isAll = !parsed || selected.length === optionValues.length;

  const set = (next: string[]) => onChange(serializeMultiFilter(next, optionValues));
  const toggle = (v: string) =>
    set(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);

  let summary = allLabel;
  let icon: React.ReactNode | undefined;
  if (!isAll && selected.length === 1) {
    const only = options.find((o) => o.value === selected[0])!;
    summary = only.meta ? `${only.label} · ${only.meta}` : only.label;
    icon = only.icon;
  } else if (!isAll && selected.length > 1) {
    summary = `${selected.length} of ${options.length}`;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={PILL_TRIGGER_CLASSES}>
        <PillContent label={label} value={summary} icon={icon} reserve={allLabel} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command>
          {options.length > 7 && <CommandInput placeholder={searchPlaceholder} />}
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={`__all__ ${allLabel}`} onSelect={() => onChange("all")}>
                <span className="flex items-center gap-2 w-full">
                  <MultiCheckbox checked={isAll} />
                  <span className="text-sm font-medium">{allLabel}</span>
                </span>
              </CommandItem>
              {options.map((o) => {
                const checked = isAll || selected.includes(o.value);
                return (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.meta ?? ""} ${o.value}`}
                    onSelect={() => toggle(o.value)}
                    className="group"
                  >
                    <span className="flex items-center gap-2 w-full min-w-0">
                      <MultiCheckbox checked={checked} />
                      {o.icon}
                      <span className="text-sm truncate">{o.label}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            set([o.value]);
                          }}
                          className="hidden group-hover:inline text-[11px] font-medium text-muted-foreground hover:text-foreground"
                        >
                          Only
                        </button>
                        {o.meta && (
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {o.meta}
                          </span>
                        )}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function MultiCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "w-4 h-4 rounded border flex items-center justify-center shrink-0",
        checked ? "bg-primary border-primary" : "border-input"
      )}
    >
      {checked && <CheckIcon className="w-3 h-3 text-primary-foreground" strokeWidth={3} />}
    </span>
  );
}

// Canonical post types per platform for the Post type pill.
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

interface ChannelOption {
  key: string;
  account: FilterAccount;
  postType: PostType | null;
}

/** Every (account, post type) pair the given accounts publish to, narrowed
 *  by a post-type selection — one row per pair, same shape as the format
 *  page's Accounts picker. */
function channelOptionsFor(accounts: FilterAccount[], postTypes: MultiFilter | null): ChannelOption[] {
  const out: ChannelOption[] = [];
  const sorted = [...accounts].sort(
    (a, b) => a.platform.localeCompare(b.platform) || a.handle.localeCompare(b.handle)
  );
  for (const a of sorted) {
    const pts = PLATFORM_META[toPlatform(a.platform)].postTypes;
    for (const pt of pts.length ? pts : [null]) {
      if (pt && !multiFilterAllows(postTypes, pt)) continue;
      out.push({ key: channelKey({ accountId: a.id, postType: pt }), account: a, postType: pt });
    }
  }
  return out;
}

/** Accounts the Platform (and optionally Account) filters let through. */
function scopedAccounts(
  accounts: FilterAccount[],
  platforms: MultiFilter | null,
  accountIds: MultiFilter | null
): FilterAccount[] {
  return accounts.filter(
    (a) => multiFilterAllows(platforms, a.platform) && multiFilterAllows(accountIds, a.id)
  );
}

function postTypeOptsFor(platforms: MultiFilter | null) {
  return POST_TYPE_OPTS.filter((pt) => multiFilterAllows(platforms, pt.platform));
}

/** Re-express `value` against a new option list: keep whichever of the new
 *  options it allowed. Selections that dropped out of scope fall away, and
 *  a selection with nothing left collapses to "all". */
function rescope(value: string, nextOptions: string[]): string {
  const f = parseMultiFilter(value);
  if (!f) return "all";
  return serializeMultiFilter(
    nextOptions.filter((o) => multiFilterAllows(f, o)),
    nextOptions
  );
}

export function FilterPills({
  startDate,
  endDate,
  viewType,
  selectedGroupBy,
  showBrandGroup = false,
  selectedPlatformKey,
  selectedAccountId,
  selectedPostType,
  selectedChannels,
  selectedFormat,
  selectedSource,
  provenOnly = false,
  selectedOrigin,
  accounts,
  formats,
  showViewType = true,
  onStartDateChange,
  onEndDateChange,
  onDateRangeChange,
  onViewTypeChange,
  onGroupByChange,
  onScopeChange,
  onFormatChange,
  onSourceChange,
  onProvenOnlyChange,
  onOriginChange,
}: FilterPillsProps) {
  // Canonical platforms — fixed list that the `accounts.platform` column
  // takes values from. Mirrors PLATFORM_META ordering in src/lib/platforms.ts.
  const platformKeyOptions: MultiOption[] = [
    { value: "youtube", label: "YouTube", icon: <PlatformIcon platform="youtube" size={12} /> },
    { value: "instagram", label: "Instagram", icon: <PlatformIcon platform="instagram" size={12} /> },
    { value: "x", label: "X", icon: <PlatformIcon platform="x" size={12} /> },
    { value: "tiktok", label: "TikTok", icon: <PlatformIcon platform="tiktok" size={12} /> },
    { value: "linkedin", label: "LinkedIn", icon: <PlatformIcon platform="linkedin" size={12} /> },
    { value: "threads", label: "Threads", icon: <PlatformIcon platform="threads" size={12} /> },
    { value: "newsletter", label: "Newsletter", icon: <PlatformIcon platform="newsletter" size={12} /> },
    { value: "other", label: "Other", icon: <PlatformIcon platform="other" size={12} /> },
  ];

  // Cascade: Platform narrows Accounts and Post types; all three narrow
  // Channels. Each pill only offers options the pills before it allow.
  const platforms = parseMultiFilter(selectedPlatformKey);
  const accountOptions: MultiOption[] = scopedAccounts(accounts, platforms, null).map((a) => ({
    value: a.id,
    label: `@${a.handle}`,
    icon: (
      <AccountAvatar avatarUrl={a.avatarUrl} platform={a.platform} handle={a.handle} size={18} />
    ),
  }));
  const postTypeOptions: MultiOption[] = postTypeOptsFor(platforms).map((pt) => ({
    value: pt.value,
    label: pt.label,
    icon: <PlatformIcon platform={pt.platform} size={12} />,
  }));
  const channelOptions: MultiOption[] = channelOptionsFor(
    scopedAccounts(accounts, platforms, parseMultiFilter(selectedAccountId)),
    parseMultiFilter(selectedPostType)
  ).map((o) => ({
    value: o.key,
    label: `@${o.account.handle}`,
    icon: <PlatformIcon platform={o.account.platform} size={13} />,
    meta: o.postType ? POST_TYPE_SHORT_LABEL[o.postType] : undefined,
  }));
  const formatOptions: MultiOption[] = formats.map((f) => ({ value: f, label: f }));
  const sourceOptions: MultiOption[] = SOURCES.filter((o) => o.value !== "all");

  // Apply a change to one scope filter, re-scoping the pills after it
  // (Platform → Account / Post type → Channels) so they drop selections
  // that no longer fit, and emit it all as one patch.
  const changeScope = (patch: ScopePatch) => {
    const current: Required<ScopePatch> = {
      platform: selectedPlatformKey,
      accountId: selectedAccountId,
      postType: selectedPostType,
      channels: selectedChannels,
    };
    const next = { ...current, ...patch };
    const nextPlatforms = parseMultiFilter(next.platform);
    if (patch.platform !== undefined) {
      next.accountId = rescope(
        next.accountId,
        scopedAccounts(accounts, nextPlatforms, null).map((a) => a.id)
      );
      next.postType = rescope(next.postType, postTypeOptsFor(nextPlatforms).map((o) => o.value));
    }
    if (patch.channels === undefined) {
      next.channels = rescope(
        next.channels,
        channelOptionsFor(
          scopedAccounts(accounts, nextPlatforms, parseMultiFilter(next.accountId)),
          parseMultiFilter(next.postType)
        ).map((o) => o.key)
      );
    }
    const changed: ScopePatch = {};
    for (const k of Object.keys(current) as (keyof ScopePatch)[]) {
      if (next[k] !== current[k]) changed[k] = next[k];
    }
    if (Object.keys(changed).length) onScopeChange(changed);
  };

  // Group-by dimensions for the primary breakdown table. "Brand" is only
  // offered on the cross-brand /all view (single-brand grouping is a no-op).
  const groupByOptions = [
    ...(showBrandGroup ? [{ value: "brand", label: "Brand" }] : []),
    { value: "platform", label: "Platform" },
    { value: "account", label: "Account" },
    { value: "postType", label: "Post type" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {onGroupByChange && (
        <SelectPill
          label="Group by"
          value={selectedGroupBy ?? "platform"}
          options={groupByOptions}
          onChange={onGroupByChange}
        />
      )}
      <DateRangePill
        startDate={startDate}
        endDate={endDate}
        onStartDateChange={onStartDateChange}
        onEndDateChange={onEndDateChange}
        onDateRangeChange={onDateRangeChange}
      />
      {showViewType && (
        <SelectPill value={viewType} options={INTERVALS} onChange={onViewTypeChange} />
      )}
      <MultiSelectPill
        label="Platform"
        allLabel="All platforms"
        value={selectedPlatformKey}
        options={platformKeyOptions}
        onChange={(v) => changeScope({ platform: v })}
      />
      <MultiSelectPill
        label="Account"
        allLabel="All accounts"
        value={selectedAccountId}
        options={accountOptions}
        onChange={(v) => changeScope({ accountId: v })}
        searchPlaceholder="Search accounts…"
      />
      <MultiSelectPill
        label="Post type"
        allLabel="All post types"
        value={selectedPostType}
        options={postTypeOptions}
        onChange={(v) => changeScope({ postType: v })}
      />
      <MultiSelectPill
        label="Channels"
        allLabel="All channels"
        value={selectedChannels}
        options={channelOptions}
        onChange={(v) => changeScope({ channels: v })}
        searchPlaceholder="Search accounts…"
      />
      <MultiSelectPill
        label="Format"
        allLabel="All formats"
        value={selectedFormat}
        options={formatOptions}
        onChange={onFormatChange}
        searchPlaceholder="Search formats…"
      />
      <MultiSelectPill
        label="Source"
        allLabel="All sources"
        value={selectedSource}
        options={sourceOptions}
        onChange={onSourceChange}
      />
      {onProvenOnlyChange && (
        <button
          type="button"
          onClick={() => onProvenOnlyChange(!provenOnly)}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors",
            provenOnly
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
              : "border-border bg-card text-muted-foreground hover:text-foreground"
          )}
          aria-pressed={provenOnly}
          title="Filter charts to formats that have cleared the proven bar in the last 180 days"
        >
          {provenOnly && <CheckIcon className="size-3" />}
          Proven only
        </button>
      )}
      {onOriginChange && (
        <SelectPill
          label="Origin"
          value={selectedOrigin ?? "all"}
          options={ORIGINS}
          onChange={onOriginChange}
        />
      )}
    </div>
  );
}
