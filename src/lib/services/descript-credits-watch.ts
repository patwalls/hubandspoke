import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { syncLogs } from "@/lib/db/schema";
import { sendDescriptCreditsExhaustedEmail } from "@/lib/email";
import { ALERT_RECIPIENTS } from "@/lib/services/alert-recipients";

const LOOKBACK_MINUTES = 60;
const ALERT_DEDUPE_HOURS = 4;

/** Every queued task that ultimately hits Descript's `/jobs/agent` /
 *  `/projects` endpoints. Listing them explicitly (instead of an `ILIKE
 *  'descript-%'`) keeps the watcher from accidentally matching some
 *  future task whose name starts with "descript" but talks to a
 *  different upstream. */
const DESCRIPT_TASK_IDENTIFIERS = [
  "descript-clip-resolve",
  "descript-derivative-create",
  "descript-publish-and-archive",
  "clip-idea-precise-cut",
];

/** Phrases Descript writes when AI credits are out. Two known variants
 *  from production: the agent-job result (`Descript agent failed:
 *  Insufficient AI credits`) and the project-create response (`Out of AI
 *  credits`). Match either. */
const DESCRIPT_CREDITS_PATTERNS = [
  "Insufficient AI credits",
  "Out of AI credits",
];

export interface DescriptCreditsExhaustionState {
  exhausted: boolean;
  failedCount: number;
  sinceIso: string | null;
  sampleError: string | null;
}

/**
 * Detect whether Descript is currently rejecting our calls because the
 * organization's AI credit budget is out. Reads `graphile_worker.jobs`
 * — the view exposes pending + actively-retrying jobs (a successful
 * job is removed from the queue, so the count drops automatically the
 * moment credits flow again).
 *
 * Why graphile_worker.jobs and not a dedicated descript_call_log?
 * No such log exists today and standing one up just for this alarm
 * would be over-engineered. The queue view already carries everything
 * we need: per-task identifier, the upstream's verbatim error in
 * `last_error`, and `updated_at` advancing on every retry.
 *
 * Recency clear: `updated_at > now() - 1h` filters out stale rows from
 * a previous exhaustion that's since been resolved (those jobs would
 * either have succeeded — and disappeared — or failed with a different
 * error which overwrites `last_error`).
 */
export async function getDescriptCreditsExhaustionState(): Promise<DescriptCreditsExhaustionState> {
  const sinceIso = new Date(Date.now() - LOOKBACK_MINUTES * 60_000).toISOString();

  // Drizzle's template-tag interpolation expands a JS array into a tuple
  // `($1, $2, …)` which Postgres rejects when fed to `= ANY(…)` (42809,
  // "op ANY/ALL (array) requires array on right side"). Use IN (…) with
  // `sql.join` instead — same semantics, no array-vs-tuple coercion.
  const taskList = sql.join(
    DESCRIPT_TASK_IDENTIFIERS.map((t) => sql`${t}`),
    sql`, `,
  );
  // Patterns are static constants — safe to inline as SQL literals.
  const errorPattern = sql.raw(
    DESCRIPT_CREDITS_PATTERNS.map(
      (p) => `last_error ILIKE '%${p}%'`,
    ).join(" OR "),
  );

  const rows = (await db.execute(sql`
    SELECT
      COUNT(*)::int AS n,
      MIN(updated_at)::text AS first_ts,
      (SELECT last_error
       FROM graphile_worker.jobs
       WHERE task_identifier IN (${taskList})
         AND (${errorPattern})
         AND updated_at > ${sinceIso}::timestamptz
       ORDER BY updated_at DESC
       LIMIT 1) AS sample
    FROM graphile_worker.jobs
    WHERE task_identifier IN (${taskList})
      AND (${errorPattern})
      AND updated_at > ${sinceIso}::timestamptz
  `)) as unknown as Array<{ n: number; first_ts: string | null; sample: string | null }>;

  const row = rows[0];
  const failedCount = Number(row?.n ?? 0);
  if (failedCount === 0) {
    return {
      exhausted: false,
      failedCount: 0,
      sinceIso: null,
      sampleError: null,
    };
  }

  return {
    exhausted: true,
    failedCount,
    sinceIso: row?.first_ts ?? null,
    sampleError: row?.sample ?? null,
  };
}

/**
 * Send a "Descript credits exhausted" email if:
 *   - current state is exhausted, AND
 *   - no alert was sent in the last `ALERT_DEDUPE_HOURS` hours.
 *
 * Dedupe state in `sync_logs` with `sync_type='descript-credits-alert'`,
 * mirroring the SC alarm. Recipients are the explicit operator list
 * (Pat + Sam) — credit exhaustion blocks the workflow and needs to land
 * regardless of any per-user opt-in.
 */
export async function maybeAlertDescriptCreditsExhausted(): Promise<{
  sent: number;
  reason: "no_alert_needed" | "deduped" | "sent";
  state: DescriptCreditsExhaustionState;
}> {
  const state = await getDescriptCreditsExhaustionState();
  if (!state.exhausted) {
    return { sent: 0, reason: "no_alert_needed", state };
  }

  const dedupeSince = new Date(Date.now() - ALERT_DEDUPE_HOURS * 3600_000);
  const [recent] = await db
    .select({ id: syncLogs.id })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.syncType, "descript-credits-alert"),
        gte(syncLogs.startedAt, dedupeSince),
      ),
    )
    .limit(1);
  if (recent) {
    return { sent: 0, reason: "deduped", state };
  }

  let sent = 0;
  for (const to of ALERT_RECIPIENTS) {
    try {
      await sendDescriptCreditsExhaustedEmail({
        to,
        failedCount: state.failedCount,
        since: state.sinceIso ? new Date(state.sinceIso) : null,
        sampleError: state.sampleError ?? "Insufficient AI credits",
      });
      sent++;
    } catch {
      // One email-send failure shouldn't starve the other recipient. The
      // dedupe window reopens in 4h.
    }
  }

  await db.insert(syncLogs).values({
    syncType: "descript-credits-alert",
    status: sent > 0 ? "success" : "error",
    itemsFetched: state.failedCount,
    itemsCreated: 0,
    itemsUpdated: sent,
    itemsDeleted: 0,
    errorMessage: sent === 0 ? "all sends failed" : null,
    startedAt: new Date(),
    completedAt: new Date(),
  });

  return { sent, reason: "sent", state };
}
