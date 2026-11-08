"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Dates a client component RENDERS from server-provided props.
 *
 * Why not `new Date(iso).toLocaleDateString()` in render: when the value comes
 * from the server (page props, `initialData`) it is in the server HTML. The
 * server formats in UTC and en-US; the browser formats in the user's timezone
 * and language. Every evening in the Americas they disagree on the date, so
 * React throws #418 (GlitchTip HUBANDSPOKE-6, /:brand/accounts, 2026-11-08).
 *
 * Same shape as `useToday()`: the server and hydration passes render a fixed
 * UTC/en-US form, then React re-renders with the user's own. Relative labels
 * ("5m ago") read `Date.now()`, so they wait for `useHydrated()` too.
 *
 * Data a component fetches after mount is not in the server HTML and can keep
 * calling `toLocaleDateString()` directly.
 */

export type LocalDateFormatter = (
  at: string | Date,
  options?: Intl.DateTimeFormatOptions,
) => string;

const noopSubscribe = () => () => {};

/** False for the server and hydration passes, true from then on. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function formatDisplayDate(
  at: string | Date,
  hydrated: boolean,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = new Date(at);
  return hydrated
    ? new Intl.DateTimeFormat(undefined, options).format(date)
    : new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
}

export function useLocalDate(): LocalDateFormatter {
  const hydrated = useHydrated();
  return useCallback(
    (at, options) => formatDisplayDate(at, hydrated, options),
    [hydrated],
  );
}
