"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * URL-as-state hook for filtered list views.
 *
 * Solves the same problem `format-detail.tsx`'s `setActiveTab` solves for a
 * single key (round-tripping `?tab=` through the URL via `router.replace`)
 * — but generalized for an arbitrary set of filter keys, with two extras:
 *
 *   1. **Default pruning.** A key whose value equals its default is removed
 *      from the URL so a clean "no filters applied" lands on a bare path,
 *      not a noisy `?platform=all&account=all&...`.
 *   2. **Debounced text inputs.** Pass `debounceMs` on a key and the hook
 *      shadows the URL with a local draft so the input stays responsive
 *      while typing; the URL flushes once typing pauses. Without this, a
 *      search box would push one history entry per keystroke and re-render
 *      the table on every character.
 *
 * Why this lives in a single shared hook: every filtered list page
 * (`content-view.tsx`, `production-view.tsx`, `queue-view.tsx`, etc.)
 * currently maintains its own per-filter `useState` + ad-hoc seeding from
 * `searchParams.get(...)` on mount, but never writes back. Sharable URLs
 * and browser-back navigation both broke because the URL was a one-way
 * read. This hook makes the URL the source of truth.
 */

type FilterDescriptor = {
  /** Value used when the URL key is absent. Also the value that gets pruned
   *  from the URL when set explicitly — keeps URLs clean. */
  default: string;
  /** Wait this many ms after a `.set()` before pushing to the URL. Use for
   *  text inputs that fire on every keystroke; leave undefined for pickers
   *  that fire once per click. */
  debounceMs?: number;
};

type FilterConfig = Record<string, FilterDescriptor>;

type Values<C extends FilterConfig> = {
  [K in keyof C]: string;
};

export interface UrlState<C extends FilterConfig> {
  /** Current value per key — reads from URL with debounced-draft fallback. */
  values: Values<C>;
  /** Set one key. Debounce-aware. */
  set: (key: keyof C & string, value: string) => void;
  /** Set many keys atomically (single URL update). Always flushes immediately
   *  — no debounce — since callers using this path are typically
   *  bulk-resetting (e.g. a "Clear all filters" button) and expect the URL
   *  to reflect the new state right away. */
  setMany: (patch: Partial<Values<C>>) => void;
  /** Reset every key to its default in one URL update. */
  reset: () => void;
  /** True while a transition-wrapped `router.replace` is pending —
   *  consumers can dim the table or show a spinner if they want. */
  isPending: boolean;
}

export function useUrlState<C extends FilterConfig>(config: C): UrlState<C> {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Local draft state — only used for keys with debounceMs. Holds the
  // pre-flush input so the rendered value matches what the user just typed
  // even though the URL hasn't caught up yet.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Per-key debounce timers. Map (not state) so the timer reference is
  // stable across re-renders and we can clear it from inside `set()`.
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {},
  );

  // Snapshot the URL into a memoized values object. Reading from
  // `searchParams.get()` inline at every consumer site would work too, but
  // baking it once here matches the React reading model and gives us a
  // single dependency for `useMemo` sorters in the consumer.
  const values = useMemo<Values<C>>(() => {
    const out: Record<string, string> = {};
    for (const key of Object.keys(config)) {
      if (drafts[key] !== undefined) {
        out[key] = drafts[key];
      } else {
        out[key] = searchParams.get(key) ?? config[key].default;
      }
    }
    return out as Values<C>;
  }, [searchParams, drafts, config]);

  const writeToUrl = useCallback(
    (patch: Record<string, string>) => {
      // Build the next URL from the LATEST searchParams snapshot — never
      // from a stale closure. We capture it inside the transition so
      // concurrent `set()` calls compose correctly.
      startTransition(() => {
        const params = new URLSearchParams(searchParams.toString());
        for (const [key, val] of Object.entries(patch)) {
          const cfg = config[key];
          if (!cfg) continue;
          if (val === cfg.default) params.delete(key);
          else params.set(key, val);
        }
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [config, pathname, router, searchParams],
  );

  const set = useCallback(
    (key: keyof C & string, value: string) => {
      const cfg = config[key];
      if (!cfg) return;
      if (cfg.debounceMs && cfg.debounceMs > 0) {
        // Show the new value to the consumer immediately…
        setDrafts((prev) => ({ ...prev, [key]: value }));
        // …but defer the URL write until typing settles.
        const existing = debounceTimers.current[key];
        if (existing) clearTimeout(existing);
        debounceTimers.current[key] = setTimeout(() => {
          writeToUrl({ [key]: value });
          // Clear the draft so subsequent renders read from the (now-up-to-
          // date) URL. If we left the draft in place a back-button press
          // wouldn't be visible — the draft would mask the URL change.
          setDrafts((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          delete debounceTimers.current[key];
        }, cfg.debounceMs);
      } else {
        writeToUrl({ [key]: value });
      }
    },
    [config, writeToUrl],
  );

  const setMany = useCallback(
    (patch: Partial<Values<C>>) => {
      writeToUrl(patch as Record<string, string>);
    },
    [writeToUrl],
  );

  const reset = useCallback(() => {
    const patch: Record<string, string> = {};
    for (const [key, cfg] of Object.entries(config)) patch[key] = cfg.default;
    writeToUrl(patch);
  }, [config, writeToUrl]);

  // Drop any pending debounce timers on unmount so a setTimeout doesn't
  // fire `router.replace` after the consumer is gone.
  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, []);

  return { values, set, setMany, reset, isPending };
}
