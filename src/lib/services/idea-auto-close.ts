import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, contentEvents, productionItems } from "@/lib/db/schema";

/**
 * Weekly auto-close of clip ideas nobody touched (cron `idea-auto-close`,
 * Mondays 11:00 UTC; clip-ideas-backlog M4, Pat's yes 2026-11-23).
 *
 * The clip-idea pipeline writes ~170 ideas a week and ~75% are never decided,
 * so the queue grew to ~5,000 open ideas over 30 days old. Opus Clip expires
 * unpicked clips at ~30 days; Linear auto-closes untouched triage issues. We
 * close, never delete:
 *
 *   - Scope: clip-idea Idea rows (source_type 'repurposed' + source_clip_idea_id)
 *     created more than AUTO_CLOSE_DAYS ago with no content_events in that
 *     window — any edit or status move counts as a touch — except
 *     `editor_change`: on an Idea row those are the automatic "to self" on
 *     create or a bulk sweep (2026-10-23 20:20 Pat unassigned himself from
 *     2,242 items in one pass, which would otherwise have "touched" 1,296 of
 *     the 1,711 ideas this exists to close). Hand-made ideas, cross-posts and
 *     reposts are never auto-closed.
 *   - Effect: the same end state as "Kill all older ideas" (M2,
 *     queue-clear-older.server.ts): item → Killed, one `killed` event per item
 *     tagged `bulk: "auto-close"` + `run: <YYYY-MM-DD>` (the History tab
 *     skips bulk events), its still-'suggested' clip idea → killed.
 *   - Undo: `undoAutoClose(brand, run)` puts every item of that run that is
 *     still Killed back to Idea (and its clip idea back to suggested). The
 *     restore writes a `status_change` event, which is itself a touch, so an
 *     undone idea is safe from the next AUTO_CLOSE_DAYS of runs.
 *   - Off switch: IDEA_AUTO_CLOSE=off on the worker skips the run.
 */
export const AUTO_CLOSE_DAYS = 60;
export const AUTO_CLOSE_BULK_TAG = "auto-close";
export const AUTO_CLOSE_REASON = `Closed itself: nobody touched it for ${AUTO_CLOSE_DAYS} days`;
/** How long the queue offers "Undo" on a run. */
export const AUTO_CLOSE_UNDO_DAYS = 30;

const DAY = 24 * 60 * 60 * 1000;
const CHUNK = 1000;

export function autoCloseCutoff(now: number): Date {
  return new Date(now - AUTO_CLOSE_DAYS * DAY);
}

