"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackUsage } from "@/lib/usage/track";
import {
  DERIVATIVES_SORT_KEY,
  parseDerivativesSort,
  toggleDerivativesSort,
  type DerivativesSort,
} from "@/lib/derivatives-sort";

/**
 * The Derivatives tab's sort, remembered per browser. Starts on "default"
 * for the server render and the first paint, then picks up the stored choice
 * (reading localStorage during render would mismatch hydration).
 */
export function useDerivativesSort(brand: string): [DerivativesSort, (col: Exclude<DerivativesSort, "default">) => void] {
  const [sort, setSort] = useState<DerivativesSort>("default");
  useEffect(() => {
    try {
      setSort(parseDerivativesSort(window.localStorage.getItem(DERIVATIVES_SORT_KEY)));
    } catch {
      // storage blocked: keep the default
    }
  }, []);
  const choose = useCallback(
    (col: Exclude<DerivativesSort, "default">) => {
      // Side effects outside the state updater (StrictMode runs updaters twice).
      const next = toggleDerivativesSort(sort, col);
      setSort(next);
      try {
        if (next === "default") window.localStorage.removeItem(DERIVATIVES_SORT_KEY);
        else window.localStorage.setItem(DERIVATIVES_SORT_KEY, next);
      } catch {
        // storage blocked: the sort still applies for this visit
      }
      trackUsage(`derivatives:sort:${next}`, brand);
    },
    [brand, sort],
  );
  return [sort, choose];
}

/** A Derivatives table header that sorts by its column on click. */
export function DerivativesSortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: Exclude<DerivativesSort, "default">;
  sort: DerivativesSort;
  onSort: (col: Exclude<DerivativesSort, "default">) => void;
  className?: string;
}) {
  const active = sort === column;
  return (
    <th
      className={cn(
        "px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap",
        className,
      )}
      aria-sort={active ? "descending" : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wider hover:text-foreground transition-colors",
          active && "text-foreground",
        )}
        title={active ? "Back to the usual order" : `Sort by ${label.toLowerCase()}, highest first`}
      >
        {label}
        {active && <ArrowDownIcon className="h-3 w-3" aria-hidden />}
      </button>
    </th>
  );
}
