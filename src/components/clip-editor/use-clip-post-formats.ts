"use client";

import { useEffect, useState } from "react";

/**
 * Which formats' Repurposed-queue candidates open in the clip editor, post
 * first (video posts on X). Module-level cache like useDesignTemplates: the
 * queue mounts one dialog per row. `null` while loading → callers show the
 * classic UI.
 */
const cached = new Map<string, Set<string>>();
const inflight = new Map<string, Promise<Set<string> | null>>();

function load(brand: string): Promise<Set<string> | null> {
  let p = inflight.get(brand);
  if (!p) {
    p = fetch(`/api/clip-editor/post-formats?brand=${encodeURIComponent(brand)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { formats?: string[] } | null) => {
        if (!json) return null;
        const set = new Set(json.formats ?? []);
        cached.set(brand, set);
        return set;
      })
      .catch(() => null);
    inflight.set(brand, p);
  }
  return p;
}

/** `enabled` = the user has the `clipEditor` flag. */
export function useClipPostFormats(enabled: boolean, brand: string): Set<string> | null {
  const [state, setState] = useState<{ brand: string; set: Set<string> | null }>(() => ({ brand, set: cached.get(brand) ?? null }));
  useEffect(() => {
    if (!enabled || cached.has(brand)) return;
    let cancelled = false;
    void load(brand).then((s) => {
      if (!cancelled) setState({ brand, set: s });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, brand]);
  if (!enabled) return null;
  return cached.get(brand) ?? (state.brand === brand ? state.set : null);
}
