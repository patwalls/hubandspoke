"use client";

import { useMemo, useSyncExternalStore } from "react";
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

export function useToday(): Today {
  const snapshot = useSyncExternalStore(
    noopSubscribe,
    clientTodaySnapshot,
    serverTodaySnapshot,
  );
  return useMemo(() => {
    const [key, inclusiveOfUtc] = snapshot.split("|");
    return { date: parse(key, "yyyy-MM-dd", new Date()), key, inclusiveOfUtc };
  }, [snapshot]);
}
