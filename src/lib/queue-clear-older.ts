/**
 * "Kill all older ideas" on the queue's Older view (flag `queueClearOlder`,
 * clip-ideas-backlog M2).
 *
 * The triage queue carries thousands of Idea rows from clip-idea batches
 * nobody came back to. The Older view (src/lib/queue-age.ts) shows them; this
 * clears them in one server-side pass instead of one PUT per row. Scope is
 * deliberately narrow and named in the confirm dialog: one brand, optionally
 * one format, Idea rows created more than QUEUE_AGE_DAYS days ago. The count
 * the dialog shows comes from the server (a dry run), never the client list.
 *
 * Pure request parsing lives here so it can be unit-tested; the queries are
 * in queue-clear-older.server.ts.
 */
import { QUEUE_AGE_DAYS } from "./queue-age";

export const CLEAR_OLDER_REASON_MIN = 10;
export const CLEAR_OLDER_REASON_MAX = 2000;
/** Marks the bulk-clear kill events so the queue's History tab (capped at
 *  100 rows) isn't flooded by one clear; each item's own activity keeps it. */
export const CLEAR_OLDER_BULK_TAG = "clear-older";

export interface ClearOlderRequest {
  brand: string;
  /** null = every format. */
  format: string | null;
  /** true = count only. */
  dryRun: boolean;
  /** Required unless dryRun. */
  reason: string | null;
}

export type ParseResult =
  | { ok: true; value: ClearOlderRequest }
  | { ok: false; error: string };

export function parseClearOlderRequest(body: unknown): ParseResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const brand = typeof b.brand === "string" ? b.brand.trim() : "";
  if (!brand || brand === "all") {
    return { ok: false, error: "Pick one brand to clear" };
  }
  const rawFormat = typeof b.format === "string" ? b.format.trim() : "";
  const format = rawFormat && rawFormat !== "all" ? rawFormat : null;
  const dryRun = b.dryRun === true;
  const reasonRaw = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!dryRun && reasonRaw.length < CLEAR_OLDER_REASON_MIN) {
    return {
      ok: false,
      error: `A kill reason of at least ${CLEAR_OLDER_REASON_MIN} characters is required`,
    };
  }
  return {
    ok: true,
    value: {
      brand,
      format,
      dryRun,
      reason: reasonRaw ? reasonRaw.slice(0, CLEAR_OLDER_REASON_MAX) : null,
    },
  };
}

/** Rows created before this instant count as "older". */
export function clearOlderCutoff(now: number): Date {
  return new Date(now - QUEUE_AGE_DAYS * 24 * 60 * 60 * 1000);
}
