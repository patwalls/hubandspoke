"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangleIcon } from "lucide-react";

// Path segments that are never a brand slug — skip polling on them. "all" is a
// real route but the aggregate view shouldn't carry a per-brand banner.
const NON_BRAND_SEGMENTS = new Set(["all", "admin", "settings"]);

/**
 * Amber banner, shown only on a specific brand's pages, when that brand has
 * Scheduled posts we couldn't auto-mark as published (flagged "needs
 * attention"). Nudges the operator to open the Scheduled tab and paste the
 * live link so the post doesn't sit there for days.
 *
 * Mirrors ScCreditsBanner: client component, polls every 60s, renders null in
 * the common (count === 0) case. Brand comes from the URL, so one mount in the
 * shared dashboard layout serves every brand.
 */
export function ScheduledAttentionBanner() {
  const pathname = usePathname();
  const brand = pathname.split("/").filter(Boolean)[0] ?? "";
  const active = brand.length > 0 && !NON_BRAND_SEGMENTS.has(brand);

  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active) {
      setCount(0);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/scheduled-needs-attention?brand=${encodeURIComponent(brand)}`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as { count?: number };
        if (!cancelled) setCount(Number(json?.count ?? 0));
      } catch {
        // Silent — never crash the dashboard on a flaky status fetch.
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active, brand]);

  if (!active || count < 1) return null;

  return (
    <Link
      href={`/${brand}/scheduled`}
      className="mb-3 sm:mb-4 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 transition-colors hover:border-amber-300 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <AlertTriangleIcon className="size-4 mt-0.5 shrink-0 text-amber-600" />
      <div className="flex-1 min-w-0">
        <div className="font-medium">
          {`${count} scheduled post${count === 1 ? "" : "s"} couldn't be marked as published.`}
        </div>
        <div className="mt-0.5 text-xs text-amber-800 dark:text-amber-200">
          {`We couldn't auto-detect ${count === 1 ? "it" : "them"} going live. Review and add the publish link →`}
        </div>
      </div>
    </Link>
  );
}
