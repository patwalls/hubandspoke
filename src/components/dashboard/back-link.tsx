"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** Brand slug for this detail page — must match the brand whose list
   *  page mounted `useRememberListUrl`. Used both for the storage key and
   *  to scope the fallback (so a starter-story detail's "← Content" can
   *  never accidentally land on /matg/content). */
  brand: string;
  /** Stable identifier for the list type — must match the
   *  `useRememberListUrl({ listKey })` call on the corresponding list
   *  page. E.g. `"content"`, `"formats"`, `"production"`, `"queue"`. */
  listKey: string;
  /** Where to link to when no remembered URL exists (deep-link / new
   *  tab / cleared session). Typically the bare list path,
   *  `/${brand}/${listKey}` — the user simply gets the unfiltered view,
   *  which is the right behavior for a session that never had filters
   *  to remember. */
  fallbackHref: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Back-link that lands the user on the exact filtered list URL they
 * came from. Reads the sessionStorage entry written by
 * `useRememberListUrl` on the corresponding list page; falls back to a
 * hardcoded list path when nothing is stored (deep-link, new tab,
 * private mode, etc.).
 *
 * Renders during SSR with `fallbackHref` and then upgrades on mount to
 * the remembered URL — so the link is always usable from the very
 * first paint, the worst case being one rapid click before hydration
 * that lands on the unfiltered list.
 */
export function BackLink({
  brand,
  listKey,
  fallbackHref,
  children,
  className,
}: Props) {
  const [href, setHref] = useState(fallbackHref);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.sessionStorage.getItem(
        `hubspoke:lastList:${brand}:${listKey}`,
      );
      // Defensive: only accept relative same-app paths. Anything else
      // (absolute URL, javascript:, stray bytes) falls through to
      // fallbackHref so a corrupt session can't redirect the user
      // somewhere unexpected.
      if (stored && stored.startsWith("/") && !stored.startsWith("//")) {
        setHref(stored);
      }
    } catch {
      // sessionStorage access can throw in private modes — keep fallback.
    }
  }, [brand, listKey]);
  return (
    <Link href={href} className={cn(className)}>
      {children}
    </Link>
  );
}
