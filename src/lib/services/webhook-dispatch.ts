/**
 * Outgoing webhooks: detect events and deliver them.
 *
 * Detection is a per-minute state diff rather than hooks at every write
 * site: `production_items` has a dozen writers (the app, the API, Notion
 * sync, account syncs, three schedule sweeps, merges) and only some of
 * them write activity events. The sweep reads rows whose `updated_at`
 * moved since the last watermark, compares `status` with
 * `api_webhook_item_state`, and emits:
 *   content.created          first time an item is seen (created after the sweep started)
 *   content.status_changed   status differs from last seen
 *   content.published        status_changed where the new status is Published
 *   transcript.ready         a transcript row's fetched_at is newer than last seen
 *
 * The first run seeds the state table from every live item without emitting
 * anything, so turning webhooks on never replays history.
 *
 * Delivery: one `api_webhook_deliveries` row per (subscription, event) and
 * one `webhook-deliver` job per row; graphile-worker retries with backoff
 * (MAX_ATTEMPTS). Bodies are signed with the subscription's secret.
 */
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  apiWebhookCursors,
  apiWebhookDeliveries,
  apiWebhookItemState,
  apiWebhooks,
  productionItems,
  transcripts,
} from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { signWebhookBody } from "@/lib/api/webhooks";
import type { WebhookEvent } from "@/lib/api/constants";

const CURSOR_ID = "singleton";
export const DELIVERY_MAX_ATTEMPTS = 8;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Disable a subscription after this many failed deliveries in a row. */
export const DISABLE_AFTER_FAILURES = 25;
const BATCH = 500;

export interface DetectedEvent {
  event: WebhookEvent;
  itemId: string;
  brand: string;
  data: Record<string, unknown>;
}

