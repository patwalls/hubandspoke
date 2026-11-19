/**
 * Serve the last good value when a fresh one is slow.
 *
 * Each `get(key, compute)` starts `compute()` (callers asking for the same
 * key at the same time share one run). If it settles within `waitMs`, the
 * caller gets that value, fresh. If not, and this dyno holds a value for the
 * key from the last `maxStaleMs`, the caller gets that value at once, marked
 * `stale`, while `compute()` keeps going and replaces it when it lands. A key
 * with nothing remembered always waits for `compute()`.
 *
 * Used by the In Production / queue report (services/production-report.ts):
 * any pipeline write expires the brand's report, so the next person to open
 * In Production waited on a cold rebuild (sentry-tx p95 ~6 s, p50 59 ms). The
 * caller returns `stale` to the page, which refetches once a few seconds later.
 */
export interface LastGoodOptions {
  /** How long a caller waits for a fresh value before taking the last one. */
  waitMs: number;
  /** Oldest remembered value still worth serving. */
  maxStaleMs: number;
  /** Most keys kept; the oldest is dropped beyond it. */
  maxKeys?: number;
  now?: () => number;
}

export interface LastGoodResult<T> {
  value: T;
  /** True when this is the remembered value, not the one just computed. */
  stale: boolean;
  /** Age of the served value in ms (0 when fresh). */
  ageMs: number;
}

interface Entry<T> {
  value?: { v: T; at: number };
  inflight?: Promise<T>;
}

export function createLastGood<T>(opts: LastGoodOptions) {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 200;
  const entries = new Map<string, Entry<T>>();

  function entryFor(key: string): Entry<T> {
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entry = {};
      entries.set(key, entry);
    }
    return entry;
  }

  function run(entry: Entry<T>, compute: () => Promise<T>): Promise<T> {
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
    async get(key: string, compute: () => Promise<T>): Promise<LastGoodResult<T>> {
      const entry = entryFor(key);
      const remembered = entry.value;
      const fresh = run(entry, compute);
      if (!remembered || now() - remembered.at >= opts.maxStaleMs) {
        return { value: await fresh, stale: false, ageMs: 0 };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow = new Promise<"slow">((resolve) => {
        timer = setTimeout(() => resolve("slow"), opts.waitMs);
      });
      // A failed run while we hold a remembered value: serve the remembered
      // one rather than an error (the next caller tries again).
      const settled = fresh.then(
        (v) => ({ ok: true as const, v }),
        () => ({ ok: false as const }),
      );
      try {
        const first = await Promise.race([settled, slow]);
        if (first !== "slow" && first.ok) return { value: first.v, stale: false, ageMs: 0 };
        return { value: remembered.v, stale: true, ageMs: now() - remembered.at };
      } finally {
        clearTimeout(timer);
      }
    },
    /** Always wait for a fresh value (sharing a run already going) and
     *  remember it — for callers whose job is to rebuild, like a re-warm. */
    fresh(key: string, compute: () => Promise<T>): Promise<T> {
      return run(entryFor(key), compute);
    },
    /** For tests. */
    clear() {
      entries.clear();
    },
  };
}
