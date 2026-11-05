"use client";

import { useSyncExternalStore } from "react";
import type { FeatureFlag } from "@/lib/feature-flags";

type Flags = Record<FeatureFlag, boolean>;

/**
 * Module-level cache: the queue mounts one clip dialog PER ROW, so without
 * this a 50-row queue would fire 50 identical requests. One in-flight promise
 * is shared by every caller for the lifetime of the page.
 */
let cached: Flags | null = null;
let inflight: Promise<Flags | null> | null = null;
const listeners = new Set<() => void>();

export function loadFeatureFlags(): Promise<Flags | null> {
  if (!inflight) {
    inflight = fetch("/api/feature-flags")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { flags?: Flags } | null) => {
        cached = json?.flags ?? null;
        return cached;
      })
      .catch(() => null)
      .then((flags) => {
        for (const notify of listeners) notify();
        return flags;
      });
  }
  return inflight;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  void loadFeatureFlags();
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Feature flags for the signed-in user. `null` while loading or on error —
 * callers MUST treat null as "every flag off", so a failed or slow request
 * can only ever show the existing UI, never the unreleased one.
 *
 * useSyncExternalStore, NOT useState(cached): the server always renders with
 * no flags, and a Suspense boundary that hydrates after the fetch resolved
 * would otherwise start from the warm cache and render flag-on markup over
 * flag-off HTML — React #418 (GlitchTip HUBANDSPOKE-4, /:brand/queue,
 * 2026-11-05). The server snapshot is what hydration renders; React then
 * re-renders with the real flags.
 */
export function useFeatureFlags(): Flags | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getSnapshot(): Flags | null {
  return cached;
}

function getServerSnapshot(): Flags | null {
  return null;
}
