/**
 * Per-platform enrichment runs once per published item to capture every
 * durable signal SC offers — transcripts, durable media, captions, author
 * snapshots — and persist it. The orchestrator routes items to the right
 * enricher based on platform; each enricher is idempotent on its own
 * per-field gates so partial re-runs only fetch what's actually missing.
 */

export interface EnrichmentResult {
  /** Map of `productionItems` columns that the orchestrator should persist. */
  updates: Record<string, unknown>;
  /** Approximate SC credits consumed by this run — for budgeting + logging. */
  creditsSpent: number;
  /** Per-field outcomes — surfaced in logs to make sweep behavior auditable. */
  fields: {
    captionFetched?: boolean;
    descriptionFetched?: boolean;
    publishDateFetched?: boolean;
    posterArchived?: boolean;
    mediaArchived?: boolean;
    transcriptFetched?: boolean;
    authorFetched?: boolean;
  };
}

export interface Enricher {
  enrich(itemId: string): Promise<EnrichmentResult>;
}
