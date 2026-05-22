"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Persist the current list-page URL (pathname + search) to sessionStorage
 * so a sibling `<BackLink>` on a detail page can restore the user to the
 * exact filtered view they came from.
 *
 * Why sessionStorage rather than `router.back()` or `document.referrer`:
 *   - `router.back()` returns to *whatever* page was last in browser
 *     history, which is often wrong when the user took a detour
 *     (Content → Settings → Detail → "← Content" should land on the
 *     filtered Content list, not Settings).
 *   - `document.referrer` is empty on detail-page reload and unreliable
 *     across tab restorations.
 *   - sessionStorage is tab-scoped, survives intermediate navigation,
 *     and degrades cleanly (deep-link / new-tab / cleared storage just
 *     falls back to the hardcoded path on the BackLink).
 *
 * Brand-scoped key so switching brands via the brand picker doesn't
 * leak a "last content list" memory across brands.
 */
export function useRememberListUrl(args: {
  brand: string;
  /** Stable identifier for the list type — `"content"`, `"formats"`,
   *  `"production"`, `"queue"`, … — matched by the consumer
   *  `<BackLink listKey={...}>`. */
  listKey: string;
}) {
  const { brand, listKey } = args;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = searchParams.toString();
    const href = qs ? `${pathname}?${qs}` : pathname;
    try {
      window.sessionStorage.setItem(
        `hubspoke:lastList:${brand}:${listKey}`,
        href,
      );
    } catch {
      // Private mode / quota — non-fatal, the BackLink just uses its
      // fallback href.
    }
  }, [brand, listKey, pathname, searchParams]);
}
