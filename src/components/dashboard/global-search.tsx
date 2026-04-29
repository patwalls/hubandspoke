"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Clock,
  Compass,
  FileText,
  LayoutGrid,
  Sparkles,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { statusClassFromToken, statusClass } from "@/lib/badge-colors";
import { AccountBadge } from "@/components/ui/account-badge";
import {
  recordVisit,
  useFrequent,
  useRecents,
  type RecordVisitInput,
} from "@/lib/hooks/use-recent-items";

type SearchAccount = {
  id: string;
  platform: string;
  handle: string;
  displayName: string | null;
};

type ContentHit = {
  id: string;
  title: string | null;
  format: string | null;
  postType: string | null;
  status: string | null;
  // Color token (e.g. "yellow") resolved server-side from the brand's
  // status palette; null when the hit's status isn't in the palette.
  statusColor: string | null;
  publishedDate: string | null;
  views: number | null;
  account: SearchAccount | null;
};

type FormatHit = {
  id: string;
  name: string;
  channels: Array<{
    postType: string | null;
    account: SearchAccount;
  }> | null;
};

type SearchResponse = {
  content: ContentHit[];
  formats: FormatHit[];
};

const EMPTY: SearchResponse = { content: [], formats: [] };

type NavEntry = { slug: string; label: string; href: (brand: string) => string };

const QUICK_NAV: NavEntry[] = [
  { slug: "", label: "Dashboard", href: (b) => `/${b}` },
  { slug: "content", label: "Content", href: (b) => `/${b}/content` },
  { slug: "production", label: "Production", href: (b) => `/${b}/production` },
  { slug: "queue", label: "Queue", href: (b) => `/${b}/queue` },
  { slug: "formats", label: "Formats", href: (b) => `/${b}/formats` },
  { slug: "my-work", label: "My Work", href: () => `/my-work` },
  { slug: "settings", label: "Settings", href: () => `/settings` },
];

function formatCompact(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function formatShortDate(d: string | null): string | null {
  if (!d) return null;
  const date = new Date(d + "T00:00:00");
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "2-digit",
  });
}

