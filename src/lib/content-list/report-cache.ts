/**
 * The Content list's last few reports, kept in memory for the tab's life.
 *
 * Opening a post from the list and coming back used to refetch the whole
 * report behind a spinner (the payload is large — Sentry "Large HTTP payload"
 * on /:brand/content). The module outlives client-side navigation in the App
 * Router, so a report fetched a moment ago is still here: show it at once,
 * refresh it quietly, swap in the fresh one when it lands.
 *
 * In memory only — the payload can pass sessionStorage's quota, and a hard
 * reload should fetch fresh anyway.
 */

export const REPORT_CACHE_MAX = 4;

export class ReportCache<T> {
  private entries = new Map<string, T>();

  constructor(private readonly max = REPORT_CACHE_MAX) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    // Re-insert so the most recently used key is evicted last.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * What the list shows while a report is in flight:
 * - "instant": this exact view was fetched before — show it now, refresh behind it.
 * - "keep":    a different filter, but rows are on screen — keep them (dimmed)
 *              instead of blanking the page to a spinner.
 * - "spinner": nothing to show yet (first open of the tab).
 */
export type LoadMode = "instant" | "keep" | "spinner";

export function loadMode(hasCached: boolean, hasRowsOnScreen: boolean): LoadMode {
  if (hasCached) return "instant";
  if (hasRowsOnScreen) return "keep";
  return "spinner";
}
