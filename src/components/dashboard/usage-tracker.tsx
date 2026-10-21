"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Records one `usage_events` row per screen the user lands on (route +
 * allowlisted params; the server normalizes it with screenFor). Mounted once
 * in the dashboard layout. Skips repeats of the same URL, e.g. a re-render or
 * a param the server would drop anyway.
 */
export function UsageTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const last = useRef<string | null>(null);

  useEffect(() => {
    const key = `${pathname}?${search}`;
    if (last.current === key) return;
    last.current = key;
    void fetch("/api/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pathname, search: search ? `?${search}` : "" }),
      keepalive: true,
    }).catch(() => {});
  }, [pathname, search]);

  return null;
}
