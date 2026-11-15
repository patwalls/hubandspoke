/**
 * Get a cross-post's source ready (enriched, media archived) exactly once,
 * no matter how many callers ask at the same moment.
 *
 * Why: the cross-post dialog submits one POST per selected target, all in
 * parallel. A source that still needed enrichment made EVERY one of those
 * requests run its own `enrichSingleItem` (a forced `withMedia` re-enrich
 * for a video post with no archived video) — N downloads, N credit charges,
 * and the slowest of them (~14 s) was the route's p95. Now the dialog warms
 * the source as soon as someone starts choosing targets
 * (`/cross-post-prepare`), and every POST joins that same in-flight run.
 *
 * Pure: the DB / enrichment calls come in as `deps`, so the dedupe and the
 * "does it need enriching" rules are unit-tested without a database. The
 * real wiring lives in `src/lib/services/cross-post-source.ts`.
 */

export interface PreparerSource {
  id: string;
  postType: string | null;
  mediaS3Key: string | null;
  enrichmentCompletedAt: Date | string | null;
}

export interface PreparerDeps {
  loadSource(id: string): Promise<PreparerSource | null>;
  /** A clean original resolvable up the lineage (no watermarked download). */
  hasCleanOriginal(id: string): Promise<boolean>;
  hasCarouselRow(id: string): Promise<boolean>;
  isVideoBearing(postType: string | null): boolean;
  enrich(id: string, opts: { withMedia?: boolean; force: boolean }): Promise<unknown>;
  logError?(message: string): void;
}

export interface PrepareResult {
  hasCleanOriginal: boolean;
  /** True when this run (or the run it joined) called enrichment. */
  enriched: boolean;
}

/** A finished run is reused this long, so a POST that lands right after the
 *  warm-up doesn't force a second media download that just failed. */
export const PREPARE_REUSE_MS = 60_000;

export function createSourcePreparer(
  deps: PreparerDeps,
  now: () => number = Date.now,
) {
  const runs = new Map<string, { promise: Promise<PrepareResult>; at: number }>();

  async function run(id: string): Promise<PrepareResult> {
    const source = await deps.loadSource(id);
    if (!source) return { hasCleanOriginal: false, enriched: false };
    const hasCleanOriginal = await deps.hasCleanOriginal(id);
    const needsMedia =
      !hasCleanOriginal &&
      deps.isVideoBearing(source.postType) &&
      !source.mediaS3Key &&
      !(await deps.hasCarouselRow(id));
    if (!needsMedia && source.enrichmentCompletedAt) {
      return { hasCleanOriginal, enriched: false };
    }
    try {
      await deps.enrich(id, {
        withMedia: needsMedia ? true : undefined,
        force: !!source.enrichmentCompletedAt && needsMedia,
      });
    } catch (err) {
      deps.logError?.(
        `[cross-post] enrichment failed for source ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { hasCleanOriginal, enriched: true };
  }

  return function prepare(id: string): Promise<PrepareResult> {
    const t = now();
    for (const [key, r] of runs) {
      if (t - r.at >= PREPARE_REUSE_MS) runs.delete(key);
    }
    const hit = runs.get(id);
    if (hit) return hit.promise;
    const promise = run(id).catch((err) => {
      // A lookup failed (not the enrichment, which is fail-soft above):
      // don't cache the failure, let the next caller try again.
      runs.delete(id);
      throw err;
    });
    runs.set(id, { promise, at: t });
    return promise;
  };
}
