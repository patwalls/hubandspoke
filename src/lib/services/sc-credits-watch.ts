import { and, count, desc, eq, gt, gte, ilike, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { scCallLog, syncLogs } from "@/lib/db/schema";
import { sendScCreditsExhaustedEmail } from "@/lib/email";
import { ALERT_RECIPIENTS } from "@/lib/services/alert-recipients";

const LOOKBACK_MINUTES = 60;
const ALERT_DEDUPE_HOURS = 4;

export interface ScCreditsExhaustionState {
  exhausted: boolean;
  /** Total `sc_call_log` rows in the last hour where notes match the
   *  Scrape Creators "out of credits" 402 message. */
  failedCount: number;
  /** First time we saw the OOC error in the lookback window. Lets the
   *  banner say "since 2h ago" so editors know if it just happened or
   *  has been broken all morning. */
  sinceIso: string | null;
  /** A representative error message — useful for the banner tooltip
   *  and the alert email body. */
  sampleError: string | null;
}

/**
 * Detect whether Scrape Creators is currently rejecting our calls due
 * to exhausted credits. We look at `sc_call_log` rows in the last hour
 * with `ok=false` and a "out of credits" / 402 marker in the notes.
 *
 * Why sc_call_log and not productionItems.last_performance_sync_error?
 * The error column lags — it stamps once per item per sync. The
 * call log is the moment-by-moment ground truth and survives item
 * re-syncs.
 *
 * **Recency clear (2026-05-11):** if a successful SC call has happened
 * AFTER the most recent 402, treat the credits as flowing again. SC has
 * been known to return 402 transiently (top-up races, gateway hiccups)
 * and without this check the banner camps for a full hour after a 5-second
 * upstream glitch — a stale signal that trains editors to ignore it.
 *
 * **Billed-only recency clear (2026-08-18):** the clear counts only calls
 * that actually spent a credit (`credits > 0`). Pulse-served calls land in
 * this same table with `credits = 0` — they never reach SC's paid API, so
 * they keep succeeding after the balance hits zero. Treating those as proof
 * that credits flow made the clear fire on every tick, and the watch went
 * permanently blind. See the note on the query below.
 */
export async function getScCreditsExhaustionState(): Promise<ScCreditsExhaustionState> {
  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60_000);

  const [agg] = await db
    .select({
      n: count(scCallLog.id),
      first: sql<string | null>`MIN(${scCallLog.createdAt})::text`,
      lastFailed: sql<string | null>`MAX(${scCallLog.createdAt})::text`,
    })
    .from(scCallLog)
    .where(
      and(
        eq(scCallLog.ok, false),
        gte(scCallLog.createdAt, since),
        or(
          ilike(scCallLog.notes, "%out of credits%"),
          ilike(scCallLog.notes, "%(402)%"),
        ),
      ),
    );

  const failedCount = Number(agg?.n ?? 0);
  if (failedCount === 0) {
    return { exhausted: false, failedCount: 0, sinceIso: null, sampleError: null };
  }

  // Recency clear: any successful billed call after the latest 402 means
  // SC is accepting our key again. The banner clears the moment the next
  // sweep tick lands an OK row.
  //
  // `credits > 0` is load-bearing. Pulse-served calls are logged here with
  // `credits = 0` because they bypass SC's paid API entirely, so they go on
  // succeeding with an empty balance. Counting them cleared the alert on
  // every tick: on 2026-08-18, 15 billed 402s in one hour (newest 22:01:35Z)
  // were masked by a free `capture-velocity-snapshot` row at 22:02:09Z, and
  // the 22:00 tick logged `no_alert_needed failedCount=0` while X and
  // YouTube content sync were fully down. Only a call that actually spent a
  // credit proves the balance is non-empty.
  const [latestOk] = await db
    .select({ createdAt: scCallLog.createdAt })
    .from(scCallLog)
    .where(
      and(
        eq(scCallLog.ok, true),
        gt(scCallLog.credits, 0),
        gte(scCallLog.createdAt, since),
      ),
    )
    .orderBy(desc(scCallLog.createdAt))
    .limit(1);
  const lastFailedIso = agg?.lastFailed ?? null;
  if (
    latestOk &&
    lastFailedIso &&
    latestOk.createdAt.getTime() > new Date(lastFailedIso).getTime()
  ) {
    return { exhausted: false, failedCount: 0, sinceIso: null, sampleError: null };
  }

  const [sample] = await db
    .select({ notes: scCallLog.notes })
    .from(scCallLog)
    .where(
      and(
        eq(scCallLog.ok, false),
        gte(scCallLog.createdAt, since),
        or(
          ilike(scCallLog.notes, "%out of credits%"),
          ilike(scCallLog.notes, "%(402)%"),
        ),
      ),
    )
    .orderBy(desc(scCallLog.createdAt))
    .limit(1);

  return {
    exhausted: true,
    failedCount,
    sinceIso: agg?.first ?? null,
    sampleError: sample?.notes ?? null,
  };
}

/**
 * Send an "SC credits exhausted" email if:
 *   - the current state is exhausted, AND
 *   - we haven't sent one in the last `ALERT_DEDUPE_HOURS` hours.
 *
 * Dedupe state lives in `sync_logs` with `sync_type='sc-credits-alert'`.
 * Each successful send writes one row; the next tick reads the latest
 * row and skips if it's recent. Recipients are the explicit operator
 * list (`ALERT_RECIPIENTS`) — credit exhaustion blocks the workflow and
 * needs to land regardless of any per-user opt-in.
 */
export async function maybeAlertScCreditsExhausted(): Promise<{
  sent: number;
  reason: "no_alert_needed" | "deduped" | "sent";
  state: ScCreditsExhaustionState;
}> {
  const state = await getScCreditsExhaustionState();
  if (!state.exhausted) {
    return { sent: 0, reason: "no_alert_needed", state };
  }

  const dedupeSince = new Date(Date.now() - ALERT_DEDUPE_HOURS * 3600_000);
  const [recent] = await db
    .select({ id: syncLogs.id })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.syncType, "sc-credits-alert"),
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
      await sendScCreditsExhaustedEmail({
        to,
        failedCount: state.failedCount,
        since: state.sinceIso ? new Date(state.sinceIso) : null,
        sampleError: state.sampleError ?? "Out of credits",
      });
      sent++;
    } catch {
      // Don't block other recipients on one Postmark failure. The next
      // dedupe window opens in 4h; if all sends failed, we'll retry.
    }
  }

  await db.insert(syncLogs).values({
    syncType: "sc-credits-alert",
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
