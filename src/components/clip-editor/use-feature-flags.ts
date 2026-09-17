"use client";

import { useEffect, useState } from "react";
import type { FeatureFlag } from "@/lib/feature-flags";

type Flags = Record<FeatureFlag, boolean>;

/**
 * Module-level cache: the queue mounts one clip dialog PER ROW, so without
 * this a 50-row queue would fire 50 identical requests. One in-flight promise
 * is shared by every caller for the lifetime of the page.
 */
let cached: Flags | null = null;
let inflight: Promise<Flags | null> | null = null;

function load(): Promise<Flags | null> {
  if (!inflight) {
    inflight = fetch("/api/feature-flags")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { flags?: Flags } | null) => {
        cached = json?.flags ?? null;
        return cached;
      })
      .catch(() => null);
  }
  return inflight;
}

/**
 * Feature flags for the signed-in user. `null` while loading or on error —
 * callers MUST treat null as "every flag off", so a failed or slow request
 * can only ever show the existing UI, never the unreleased one.
 */
export function useFeatureFlags(): Flags | null {
  const [flags, setFlags] = useState<Flags | null>(cached);
  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    void load().then((f) => {
      if (!cancelled) setFlags(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return flags;
}
