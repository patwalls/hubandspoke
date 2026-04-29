"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { XIcon, LinkIcon, ChevronsUpDownIcon, ExternalLinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
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

export interface PillarOption {
  id: string;
  title: string | null;
  format: string | null;
  status?: string | null;
}

interface PillarPickerProps {
  brand: string;
  excludeId: string;
  value: PillarOption | null;
  onChange: (next: PillarOption | null) => void;
  triggerClassName?: string;
  placeholder?: string;
  /** Include items that aren't Notion-synced. Default false (pillars are
   *  Notion-authoritative); set true for reposted-from where the source
   *  may be a discovered Threads/IG post. */
  includeAll?: boolean;
}

export function PillarPicker({
  brand,
  excludeId,
  value,
  onChange,
  triggerClassName,
  placeholder = "No pillar — click to choose…",
  includeAll = false,
}: PillarPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PillarOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const run = async () => {
        setLoading(true);
        try {
          const params = new URLSearchParams({ brand, excludeId });
          if (query.trim()) params.set("q", query.trim());
          if (includeAll) params.set("includeAll", "1");
          const res = await fetch(`/api/production-items/search?${params}`);
          if (!res.ok) {
            setResults([]);
            return;
          }
          const json = await res.json();
          setResults(json.items || []);
        } catch {
          setResults([]);
        } finally {
          setLoading(false);
        }
      };
      run();
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, query, brand, excludeId, includeAll]);

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            "flex-1 flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-left hover:bg-accent/50 transition-colors min-w-0",
            triggerClassName
          )}
        >
          {value ? (
            <span className="flex items-center gap-2 min-w-0">
              <LinkIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{value.title || "(Untitled)"}</span>
              {value.format && (
                <span className="text-xs text-muted-foreground shrink-0">
                  · {value.format}
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDownIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[min(520px,90vw)]" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search by title…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              {loading && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  Searching…
                </div>
              )}
              {!loading && results.length === 0 && (
                <CommandEmpty>No matches.</CommandEmpty>
              )}
              {!loading && results.length > 0 && (
                <CommandGroup>
                  {results.map((r) => (
                    <CommandItem
                      key={r.id}
                      value={r.id}
                      onSelect={() => {
                        onChange(r);
                        setOpen(false);
                      }}
                    >
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="truncate">{r.title || "(Untitled)"}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {[r.format, r.status].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && (
        <>
          <Link
            href={`/${brand}/content/${value.id}`}
            title="Open pillar"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "shrink-0"
            )}
          >
            <ExternalLinkIcon className="w-3.5 h-3.5" />
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(null)}
            title="Clear pillar"
            className="shrink-0"
          >
            <XIcon className="w-3.5 h-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
