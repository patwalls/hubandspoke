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
} from "lucide-react";
import {
  recordVisit,
  useFrequent,
  useRecents,
  type RecordVisitInput,
} from "@/lib/hooks/use-recent-items";

type ContentHit = {
  id: string;
  title: string | null;
  format: string | null;
  platform: string[] | null;
  status: string | null;
  publishedDate: string | null;
};

type FormatHit = {
  id: string;
  name: string;
  channels: string[] | null;
};

type SearchResponse = {
  content: ContentHit[];
  formats: FormatHit[];
};

const EMPTY: SearchResponse = { content: [], formats: [] };

const QUICK_NAV = [
  { slug: "", label: "Dashboard" },
  { slug: "content", label: "Content" },
  { slug: "production", label: "Production" },
  { slug: "queue", label: "Queue" },
  { slug: "formats", label: "Formats" },
] as const;

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
  const recents = useRecents(brand);
  const frequent = useFrequent(brand);

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

  function contentHref(id: string) {
    return `/${brand}/content/${id}`;
  }
  function formatHref(id: string) {
    return `/${brand}/formats/${id}`;
  }

  const showEmptyState = !trimmed;
  const hasResults = results.content.length > 0 || results.formats.length > 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Global search"
      description="Search content, formats, and navigate anywhere."
    >
      <Command shouldFilter={false} loop>
        <CommandInput
          placeholder="Search content, formats, or jump to a page…"
          value={query}
          onValueChange={setQuery}
          autoFocus
        />
        <CommandList>
          {showEmptyState ? (
            <EmptyStateGroups
              brand={brand}
              recents={recents}
              frequent={frequent}
              onSelect={handleSelect}
              onNavigate={(href) => {
                router.push(href);
                handleOpenChange(false);
              }}
            />
          ) : (
            <>
              {!loading && !hasResults && (
                <CommandEmpty>No results for &ldquo;{trimmed}&rdquo;</CommandEmpty>
              )}
              {results.content.length > 0 && (
                <CommandGroup heading="Content">
                  {results.content.map((hit) => {
                    const title = hit.title ?? "(untitled)";
                    const subtitle = [hit.format, hit.platform?.join(" · ")]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <CommandItem
                        key={`content-${hit.id}`}
                        value={`content-${hit.id}-${title}`}
                        onSelect={() =>
                          handleSelect({
                            kind: "content",
                            id: hit.id,
                            title,
                            subtitle: subtitle || undefined,
                            brand,
                            href: contentHref(hit.id),
                          })
                        }
                      >
                        <FileText className="text-muted-foreground" />
                        <ItemLines title={title} subtitle={subtitle} />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
              {results.formats.length > 0 && (
                <CommandGroup heading="Formats">
                  {results.formats.map((hit) => {
                    const subtitle = hit.channels?.join(" · ") ?? undefined;
                    return (
                      <CommandItem
                        key={`format-${hit.id}`}
                        value={`format-${hit.id}-${hit.name}`}
                        onSelect={() =>
                          handleSelect({
                            kind: "format",
                            id: hit.id,
                            title: hit.name,
                            subtitle,
                            brand,
                            href: formatHref(hit.id),
                          })
                        }
                      >
                        <LayoutGrid className="text-muted-foreground" />
                        <ItemLines title={hit.name} subtitle={subtitle} />
                      </CommandItem>
                    );
                  })}
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
              <Clock className="text-muted-foreground" />
              <ItemLines title={item.title} subtitle={item.subtitle} />
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
              <ItemLines title={item.title} subtitle={item.subtitle} />
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      <CommandGroup heading="Jump to…">
        {QUICK_NAV.map((entry) => {
          const href = entry.slug ? `/${brand}/${entry.slug}` : `/${brand}`;
          return (
            <CommandItem
              key={`nav-${entry.slug || "root"}`}
              value={`nav-${entry.slug || "root"}`}
              onSelect={() => onNavigate(href)}
            >
              <Compass className="text-muted-foreground" />
              <ItemLines title={entry.label} subtitle={href} />
            </CommandItem>
          );
        })}
        <CommandItem
          value="nav-settings"
          onSelect={() => onNavigate("/settings")}
        >
          <Compass className="text-muted-foreground" />
          <ItemLines title="Settings" subtitle="/settings" />
        </CommandItem>
      </CommandGroup>
    </>
  );
}

function ItemLines({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate">{title}</span>
      {subtitle ? (
        <span className="truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}
