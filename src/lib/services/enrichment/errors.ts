import { ScrapeCreatorsError } from "@/lib/services/sc-client";

/**
 * A per-item enrichment failure that will never succeed on retry: the item's
 * `published_link` is missing, or points at a different platform than its
 * `post_type` (e.g. an x.com URL on a `threads` item). Retrying can't fix a
 * data mismatch, so the orchestrator stamps the item and gives up WITHOUT
 * re-throwing — no graphile-worker retry storm, no Sentry page every tick.
 *
 * Contrast with transient failures (network blips, SC 5xx, 429 rate limits)
 * which DO propagate so graphile-worker retries them with backoff.
 *
 * The item is left un-completed (no `enrichment_completed_at`), so if the
 * `published_link` is later corrected the 24h-cooldown sweep re-picks it up
 * and enriches successfully — the failure self-heals.
 */
export class PermanentEnrichmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEnrichmentError";
  }
}

/**
 * True when an enrichment failure is permanent for this item — a bad/missing
 * URL ({@link PermanentEnrichmentError}) or a source post that's gone or
 * malformed (SC 404/400). These are stamped-and-swallowed by the orchestrator
 * instead of paging Sentry and retrying forever. Everything else (5xx, 429,
 * timeouts, unexpected bugs) is treated as transient and re-thrown.
 */
export function isPermanentEnrichmentError(err: unknown): boolean {
  if (err instanceof PermanentEnrichmentError) return true;
  // Deleted / private / not-found / forbidden source post, or a malformed
  // request SC rejects outright — no amount of retrying brings it back. 403 is
  // SC's "forbidden" for private / age-gated / blocked posts (HUBANDSPOKE-26).
  if (
    err instanceof ScrapeCreatorsError &&
    (err.status === 404 || err.status === 403 || err.status === 400)
  ) {
    return true;
  }
  return false;
}
