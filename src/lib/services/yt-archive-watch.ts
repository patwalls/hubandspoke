import * as Sentry from "@sentry/node";
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { sendYtArchiveBehindEmail } from "@/lib/email";
import { ALERT_RECIPIENTS } from "@/lib/services/alert-recipients";

// How long a published item may sit with zero download attempts before we
// call the archiver "behind". The home cron runs hourly, so anything still
// untouched after 12h means the cron has missed ~12 consecutive ticks —
// systemic, not a transient blip (one slow tick, machine asleep overnight).
const GRACE_HOURS = 12;

// Only look at recent items. The home cron itself only looks back
// RUN_SINCE_DAYS (configured in yt-archive.env); older unarchived items are
// out of its scope by design and would camp in the alert forever.
const LOOKBACK_DAYS = 30;

// Brands the home-machine cron is configured to archive (BRANDS in
// ~/.config/hubandspoke/yt-archive.env on the designated Mac). Items from
// other brands are never archived by the cron, so counting them would be a
// permanent false alarm. Overridable without a deploy via the
// YT_ARCHIVE_WATCH_BRANDS Heroku config var (comma-separated) — keep it in
// sync when editing the env file on the home machine.
const DEFAULT_WATCH_BRANDS = [
  "futurepedia",
  "matg",
  "my-first-million",
  "science-of-scaling",
  "starter-story",
];

const ALERT_DEDUPE_HOURS = 6;

export function getWatchBrands(): string[] {
  const env = process.env.YT_ARCHIVE_WATCH_BRANDS;
  if (!env) return DEFAULT_WATCH_BRANDS;
  const brands = env.split(",").map((s) => s.trim()).filter(Boolean);
  return brands.length > 0 ? brands : DEFAULT_WATCH_BRANDS;
}

export interface YtArchiveLagState {
  behind: boolean;
  /** Published YouTube items in watched brands with zero download attempts
   *  that have been waiting longer than the grace window. The signature of
   *  "the archiver is not running at all" — attempts increment on both
   *  success and failure, so 0 means it never even tried. */
  staleCount: number;
  /** Oldest stale item's published timestamp — "how long has it been broken". */
  oldestPublishedAtIso: string | null;
  /** Sample of stale items for the alert body. */
  sample: Array<{ id: string; title: string | null; brand: string | null; publishedDate: string | null }>;
}

/**
 * Detect whether YouTube archiving (the home-machine hourly cron — see
 * home-machine/yt-archive/ and docs/automation.md) has stopped landing
 * archives. The in-dyno youtube-download-sweep is a deliberate noop in
 * production (YouTube bot-blocks datacenter IPs), so if the home cron dies,
 * nothing else picks up the work and the gap is invisible without this check.
 *
 * Signal: a Published item with a youtube_id, no media in S3, and ZERO
 * download attempts that has been published for more than GRACE_HOURS.
 * A healthy hourly cron stamps attempts within ~1 hour of publish (success
 * and failure both increment), so attempts=0 past the grace window means
 * the cron never saw the item: machine off, wrapper broken, repo checkout
 * wedged — exactly the failure modes that bit us 2026-06-06.
 */
export async function findStaleYtItems(limit = 50): Promise<
  Array<{
    id: string;
    title: string | null;
    brand: string | null;
    publishedDate: string | null;
    publishedAt: Date | null;
  }>
> {
  const brands = getWatchBrands();
  const graceCutoff = new Date(Date.now() - GRACE_HOURS * 3600_000);
  const lookbackCutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600_000);
  const lookbackDate = lookbackCutoff.toISOString().slice(0, 10);

  // published_at is null on some rows (Notion-synced long-form) — fall back
  // to midnight UTC of published_date, same as the analytics views do.
  const effectivePublishedAt = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;

  return db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      brand: productionItems.brand,
      publishedDate: productionItems.publishedDate,
      publishedAt: productionItems.publishedAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.youtubeId),
        isNull(productionItems.mediaS3Key),
        sql`COALESCE(${productionItems.youtubeDownloadAttempts}, 0) = 0`,
        inArray(productionItems.brand, brands),
        gte(productionItems.publishedDate, lookbackDate),
        // ISO string, not Date: postgres.js can't serialize a Date bound to
        // a raw sql`` expression (no column type to map through).
        lte(effectivePublishedAt, sql`${graceCutoff.toISOString()}::timestamptz`),
      ),
    )
    .orderBy(effectivePublishedAt)
    .limit(limit);
}

export async function getYtArchiveLagState(): Promise<YtArchiveLagState> {
  const stale = await findStaleYtItems();

  if (stale.length === 0) {
    return { behind: false, staleCount: 0, oldestPublishedAtIso: null, sample: [] };
  }

  const oldest = stale[0];
  return {
    behind: true,
    staleCount: stale.length,
    oldestPublishedAtIso: (oldest.publishedAt ?? new Date(`${oldest.publishedDate}T00:00:00Z`)).toISOString(),
    sample: stale.slice(0, 5).map(({ id, title, brand, publishedDate }) => ({ id, title, brand, publishedDate })),
  };
}

/**
 * If the archiver is behind: capture a Sentry event (fingerprinted to one
 * grouped issue, so Sentry alert rules fire on new/regressed, and the event
 * count shows how long it's been broken) and email the operator list. Email
 * sends are deduped to one per ALERT_DEDUPE_HOURS via `sync_logs`
 * (sync_type='yt-archive-alert'), mirroring the credits watchers. Sentry
 * events are NOT deduped — repeated events on the same issue are the
 * "still broken" heartbeat and cost nothing.
 */
export async function maybeAlertYtArchiveBehind(): Promise<{
  sent: number;
  reason: "no_alert_needed" | "deduped" | "sent";
  state: YtArchiveLagState;
}> {
  const state = await getYtArchiveLagState();
  if (!state.behind) {
    return { sent: 0, reason: "no_alert_needed", state };
  }

  Sentry.captureMessage(
    `yt-archive behind: ${state.staleCount} YouTube item(s) unarchived past ${GRACE_HOURS}h (oldest published ${state.oldestPublishedAtIso})`,
    {
      level: "error",
      fingerprint: ["yt-archive-behind"],
      tags: { source: "yt-archive-watch" },
      extra: {
        staleCount: state.staleCount,
        oldestPublishedAtIso: state.oldestPublishedAtIso,
        sample: state.sample,
      },
    },
  );

  const dedupeSince = new Date(Date.now() - ALERT_DEDUPE_HOURS * 3600_000);
  const [recent] = await db
    .select({ id: syncLogs.id })
    .from(syncLogs)
    .where(
      and(
        eq(syncLogs.syncType, "yt-archive-alert"),
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
      await sendYtArchiveBehindEmail({
        to,
        staleCount: state.staleCount,
        oldestPublishedAt: state.oldestPublishedAtIso ? new Date(state.oldestPublishedAtIso) : null,
        sample: state.sample,
      });
      sent++;
    } catch {
      // Don't block other recipients on one email-send failure. The next
      // dedupe window opens in 6h; if all sends failed, we'll retry.
    }
  }

  await db.insert(syncLogs).values({
    syncType: "yt-archive-alert",
    status: sent > 0 ? "success" : "error",
    itemsFetched: state.staleCount,
    itemsCreated: 0,
    itemsUpdated: sent,
    itemsDeleted: 0,
    errorMessage: sent === 0 ? "all sends failed" : null,
    startedAt: new Date(),
    completedAt: new Date(),
  });

  return { sent, reason: "sent", state };
}
