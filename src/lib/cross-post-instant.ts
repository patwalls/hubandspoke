/**
 * Instant cross-post from the queue (cross-post-instant M4): the dialog closes
 * and the row leaves the moment "Cross-post N" is clicked; the creates run
 * behind. When they settle, this decides what the person sees next — the same
 * end states the old blocking submit had, only later:
 *   - "done"    → every target was created / already existed (or some hard
 *                 errors next to real creates, as before): dismiss the source
 *                 from the queue and show the usual "Created N" toast.
 *   - "reopen"  → the readiness gate refused a target: the row comes back and
 *                 the dialog reopens with the "I'll do it manually" banner.
 *   - "restore" → nothing was created and the requests failed: the row comes
 *                 back and an error toast says why.
 */
export type InstantOutcome = "done" | "reopen" | "restore";

export function instantOutcome(r: {
  created: number;
  skipped: number;
  gateFailures: number;
  hardErrors: number;
}): InstantOutcome {
  if (r.gateFailures > 0) return "reopen";
  if (r.created + r.skipped === 0) return "restore";
  return "done";
}

/** How long the creates took behind the closed dialog, as a usage-mark suffix
 *  (`cross-post:background:<bucket>`) — the wait people no longer sit through. */
export function backgroundBucket(ms: number): "under-2s" | "2-5s" | "5s-plus" {
  if (ms < 2000) return "under-2s";
  if (ms < 5000) return "2-5s";
  return "5s-plus";
}

/** The post page's Cross-post tab (M5) settles per channel: the ones that
 *  were created (or already existed) read "Created", gate refusals go to the
 *  banner (not re-ticked — the banner's "I'll do it manually" retries them),
 *  and the rest failed outright, so they come back ticked for one-click retry. */
export function tabSettle(
  keys: string[],
  doneKeys: string[],
  gateKeys: string[],
): { created: string[]; reselect: string[] } {
  const done = new Set(doneKeys);
  const gate = new Set(gateKeys);
  return {
    created: keys.filter((k) => done.has(k)),
    reselect: keys.filter((k) => !done.has(k) && !gate.has(k)),
  };
}
