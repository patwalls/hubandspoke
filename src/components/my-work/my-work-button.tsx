"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackUsage } from "@/lib/usage/track";

// Re-read the count on navigation, but not more than once a minute: every
// fetch is a router log line (docs/automation.md → Log volume). No timer.
const MIN_REFRESH_MS = 60_000;

/**
 * Header button to My Work with the number of things waiting on you (your
 * turn + to review — src/lib/my-work/split.ts).
 */
export function MyWorkButton() {
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const lastFetch = useRef(0);

  useEffect(() => {
    const now = Date.now();
    if (now - lastFetch.current < MIN_REFRESH_MS) return;
    lastFetch.current = now;
    // No cancel-on-cleanup: with the throttle, a cancelled fetch (React's dev
    // double-run, a quick second navigation) would leave the badge empty.
    void (async () => {
      try {
        const res = await fetch("/api/my-work/count");
        if (!res.ok) return;
        const json = (await res.json()) as { count?: number };
        setCount(Number(json?.count ?? 0));
      } catch {
        // A missing badge is fine; never break the nav over it.
      }
    })();
  }, [pathname]);

  const active = pathname === "/my-work";
  return (
    <Link
      href="/my-work"
      onClick={() => trackUsage("my-work:header")}
      data-testid="my-work-button"
      aria-label={count > 0 ? `My Work, ${count} waiting on you` : "My Work"}
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs transition-colors hover:text-foreground hover:bg-accent",
        active ? "text-foreground bg-accent" : "text-muted-foreground",
      )}
    >
      <ListChecks className="size-3.5" />
      <span className="hidden sm:inline">My Work</span>
      {count > 0 && (
        <span
          data-testid="my-work-count"
          className="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground tabular-nums"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
