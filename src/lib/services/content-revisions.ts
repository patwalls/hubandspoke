import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { db } from "@/lib/db";
import {
  contentEvents,
  type ContentChangeSource,
  type ContentChangeTarget,
  type ContentEventPayload,
} from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";

/**
 * The append-only writer for `content_changed` events. Every state-changing
 * write site that mutates tracked content (caption text, production_item
 * columns, carousel media rows) calls this with a per-field diff. Callers
 * pass their own transaction so the event row commits atomically with the
 * underlying mutation — drift between "the data changed" and "we logged
 * the change" would silently degrade the audit trail.
 *
 * No-op writes (from === to after coercion) are dropped here so a save
 * that doesn't actually change anything doesn't spam the activity feed.
 * Long string values are truncated at {@link MAX_VALUE_CHARS} chars with
 * `truncated: true` set; the full prior content is recoverable from
 * `content_drafts` version rows for draft_field changes.
 */

type DbTx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
/** Accept either a Drizzle transaction or the top-level `db` so callers
 *  that don't need atomicity (e.g. test fixtures) can skip the tx wrap. */
export type RevisionWriter = DbTx | typeof db;

const MAX_VALUE_CHARS = 2000;

export interface ContentChange {
  target: ContentChangeTarget;
  from?: string | number | boolean | null;
  to?: string | number | boolean | null;
}

export interface RecordContentChangesArgs {
  /** Drizzle transaction (or top-level db) — every caller decides.
   *  Mutations should use a tx; pass it through so events commit with the
   *  underlying write. */
  tx: RevisionWriter;
  /** The production_item being mutated. */
  contentItemId: string;
  /** Actor's user id. `null` for cron / algorithm / tool / sync / import
   *  writes — those identify themselves via `source.kind`. */
  userId: string | null;
  /** Who/what wrote. See `ContentChangeSource` for the discriminated set. */
  source: ContentChangeSource;
  /** One entry per field/media row that moved. Pre-diffed by the caller. */
  changes: ContentChange[];
}

export async function recordContentChanges(
  args: RecordContentChangesArgs,
): Promise<void> {
  if (args.changes.length === 0) return;

  // Drop no-op changes (field set to the same value it already had). This
  // avoids spamming the activity feed when a save round-trips an unchanged
  // value, which the inline editor does on every blur whether or not the
  // text actually moved.
  const real = args.changes.filter((c) => !isNoop(c));
  if (real.length === 0) return;

  const rows: (typeof contentEvents.$inferInsert)[] = real.map((c) => {
    const { from, to, truncated } = truncateValues(c.from, c.to);
    const payload: Extract<ContentEventPayload, { type: "content_changed" }> = {
      type: "content_changed",
      source: args.source,
      target: c.target,
      ...(c.from !== undefined ? { from } : {}),
      ...(c.to !== undefined ? { to } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
    return {
      contentItemId: args.contentItemId,
      userId: args.userId,
      eventType: "content_changed",
      payload,
    };
  });

  await args.tx.insert(contentEvents).values(rows);
}

function isNoop(c: ContentChange): boolean {
  if (c.from === undefined && c.to === undefined) {
    // Media targets carry no from/to — they're always meaningful (an add
    // or remove is always a change).
    return false;
  }
  // Normalize before comparing so "" === null in our diff (the inline
  // editor often produces "" for cleared text fields where the DB stores
  // null).
  const a = normalize(c.from);
  const b = normalize(c.to);
  return Object.is(a, b);
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "string" && v.length === 0) return null;
  return v;
}

function truncateValues(
  from: ContentChange["from"],
  to: ContentChange["to"],
): {
  from: ContentChange["from"];
  to: ContentChange["to"];
  truncated: boolean;
} {
  let didTruncate = false;
  const f = maybeTruncate(from);
  const t = maybeTruncate(to);
  if (f.truncated || t.truncated) didTruncate = true;
  return { from: f.value, to: t.value, truncated: didTruncate };
}

function maybeTruncate(v: ContentChange["from"]): {
  value: ContentChange["from"];
  truncated: boolean;
} {
  if (typeof v !== "string") return { value: v, truncated: false };
  if (v.length <= MAX_VALUE_CHARS) return { value: v, truncated: false };
  return {
    value: v.slice(0, MAX_VALUE_CHARS - 1) + "…",
    truncated: true,
  };
}