interface ItemSnapshot {
  id: string;
  brand: string;
  title: string | null;
  status: string | null;
  postType: string | null;
  format: string | null;
  publishedLink: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Pure diff: what events does this item's new state imply? Unit-tested. */
export function diffItem(
  item: ItemSnapshot,
  prev: { status: string | null } | null,
  sweepStartedAt: Date,
): DetectedEvent[] {
  const base = {
    id: item.id,
    title: item.title,
    brand: item.brand,
    status: item.status,
    post_type: item.postType,
    format: item.format,
    url: item.publishedLink,
    published_at: item.publishedAt?.toISOString() ?? null,
    updated_at: item.updatedAt.toISOString(),
  };
  const out: DetectedEvent[] = [];
  if (!prev) {
    // Unknown to the state table. Only items born after the sweep started
    // are "created"; anything older is a backfill (seeded, not announced).
    if (item.createdAt >= sweepStartedAt) {
      out.push({ event: "content.created", itemId: item.id, brand: item.brand, data: { content: base } });
    }
    return out;
  }
  if ((prev.status ?? null) !== (item.status ?? null)) {
    out.push({
      event: "content.status_changed",
      itemId: item.id,
      brand: item.brand,
      data: { content: base, from: prev.status ?? null, to: item.status ?? null },
    });
    if ((item.status ?? "").toLowerCase() === "published") {
      out.push({ event: "content.published", itemId: item.id, brand: item.brand, data: { content: base, from: prev.status ?? null } });
    }
  }
  return out;
}

async function activeSubscriptions() {
  return db.select().from(apiWebhooks).where(eq(apiWebhooks.active, true));
}

async function loadCursor(): Promise<{ items: Date; transcripts: Date } | null> {
  const [row] = await db.select().from(apiWebhookCursors).where(eq(apiWebhookCursors.id, CURSOR_ID)).limit(1);
  return row ? { items: row.itemsUpdatedAt, transcripts: row.transcriptsUpdatedAt } : null;
}

async function saveCursor(items: Date, transcriptsAt: Date): Promise<void> {
  await db
    .insert(apiWebhookCursors)
    .values({ id: CURSOR_ID, itemsUpdatedAt: items, transcriptsUpdatedAt: transcriptsAt })
    .onConflictDoUpdate({
      target: apiWebhookCursors.id,
      set: { itemsUpdatedAt: items, transcriptsUpdatedAt: transcriptsAt, updatedAt: new Date() },
    });
}

/** First run: remember every live item's status so nothing historical fires. */
async function seedState(now: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO api_webhook_item_state (item_id, status, transcript_fetched_at)
    SELECT p.id, p.status, t.fetched_at
    FROM production_items p
    LEFT JOIN transcripts t ON t.production_item_id = p.id
    WHERE p.deleted_at IS NULL
    ON CONFLICT (item_id) DO NOTHING
  `);
  await saveCursor(now, now);
}

/**
 * One sweep. Returns how many events were queued. Cheap when nothing
 * changed: two indexed range scans and no writes.
 */
export async function runWebhookDispatchSweep(now: Date = new Date()): Promise<{ events: number; deliveries: number }> {
  const subs = await activeSubscriptions();
  const cursor = await loadCursor();
  if (!cursor) {
    // Seed even with no subscriptions so the first one never sees a backfill.
    await seedState(now);
    return { events: 0, deliveries: 0 };
  }
  // Leave a small overlap so a row committed just before the watermark with
  // an older updated_at isn't skipped; the state diff makes replays no-ops.
  const since = new Date(cursor.items.getTime() - 5_000);
  const changed = await db
    .select({
      id: productionItems.id,
      brand: productionItems.brand,
      title: productionItems.title,
      status: productionItems.status,
      postType: productionItems.postType,
      format: productionItems.format,
      publishedLink: productionItems.publishedLink,
      publishedAt: productionItems.publishedAt,
      createdAt: productionItems.createdAt,
      updatedAt: productionItems.updatedAt,
      prevStatus: apiWebhookItemState.status,
      seen: apiWebhookItemState.itemId,
    })
    .from(productionItems)
    .leftJoin(apiWebhookItemState, eq(apiWebhookItemState.itemId, productionItems.id))
    .where(and(isNull(productionItems.deletedAt), gt(productionItems.updatedAt, since)))
    .orderBy(asc(productionItems.updatedAt))
    .limit(BATCH);

  const events: DetectedEvent[] = [];
  let maxItemsAt = cursor.items;
  for (const row of changed) {
    const prev = row.seen ? { status: row.prevStatus } : null;
    events.push(...diffItem(row, prev, cursor.items));
    if (row.updatedAt > maxItemsAt) maxItemsAt = row.updatedAt;
  }
  if (changed.length) {
    await db
      .insert(apiWebhookItemState)
      .values(changed.map((r) => ({ itemId: r.id, status: r.status, updatedAt: now })))
      .onConflictDoUpdate({
        target: apiWebhookItemState.itemId,
        set: { status: sql`excluded.status`, updatedAt: now },
      });
  }

  const tSince = new Date(cursor.transcripts.getTime() - 5_000);
  const freshTranscripts = await db
    .select({
      itemId: transcripts.productionItemId,
      fetchedAt: transcripts.fetchedAt,
      updatedAt: transcripts.updatedAt,
      source: transcripts.source,
      wordCount: transcripts.wordCount,
      durationSec: transcripts.durationSec,
      error: transcripts.error,
      brand: productionItems.brand,
      title: productionItems.title,
      seenFetchedAt: apiWebhookItemState.transcriptFetchedAt,
    })
    .from(transcripts)
    .innerJoin(productionItems, eq(productionItems.id, transcripts.productionItemId))
    .leftJoin(apiWebhookItemState, eq(apiWebhookItemState.itemId, transcripts.productionItemId))
    .where(and(isNull(productionItems.deletedAt), gt(transcripts.updatedAt, tSince)))
    .orderBy(asc(transcripts.updatedAt))
    .limit(BATCH);
  let maxTranscriptsAt = cursor.transcripts;
  for (const t of freshTranscripts) {
    if (t.updatedAt > maxTranscriptsAt) maxTranscriptsAt = t.updatedAt;
    if (t.error) continue;
    const isNew = !t.seenFetchedAt || t.fetchedAt.getTime() !== t.seenFetchedAt.getTime();
    if (!isNew) continue;
    events.push({
      event: "transcript.ready",
      itemId: t.itemId,
      brand: t.brand,
      data: {
        content: { id: t.itemId, title: t.title, brand: t.brand },
        transcript: { source: t.source, word_count: t.wordCount, duration_sec: t.durationSec ? Number(t.durationSec) : null },
      },
    });
    await db
      .insert(apiWebhookItemState)
      .values({ itemId: t.itemId, transcriptFetchedAt: t.fetchedAt, updatedAt: now })
      .onConflictDoUpdate({ target: apiWebhookItemState.itemId, set: { transcriptFetchedAt: t.fetchedAt, updatedAt: now } });
  }

  await saveCursor(maxItemsAt, maxTranscriptsAt);

  let deliveries = 0;
  if (events.length && subs.length) {
    deliveries = await fanOut(events, subs);
  }
  return { events: events.length, deliveries };
}

async function fanOut(events: DetectedEvent[], subs: Array<typeof apiWebhooks.$inferSelect>): Promise<number> {
  let n = 0;
  for (const ev of events) {
    for (const sub of subs) {
      if (!sub.events.includes(ev.event)) continue;
      if (sub.brand && sub.brand !== ev.brand) continue;
      const [row] = await db
        .insert(apiWebhookDeliveries)
        .values({ webhookId: sub.id, event: ev.event, payload: ev.data })
        .returning({ id: apiWebhookDeliveries.id });
      await enqueue("webhook-deliver", { deliveryId: row.id }, { maxAttempts: DELIVERY_MAX_ATTEMPTS, jobKey: `webhook-deliver:${row.id}` });
      n++;
    }
  }
  return n;
}

/** Build the exact request a receiver gets. Exported for tests and the "send test" button. */
export function buildDeliveryRequest(opts: {
  secret: string;
  deliveryId: string;
  event: string;
  data: unknown;
  createdAt: Date;
  now?: Date;
}): { body: string; headers: Record<string, string> } {
  const timestamp = String(Math.floor((opts.now ?? new Date()).getTime() / 1000));
  const body = JSON.stringify({
    id: opts.deliveryId,
    event: opts.event,
    created_at: opts.createdAt.toISOString(),
    data: opts.data,
  });
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "HubAndSpoke-Webhooks/1.0",
      "X-HubSpoke-Event": opts.event,
      "X-HubSpoke-Delivery": opts.deliveryId,
      "X-HubSpoke-Timestamp": timestamp,
      "X-HubSpoke-Signature": signWebhookBody(opts.secret, timestamp, body),
    },
  };
}

/**
 * Deliver one row. Throws on failure so graphile-worker retries; on the
 * final attempt the row is marked failed and the subscription's failure
 * streak is bumped (and the subscription disabled past the threshold).
 */
export async function deliverWebhook(deliveryId: string, attempt: number, maxAttempts: number, signal?: AbortSignal): Promise<void> {
  const [d] = await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.id, deliveryId)).limit(1);
  if (!d || d.status === "delivered") return;
  const [sub] = await db.select().from(apiWebhooks).where(eq(apiWebhooks.id, d.webhookId)).limit(1);
  if (!sub) return;
  if (!sub.active) {
    await db.update(apiWebhookDeliveries).set({ status: "failed", lastError: "Subscription disabled" }).where(eq(apiWebhookDeliveries.id, d.id));
    return;
  }
  const { body, headers } = buildDeliveryRequest({ secret: sub.secret, deliveryId: d.id, event: d.event, data: d.payload, createdAt: d.createdAt });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(sub.url, { method: "POST", headers, body, signal: controller.signal, redirect: "manual" });
    statusCode = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? (err.name === "AbortError" ? `Timed out after ${DELIVERY_TIMEOUT_MS / 1000}s` : err.message) : String(err);
  } finally {
    clearTimeout(timer);
  }
  const now = new Date();
  if (!error) {
    await db
      .update(apiWebhookDeliveries)
      .set({ status: "delivered", attempts: attempt, lastStatusCode: statusCode, lastError: null, deliveredAt: now })
      .where(eq(apiWebhookDeliveries.id, d.id));
    await db
      .update(apiWebhooks)
      .set({ lastDeliveryAt: now, lastSuccessAt: now, consecutiveFailures: 0, updatedAt: now })
      .where(eq(apiWebhooks.id, sub.id));
    return;
  }
  const final = attempt >= maxAttempts;
  await db
    .update(apiWebhookDeliveries)
    .set({ status: final ? "failed" : "pending", attempts: attempt, lastStatusCode: statusCode, lastError: error.slice(0, 500) })
    .where(eq(apiWebhookDeliveries.id, d.id));
  if (final) {
    const failures = sub.consecutiveFailures + 1;
    await db
      .update(apiWebhooks)
      .set({
        lastDeliveryAt: now,
        lastFailureAt: now,
        consecutiveFailures: failures,
        active: failures >= DISABLE_AFTER_FAILURES ? false : sub.active,
        updatedAt: now,
      })
      .where(eq(apiWebhooks.id, sub.id));
  }
  throw new Error(`webhook ${sub.id} → ${sub.url}: ${error}`);
}