/** A run's id is its UTC date — one run a week, so it's unique and readable. */
export function autoCloseRunId(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function autoCloseDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.IDEA_AUTO_CLOSE ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

function untouchedClipIdeasWhere(now: number, format: string | null) {
  const cutoff = autoCloseCutoff(now);
  return and(
    eq(productionItems.status, "Idea"),
    isNull(productionItems.deletedAt),
    eq(productionItems.sourceType, "repurposed"),
    sql`${productionItems.sourceClipIdeaId} is not null`,
    lt(productionItems.createdAt, cutoff),
    sql`not exists (select 1 from ${contentEvents} where ${contentEvents.contentItemId} = ${productionItems.id} and ${contentEvents.createdAt} >= ${cutoff.toISOString()}::timestamptz and ${contentEvents.eventType} <> 'editor_change')`,
    ...(format ? [eq(productionItems.format, format)] : []),
  );
}

export interface AutoCloseResult {
  run: string;
  /** Items closed per brand. */
  byBrand: Record<string, number>;
  total: number;
}

/**
 * Close every untouched clip idea, one transaction per brand. Idempotent: a
 * second call the same day finds nothing (the first one's items are Killed).
 * `format` narrows the scope (tests; never set by the cron).
 */
export async function autoCloseUntouchedIdeas(opts?: {
  now?: number;
  format?: string | null;
  dryRun?: boolean;
}): Promise<AutoCloseResult> {
  const now = opts?.now ?? Date.now();
  const format = opts?.format ?? null;
  const run = autoCloseRunId(now);
  const brandRows = await db
    .select({ brand: productionItems.brand, n: sql<number>`count(*)::int` })
    .from(productionItems)
    .where(untouchedClipIdeasWhere(now, format))
    .groupBy(productionItems.brand);

  const byBrand: Record<string, number> = {};
  for (const { brand, n } of brandRows) {
    if (!brand) continue;
    if (opts?.dryRun) {
      byBrand[brand] = Number(n);
      continue;
    }
    byBrand[brand] = await db.transaction(async (tx) => {
      const closed = await tx
        .update(productionItems)
        .set({ status: "Killed", updatedAt: new Date(now) })
        .where(and(eq(productionItems.brand, brand), untouchedClipIdeasWhere(now, format)))
        .returning({ id: productionItems.id, clipIdeaId: productionItems.sourceClipIdeaId });
      for (let i = 0; i < closed.length; i += CHUNK) {
        await tx.insert(contentEvents).values(
          closed.slice(i, i + CHUNK).map((c) => ({
            contentItemId: c.id,
            userId: null,
            eventType: "killed",
            payload: {
              type: "killed" as const,
              from: "Idea",
              reason: AUTO_CLOSE_REASON,
              bulk: AUTO_CLOSE_BULK_TAG,
              run,
            },
          })),
        );
      }
      const ideaIds = closed.map((c) => c.clipIdeaId).filter((id): id is string => !!id);
      for (let i = 0; i < ideaIds.length; i += CHUNK) {
        await tx
          .update(clipIdeas)
          .set({ status: "killed", killReason: AUTO_CLOSE_REASON, decidedAt: new Date(now), decidedByUserId: null })
          .where(and(inArray(clipIdeas.id, ideaIds.slice(i, i + CHUNK)), eq(clipIdeas.status, "suggested")));
      }
      return closed.length;
    });
  }
  const total = Object.values(byBrand).reduce((a, b) => a + b, 0);
  return { run, byBrand, total };
}

/** Items of `run` (in `brand`) the run closed that are still Killed. */
function stillClosedInRun(brand: string, run: string) {
  return and(
    eq(productionItems.brand, brand),
    eq(productionItems.status, "Killed"),
    sql`exists (select 1 from ${contentEvents} where ${contentEvents.contentItemId} = ${productionItems.id} and ${contentEvents.eventType} = 'killed' and ${contentEvents.payload}->>'bulk' = ${AUTO_CLOSE_BULK_TAG} and ${contentEvents.payload}->>'run' = ${run})`,
  );
}

export interface LatestAutoClose {
  run: string;
  /** Items that run closed in this brand. */
  closed: number;
  /** Of those, still Killed — what Undo would bring back. */
  undoable: number;
}

/** The brand's most recent auto-close run within AUTO_CLOSE_UNDO_DAYS, or null. */
export async function latestAutoClose(brand: string, now = Date.now()): Promise<LatestAutoClose | null> {
  const since = new Date(now - AUTO_CLOSE_UNDO_DAYS * DAY);
  const [latest] = await db
    .select({ run: sql<string>`${contentEvents.payload}->>'run'`, n: sql<number>`count(*)::int` })
    .from(contentEvents)
    .innerJoin(productionItems, eq(productionItems.id, contentEvents.contentItemId))
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(contentEvents.eventType, "killed"),
        sql`${contentEvents.payload}->>'bulk' = ${AUTO_CLOSE_BULK_TAG}`,
        sql`${contentEvents.createdAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(sql`${contentEvents.payload}->>'run'`)
    .orderBy(sql`${contentEvents.payload}->>'run' desc`)
    .limit(1);
  if (!latest?.run) return null;
  const [u] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(productionItems)
    .where(stillClosedInRun(brand, latest.run));
  return { run: latest.run, closed: Number(latest.n), undoable: Number(u?.n ?? 0) };
}

/**
 * Bring back every item `run` closed in `brand` that is still Killed: item →
 * Idea, a `status_change` Killed → Idea event (a touch, so the next runs skip
 * it), and its clip idea back to 'suggested' if the run killed it. Items
 * someone has moved since are left alone. Returns how many came back.
 */
export async function undoAutoClose(args: {
  brand: string;
  run: string;
  actorUserId: string | null;
  now?: number;
}): Promise<number> {
  const now = args.now ?? Date.now();
  return db.transaction(async (tx) => {
    const restored = await tx
      .update(productionItems)
      .set({ status: "Idea", updatedAt: new Date(now) })
      .where(stillClosedInRun(args.brand, args.run))
      .returning({ id: productionItems.id, clipIdeaId: productionItems.sourceClipIdeaId });
    for (let i = 0; i < restored.length; i += CHUNK) {
      await tx.insert(contentEvents).values(
        restored.slice(i, i + CHUNK).map((r) => ({
          contentItemId: r.id,
          userId: args.actorUserId,
          eventType: "status_change",
          payload: { type: "status_change" as const, from: "Killed", to: "Idea" },
        })),
      );
    }
    const ideaIds = restored.map((r) => r.clipIdeaId).filter((id): id is string => !!id);
    for (let i = 0; i < ideaIds.length; i += CHUNK) {
      await tx
        .update(clipIdeas)
        .set({ status: "suggested", killReason: null, decidedAt: null, decidedByUserId: null })
        .where(
          and(
            inArray(clipIdeas.id, ideaIds.slice(i, i + CHUNK)),
            eq(clipIdeas.status, "killed"),
            eq(clipIdeas.killReason, AUTO_CLOSE_REASON),
          ),
        );
    }
    return restored.length;
  });
}
