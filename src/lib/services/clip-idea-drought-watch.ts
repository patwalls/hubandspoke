import * as Sentry from "@sentry/node";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeaDroughtAlerts } from "@/lib/db/schema";
import { sendClipIdeaDroughtEmail } from "@/lib/email";
import { ALERT_RECIPIENTS } from "@/lib/services/alert-recipients";

// Only consider recently-published pillars. A channel that simply goes quiet
// must NOT alert (no fresh video → nothing "should have" generated). 7 days
// mirrors the auto-generation recency cap (DEFAULT_MAX_AGE_DAYS in
// clip-ideas-auto.ts) — a gap older than that would never have auto-fired
// anyway, so flagging it would be a permanent false alarm.
const LOOKBACK_DAYS = 7;

// Hard cap on gaps reported in one run, so a systemic outage can't fan out a
// giant email. The count in the body reflects the true total; the list is a
// sample.
const MAX_GAPS = 50;

export interface ClipIdeaDroughtGap {
  pillarId: string;
  title: string | null;
  brand: string | null;
  sourceChannel: string | null;
  publishedDate: string | null;
  formatId: string;
  formatName: string;
  sectionCount: number;
}

/**
 * Find "silent drought" gaps: a freshly-published pillar the pipeline actually
 * processed (has a transcript AND ≥1 live clip_section) that routes to a
 * clippable format under the account-aware rules — root via
 * `format_trigger_sources`, derivative via the parent's `format_channels`
 * (matched on account + post_type) — but produced ZERO clip_ideas for that
 * format. That combination is this bug's exact fingerprint: the writer ran and
 * came up empty, rather than "not published" or "not processed yet".
 *
 * Excludes any (pillar, format) already recorded in `clip_idea_drought_alerts`
 * so each gap alerts exactly once, never a daily repeat.
 */
export async function findClipIdeaDroughts(
  limit = MAX_GAPS,
): Promise<ClipIdeaDroughtGap[]> {
  const rows = (await db.execute(sql`
    WITH pillars AS (
      SELECT pi.id, pi.title, pi.brand, pi.account_id, pi.post_type,
             pi.published_date
      FROM production_items pi
      WHERE pi.post_type = 'youtube_long'
        AND pi.source_type = 'original'
        AND pi.status = 'Published'
        AND pi.deleted_at IS NULL
        AND COALESCE(pi.published_at, pi.published_date::timestamptz)
              >= now() - (${LOOKBACK_DAYS} || ' days')::interval
        AND EXISTS (SELECT 1 FROM transcripts t WHERE t.production_item_id = pi.id)
        AND EXISTS (
          SELECT 1 FROM clip_sections cs
          WHERE cs.pillar_id = pi.id AND cs.killed_at IS NULL
        )
    ),
    routed AS (
      -- Root clippable formats wired to the pillar's account.
      SELECT p.id AS pillar_id, f.id AS format_id, f.name AS format_name
      FROM pillars p
      JOIN format_trigger_sources fts ON fts.source_account_id = p.account_id
      JOIN formats f ON f.id = fts.format_id
        AND f.parent_format_id IS NULL
        AND f.is_clippable_format
      WHERE p.account_id IS NOT NULL
      UNION
      -- Derivative clippable formats via the direct parent's channels.
      SELECT p.id, f.id, f.name
      FROM pillars p
      JOIN formats f ON f.parent_format_id IS NOT NULL AND f.is_clippable_format
      JOIN formats par ON par.id = f.parent_format_id
      JOIN format_channels fc ON fc.format_id = par.id
        AND fc.account_id = p.account_id
        AND (fc.post_type IS NULL OR fc.post_type = p.post_type)
      WHERE p.account_id IS NOT NULL
      UNION
      -- Accountless pillars route brand-wide (mirrors getClippableFormats).
      SELECT p.id, f.id, f.name
      FROM pillars p
      JOIN formats f ON f.brand = p.brand AND f.is_clippable_format
      WHERE p.account_id IS NULL
    )
    SELECT
      p.id            AS pillar_id,
      p.title         AS title,
      p.brand         AS brand,
      p.published_date AS published_date,
      a.handle        AS source_channel,
      r.format_id     AS format_id,
      r.format_name   AS format_name,
      (SELECT count(*)::int FROM clip_sections cs
        WHERE cs.pillar_id = p.id AND cs.killed_at IS NULL) AS section_count
    FROM pillars p
    JOIN routed r ON r.pillar_id = p.id
    LEFT JOIN accounts a ON a.id = p.account_id
    WHERE NOT EXISTS (
        SELECT 1 FROM clip_ideas ci
        WHERE ci.source_production_item_id = p.id
          AND ci.target_format = r.format_name
      )
      AND NOT EXISTS (
        SELECT 1 FROM clip_idea_drought_alerts da
        WHERE da.pillar_id = p.id AND da.format_id = r.format_id
      )
    ORDER BY p.brand, p.published_date DESC, r.format_name
    LIMIT ${limit}
  `)) as unknown as Array<{
    pillar_id: string;
    title: string | null;
    brand: string | null;
    published_date: string | null;
    source_channel: string | null;
    format_id: string;
    format_name: string;
    section_count: number;
  }>;

  return rows.map((r) => ({
    pillarId: r.pillar_id,
    title: r.title,
    brand: r.brand,
    sourceChannel: r.source_channel,
    publishedDate: r.published_date,
    formatId: r.format_id,
    formatName: r.format_name,
    sectionCount: Number(r.section_count),
  }));
}

/**
 * If any new droughts exist: capture a grouped Sentry event and email the
 * operator list ONCE, then record each alerted (pillar, format) in
 * `clip_idea_drought_alerts` so it never re-alerts. Recording is gated on a
 * successful send — if every email failed, nothing is recorded and the next
 * run retries. Mirrors the credit / yt-archive watchers.
 */
export async function maybeAlertClipIdeaDrought(): Promise<{
  sent: number;
  reason: "no_alert_needed" | "sent";
  gapCount: number;
}> {
  const gaps = await findClipIdeaDroughts();
  if (gaps.length === 0) {
    return { sent: 0, reason: "no_alert_needed", gapCount: 0 };
  }

  Sentry.captureMessage(
    `clip-idea drought: ${gaps.length} (pillar, format) pair(s) processed but produced 0 clip ideas`,
    {
      level: "warning",
      fingerprint: ["clip-idea-drought"],
      tags: { source: "clip-idea-drought-watch" },
      extra: { gapCount: gaps.length, sample: gaps.slice(0, 5) },
    },
  );

  let sent = 0;
  for (const to of ALERT_RECIPIENTS) {
    try {
      await sendClipIdeaDroughtEmail({ to, gapCount: gaps.length, gaps });
      sent++;
    } catch {
      // Don't block other recipients on one failed send. If ALL fail we skip
      // recording below, so the next run retries the same gaps.
    }
  }

  if (sent > 0) {
    await db
      .insert(clipIdeaDroughtAlerts)
      .values(
        gaps.map((g) => ({
          pillarId: g.pillarId,
          formatId: g.formatId,
          formatName: g.formatName,
        })),
      )
      .onConflictDoNothing();
  }

  return { sent, reason: "sent", gapCount: gaps.length };
}
