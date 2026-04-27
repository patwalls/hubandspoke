import { db } from "@/lib/db";
import { scCallLog } from "@/lib/db/schema";

export interface ScUsageEntry {
  caller: string;
  accountId?: string | null;
  productionItemId?: string | null;
  platform?: string | null;
  credits: number;
  itemsCreated?: number | null;
  itemsUpdated?: number | null;
  ok?: boolean;
  notes?: string | null;
  durationMs?: number;
}

/**
 * Persist one row to `sc_call_log` summarizing a unit of SC API work
 * (one task fire, one ad-hoc route call, one velocity snapshot, etc.).
 *
 * Failure-tolerant: if the insert throws, swallow + console.error. Never
 * crash the parent task — losing a usage row is a tracking blip, but
 * crashing a sweep because the log table is unhealthy would be worse.
 *
 * Callers usually `void recordScUsage(...)` (fire-and-forget). The
 * function does its own error containment, so an un-awaited promise
 * cannot reject up the stack.
 */
export async function recordScUsage(entry: ScUsageEntry): Promise<void> {
  try {
    await db.insert(scCallLog).values({
      caller: entry.caller,
      accountId: entry.accountId ?? null,
      productionItemId: entry.productionItemId ?? null,
      platform: entry.platform ?? null,
      credits: entry.credits,
      itemsCreated: entry.itemsCreated ?? null,
      itemsUpdated: entry.itemsUpdated ?? null,
      ok: entry.ok ?? true,
      notes: entry.notes ?? null,
      durationMs: entry.durationMs ?? null,
    });
  } catch (err) {
    console.error("[sc-usage-log] insert failed", err);
  }
}
