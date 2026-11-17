/**
 * Re-warm the In Production report right after an edit empties it.
 *
 * Every pipeline change calls invalidateReportCaches(), which expires the
 * shared production report for EVERY brand. The next person to open (or come
 * back to) In Production then waits for a blocking recompute — 1.5–6 s
 * (sentry-tx: /api/reports/production p50 65 ms, p95 4.7 s). The tab-level
 * cache (production:list-instant) only helps a tab that already loaded it.
 *
 * So after an invalidation we ask our own dyno, a few seconds later, to
 * rebuild the report for every brand (`/api/warm?only=production`) — both
 * keys since 2026-11-17: In Production's and the queue's.
 * A self-request, not an in-process call: it runs in its own request scope,
 * after the revalidation has been applied, so the fresh result is what lands
 * in the cache.
 *
 * Load is bounded: a burst of edits coalesces into one warm (debounce), only
 * one warm runs at a time, and warms start at least `minGapMs` apart — an
 * edit during a warm schedules exactly one more after it.
 *
 * Since 2026-11-16 an edit that names its brand expires only that brand's
 * report (src/lib/production-report-tags.ts), so the warm rebuilds only the
 * brands edited since the last warm — not all ~10 one after another, which
 * left most brands cold for most of a minute after every edit.
 */

export interface RewarmerOptions {
  /** Wait this long after the last invalidation before warming. */
  delayMs: number;
  /** Never start two warms closer together than this. */
  minGapMs: number;
  /** Warm these brands' reports; `null` = every brand. */
  run: (brands: string[] | null) => Promise<void>;
  now?: () => number;
}

export function createRewarmer(opts: RewarmerOptions) {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let lastStart = -Infinity;
  // Brands edited since the last warm started: a set, "all", or none.
  let dirty: Set<string> | "all" | null = null;

  const markDirty = (brands: string[] | null) => {
    if (dirty === "all") return;
    if (!brands) {
      dirty = "all";
      return;
    }
    dirty ??= new Set();
    for (const b of brands) dirty.add(b);
  };

  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, ms);
    // Never keep a process alive just to warm a cache.
    (timer as { unref?: () => void }).unref?.();
  };

  async function fire() {
    timer = null;
    if (running) {
      pending = true;
      return;
    }
    const wait = lastStart + opts.minGapMs - now();
    if (wait > 0) {
      arm(wait);
      return;
    }
    running = true;
    lastStart = now();
    const brands = dirty === "all" || dirty === null ? null : [...dirty];
    dirty = null;
    try {
      await opts.run(brands);
    } catch {
      // A failed warm just means the next reader computes it, as before.
    } finally {
      running = false;
      if (pending) {
        pending = false;
        arm(opts.delayMs);
      }
    }
  }

  return {
    /** An edit touched `brands` (`null` / omitted = every brand). */
    schedule(brands: string[] | null = null) {
      markDirty(brands);
      if (running) {
        pending = true;
        return;
      }
      arm(opts.delayMs);
    },
  };
}

/** The self-request URL path for a warm of `brands` (null = every brand). */
export function warmPath(brands: string[] | null): string {
  const base = "/api/warm?only=production";
  return brands ? `${base}&brands=${brands.map(encodeURIComponent).join(",")}` : base;
}

async function warmProductionOverHttp(brands: string[] | null): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const port = process.env.PORT || "3000";
  const res = await fetch(`http://127.0.0.1:${port}${warmPath(brands)}`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(120_000),
  });
  await res.body?.cancel();
}

const rewarmer = createRewarmer({
  delayMs: 4_000,
  minGapMs: 30_000,
  run: warmProductionOverHttp,
});

/** Called by invalidateReportCaches(). Noop in tests and without a secret. */
export function scheduleProductionRewarm(brands: string[] | null = null): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  if (!process.env.CRON_SECRET) return;
  rewarmer.schedule(brands);
}
