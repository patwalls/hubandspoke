/**
 * In-process memo for slow-moving inputs: one value per key, shared by every
 * caller on this dyno.
 *
 * - Callers asking at the same time share ONE computation (no stampede when
 *   the after-edit re-warm and a person both miss).
 * - Within `freshMs` the stored value is returned as-is.
 * - After `freshMs` the stored value is still returned at once and a refresh
 *   runs in the background (stale-while-revalidate); a failed refresh keeps
 *   the old value.
 * - Only a key never computed (or older than `maxStaleMs`) makes a caller wait.
 *
 * Used by the In Production report (services/production-report.ts) for the
 * view-prediction history and format odds: they only move when views sync,
 * yet were rebuilt on every cold report.
 */
export interface SwrMemoOptions {
  freshMs: number;
  maxStaleMs: number;
  /** Most keys kept; the oldest is dropped beyond it. */
  maxKeys?: number;
  now?: () => number;
}

interface Entry<T> {
  value?: { v: T; at: number };
  inflight?: Promise<T>;
}

export function createSwrMemo<T>(opts: SwrMemoOptions) {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 200;
  const entries = new Map<string, Entry<T>>();

  function refresh(key: string, entry: Entry<T>, compute: () => Promise<T>): Promise<T> {
    if (entry.inflight) return entry.inflight;
    const p = (async () => {
      try {
        const v = await compute();
        entry.value = { v, at: now() };
        return v;
      } finally {
        entry.inflight = undefined;
      }
    })();
    entry.inflight = p;
    return p;
  }

  return {
    get(key: string, compute: () => Promise<T>): Promise<T> {
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= maxKeys) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        entry = {};
        entries.set(key, entry);
      }
      const value = entry.value;
      if (value) {
        const age = now() - value.at;
        if (age < opts.freshMs) return Promise.resolve(value.v);
        if (age < opts.maxStaleMs) {
          // Serve the last value now; refresh behind it. A failed refresh
          // leaves the old value in place for the next caller.
          refresh(key, entry, compute).catch(() => {});
          return Promise.resolve(value.v);
        }
      }
      return refresh(key, entry, compute);
    },
    /** For tests. */
    clear() {
      entries.clear();
    },
  };
}