export function GlobalSearch({
  open,
  onOpenChange,
  brand,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brand: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse>(EMPTY);
  const [loading, setLoading] = useState(false);
  const recents = useRecents(brand, 6);
  const frequent = useFrequent(brand, 6);

  const trimmed = query.trim();
  const abortRef = useRef<AbortController | null>(null);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setQuery("");
      setResults(EMPTY);
      setLoading(false);
      abortRef.current?.abort();
    }
    onOpenChange(next);
  }

  useEffect(() => {
    if (!open || !trimmed) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      fetch(
        `/api/search?brand=${encodeURIComponent(brand)}&q=${encodeURIComponent(trimmed)}`,
        { signal: controller.signal },
      )
        .then((r) => (r.ok ? r.json() : EMPTY))
        .then((data: SearchResponse) => {
          if (controller.signal.aborted) return;
          setResults(data ?? EMPTY);
          setLoading(false);
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          setResults(EMPTY);
          setLoading(false);
        });
    }, 150);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [trimmed, brand, open]);

  function handleSelect(input: RecordVisitInput) {
    recordVisit(input);
    router.push(input.href);
    handleOpenChange(false);
  }

  function navigate(href: string) {
    router.push(href);
    handleOpenChange(false);
  }

  const showEmptyState = !trimmed;
  const hasResults = results.content.length > 0 || results.formats.length > 0;
  const navMatches = trimmed
    ? QUICK_NAV.filter((entry) =>
        entry.label.toLowerCase().includes(trimmed.toLowerCase()),
      )
    : [];

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Global search"
      description="Search content, formats, and navigate anywhere."
      className="sm:max-w-2xl!"
    >
      <Command shouldFilter={false} loop>
        <CommandInput
          placeholder="Search content, formats, or jump to a page…"
          value={query}
          onValueChange={setQuery}
          autoFocus
        />
        <CommandList className="max-h-[440px]!">
          {showEmptyState ? (
            <EmptyStateGroups
              brand={brand}
              recents={recents}
              frequent={frequent}
              onSelect={handleSelect}
              onNavigate={navigate}
            />
          ) : (
            <>
              {loading && !hasResults && (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Searching…
                </div>
              )}
              {!loading && !hasResults && navMatches.length === 0 && (
                <CommandEmpty>No results for &ldquo;{trimmed}&rdquo;</CommandEmpty>
              )}
              {navMatches.length > 0 && (
                <CommandGroup heading="Navigate">
                  {navMatches.map((entry) => {
                    const href = entry.href(brand);
                    return (
                      <CommandItem
                        key={`nav-match-${entry.slug || "root"}`}
                        value={`nav-match-${entry.slug || "root"}`}
                        onSelect={() => navigate(href)}
                      >
                        <Compass className="text-muted-foreground" />
                        <RowBody title={entry.label} meta={href} />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
              {results.content.length > 0 && (
                <CommandGroup
                  heading={`Content${loading ? " · updating…" : ""}`}
                >
                  {results.content.map((hit) => {
                    const title = hit.title ?? "(untitled)";
                    return (
                      <CommandItem
                        key={`content-${hit.id}`}
                        value={`content-${hit.id}-${title}`}
                        onSelect={() =>
                          handleSelect({
                            kind: "content",
                            id: hit.id,
                            title,
                            subtitle: [
                              hit.format,
                              hit.account ? `@${hit.account.handle}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") || undefined,
                            brand,
                            href: `/${brand}/content/${hit.id}`,
                          })
                        }
                      >
                        <FileText className="text-muted-foreground" />
                        <ContentRow hit={hit} title={title} />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
              {results.formats.length > 0 && (
                <CommandGroup heading="Formats">
                  {results.formats.map((hit) => (
                    <CommandItem
                      key={`format-${hit.id}`}
                      value={`format-${hit.id}-${hit.name}`}
                      onSelect={() =>
                        handleSelect({
                          kind: "format",
                          id: hit.id,
                          title: hit.name,
                          subtitle:
                            hit.channels
                              ?.map((c) => `@${c.account.handle}`)
                              .join(" · ") || undefined,
                          brand,
                          href: `/${brand}/formats/${hit.id}`,
                        })
                      }
                    >
                      <LayoutGrid className="text-muted-foreground" />
                      <FormatRow hit={hit} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

function EmptyStateGroups({
  brand,
  recents,
  frequent,
  onSelect,
  onNavigate,
}: {
  brand: string;
  recents: ReturnType<typeof useRecents>;
  frequent: ReturnType<typeof useFrequent>;
  onSelect: (input: RecordVisitInput) => void;
  onNavigate: (href: string) => void;
}) {
  return (
    <>
      {recents.length > 0 && (
        <CommandGroup heading="Recently visited">
          {recents.map((item) => (
            <CommandItem
              key={`recent-${item.kind}-${item.id}`}
              value={`recent-${item.kind}-${item.id}`}
              onSelect={() =>
                onSelect({
                  kind: item.kind,
                  id: item.id,
                  title: item.title,
                  subtitle: item.subtitle,
                  brand: item.brand,
                  href: item.href,
                })
              }
            >
              {item.kind === "content" ? (
                <FileText className="text-muted-foreground" />
              ) : (
                <LayoutGrid className="text-muted-foreground" />
              )}
              <RowBody
                title={item.title}
                meta={item.subtitle}
                right={
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock className="size-3" />
                    {relativeTime(item.lastVisitedAt)}
                  </span>
                }
              />
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {frequent.length > 0 && (
        <CommandGroup heading="Frequent">
          {frequent.map((item) => (
            <CommandItem
              key={`freq-${item.kind}-${item.id}`}
              value={`freq-${item.kind}-${item.id}`}
              onSelect={() =>
                onSelect({
                  kind: item.kind,
                  id: item.id,
                  title: item.title,
                  subtitle: item.subtitle,
                  brand: item.brand,
                  href: item.href,
                })
              }
            >
              <Sparkles className="text-muted-foreground" />
              <RowBody
                title={item.title}
                meta={item.subtitle}
                right={
                  <span className="text-[11px] text-muted-foreground">
                    {item.visitCount} visit{item.visitCount === 1 ? "" : "s"}
                  </span>
                }
              />
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      <CommandGroup heading="Jump to…">
        {QUICK_NAV.map((entry) => {
          const href = entry.href(brand);
          return (
            <CommandItem
              key={`nav-${entry.slug || "root"}`}
              value={`nav-${entry.slug || "root"}`}
              onSelect={() => onNavigate(href)}
            >
              <Compass className="text-muted-foreground" />
              <RowBody title={entry.label} meta={href} />
            </CommandItem>
          );
        })}
      </CommandGroup>
    </>
  );
}

function ContentRow({ hit, title }: { hit: ContentHit; title: string }) {
  const date = formatShortDate(hit.publishedDate);
  const views = formatCompact(hit.views);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{title}</span>
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {hit.status ? (
            <span
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                hit.statusColor
                  ? statusClassFromToken(hit.statusColor)
                  : statusClass(hit.status),
              )}
            >
              {hit.status}
            </span>
          ) : null}
          {hit.format ? (
            <span className="shrink-0 truncate text-[11px] text-muted-foreground">
              {hit.format}
            </span>
          ) : null}
          <AccountBadge
            account={hit.account}
            postType={hit.postType}
            variant="compact"
            size={11}
          />
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {views ? (
          <span className="text-[11px] font-medium tabular-nums text-foreground">
            {views} views
          </span>
        ) : null}
        {date ? (
          <span className="text-[10px] text-muted-foreground">{date}</span>
        ) : null}
      </div>
    </div>
  );
}

function FormatRow({ hit }: { hit: FormatHit }) {
  const channels = hit.channels ?? [];
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{hit.name}</span>
        {channels.length > 0 ? (
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {channels.slice(0, 4).map((c) => (
              <AccountBadge
                key={`${c.account.id}:${c.postType ?? ""}`}
                account={c.account}
                postType={c.postType}
                variant="compact"
                size={11}
              />
            ))}
            {channels.length > 4 ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                +{channels.length - 4}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">No channels</span>
        )}
      </div>
    </div>
  );
}

function RowBody({
  title,
  meta,
  right,
}: {
  title: string;
  meta?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{title}</span>
        {meta ? (
          <span className="truncate text-[11px] text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}
