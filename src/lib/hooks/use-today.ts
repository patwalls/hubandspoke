"use client";

import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { parse } from "date-fns";
import { todayInclusiveOfUtc } from "@/lib/dates";

/**
 * "Today" for anything a client component RENDERS (default date filters,
 * preset labels like "Last 90 days").
 *
 * Why not `new Date()` in render: the server renders in UTC, the browser in
 * the user's timezone. Every evening in the Americas (after 00:00 UTC) the two
 * disagree on the date, so the server HTML says "Aug 8 – Nov 6" while the
 * browser's first render says "Last 90 days" and React throws #418 (GlitchTip
 * HUBANDSPOKE-5, /:brand — 2026-11-06).
 *
 * The server snapshot is the UTC date, which the server and the browser's
 * hydration pass compute identically. React then re-renders with the real
 * local date straight after hydration. Event handlers can still call
 * `new Date()` freely; only render output needs this.
 *
 * The server snapshot is the SERVER's date, sent down by <ServerTodayProvider>
 * in the dashboard layout — not the UTC date read off the browser's clock at
 * hydration time. Hydration can run long after the server rendered: a tab
 * opened in the background and frozen by Chrome hydrated ~20 hours later,
 * after UTC midnight, so the hydration pass's "today" was a day ahead of the
 * HTML's and the Date range label differed (GlitchTip issue 78,
 * /:brand/content, 2026-11-17). A slow stream across 00:00 UTC does the same.
 */

export interface Today {
  /** Local midnight of the render-safe date. Feed it to date-fns helpers. */
  date: Date;
  /** `yyyy-MM-dd` of `date`. */
  key: string;
  /** `todayInclusiveOfUtc()` — the report APIs' default upper bound. */
  inclusiveOfUtc: string;
}

const noopSubscribe = () => () => {};

function utcKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Snapshots are strings so React compares them by value. */
export function clientTodaySnapshot(): string {
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${local}|${todayInclusiveOfUtc()}`;
}

export function serverTodaySnapshot(): string {
  const utc = utcKey();
  return `${utc}|${utc}`;
}

/** The server's UTC `yyyy-MM-dd` at render time; null outside a provider. */
const ServerTodayContext = createContext<string | null>(null);

/**
 * Wraps every page that renders `useToday()`. Pass the date the server is
 * rendering on (`new Date().toISOString().slice(0, 10)`); it travels to the
 * browser in the RSC payload, so hydration reads the same value.
 */
export function ServerTodayProvider({
  utcDate,
  children,
}: {
  utcDate: string;
  children?: ReactNode;
}) {
  return createElement(ServerTodayContext, { value: utcDate }, children);
}

export function useToday(): Today {
  const serverDate = useContext(ServerTodayContext);
  const snapshot = useSyncExternalStore(
    noopSubscribe,
    clientTodaySnapshot,
    serverDate ? () => `${serverDate}|${serverDate}` : serverTodaySnapshot,
  );
  return useMemo(() => {
    const [key, inclusiveOfUtc] = snapshot.split("|");
    return { date: parse(key, "yyyy-MM-dd", new Date()), key, inclusiveOfUtc };
  }, [snapshot]);
}
