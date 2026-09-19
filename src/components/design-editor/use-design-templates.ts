"use client";

import { useEffect, useState } from "react";

/**
 * Which formats the design editor can draft (stored template or built-in
 * preset). Module-level cache for the same reason as useFeatureFlags: the
 * queue mounts one dialog per row. `null` while loading → callers treat it
 * as "no format" so a slow request only ever shows the classic UI.
 */
let cached: Set<string> | null = null;
let inflight: Promise<Set<string> | null> | null = null;

function load(): Promise<Set<string> | null> {
  if (!inflight) {
    inflight = fetch("/api/design/templates")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { formats?: string[] } | null) => {
        cached = json ? new Set(json.formats ?? []) : null;
        return cached;
      })
      .catch(() => null);
  }
  return inflight;
}

/** `enabled` = the user has the flag; unflagged users never make the call. */
export function useDesignTemplates(enabled: boolean): Set<string> | null {
  const [set, setSet] = useState<Set<string> | null>(cached);
  useEffect(() => {
    if (!enabled || cached) return;
    let cancelled = false;
    void load().then((s) => {
      if (!cancelled) setSet(s);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? set : null;
}

/** Forget the cache (after a template is created/removed on the format page). */
export function invalidateDesignTemplates(): void {
  cached = null;
  inflight = null;
}
