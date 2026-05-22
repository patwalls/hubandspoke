import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipSections,
  formats,
  productionItems,
  transcripts,
} from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import {
  generateClipSections,
  SECTION_GENERATED_BY,
  SECTION_PROMPT_VERSION,
} from "@/lib/clip-section-agent";

export type DetectSectionsOutcome =
  | {
      status: "ok";
      sectionsCreated: number;
      batchId: string;
      /** True when sections existed already (idempotent skip). */
      reusedExisting: boolean;
    }
  | { status: "skip"; reason: string };

export interface DetectSectionsOptions {
  /** Re-detect even if a live batch exists. Marks the old batch's
   *  sections as killed and inserts a fresh batch. Cascade-deletes the
   *  old batch's clip_ideas variants. */
  force?: boolean;
  /** Optional: who triggered the force-re-detect, stamped on
   *  `clip_sections.killed_by_user_id` for the prior batch. */
  killedByUserId?: string | null;
}

/**
 * Detect clip sections for one pillar. Idempotent: if a live (non-killed)
 * batch exists, returns it as-is. Force=true marks the existing batch
 * killed and re-runs detection.
 *
 * Concurrency: optimistic re-check. Two workers racing on the same fresh
 * pillar both check before AND after the Sonnet call; only the one that
 * arrives at the INSERT first wins. The other re-reads, finds the
 * winner's batch, and returns it (sub-optimal: the loser's Sonnet call
 * was wasted ~$0.10, but the race window is small in practice — the
 * route's fan-out enqueues all formats simultaneously so they share the
 * same first batch). No held DB connections during the Sonnet call.
 *
 * Previously held a transaction + advisory lock around the Sonnet call;
 * that held a postgres-js connection for ~10s and exhausted the web
 * dyno's pool when multiple format jobs ran in parallel from the
 * inline-on-web route path. See Splice v10 incident, 2026-05-22 — now
 * the route enqueues to graphile-worker (worker dyno's separate pool)
 * AND this service no longer holds a connection during the agent call.
 */
export async function detectClipSectionsForPillar(
  pillarId: string,
  opts: DetectSectionsOptions = {},
): Promise<DetectSectionsOutcome> {
  const [pillar] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      format: productionItems.format,
      brand: productionItems.brand,
    })
    .from(productionItems)
    .where(eq(productionItems.id, pillarId))
    .limit(1);
  if (!pillar) return { status: "skip", reason: "pillar-not-found" };

  // Fast path before taking the lock: live batch already exists, no force.
  if (!opts.force) {
    const [existing] = await db
      .select({ batchId: clipSections.batchId })
      .from(clipSections)
      .where(
        and(eq(clipSections.pillarId, pillarId), isNull(clipSections.killedAt)),
      )
      .limit(1);
    if (existing) {
      const counted = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(clipSections)
        .where(eq(clipSections.batchId, existing.batchId));
      return {
        status: "ok",
        sectionsCreated: counted[0]?.n ?? 0,
        batchId: existing.batchId,
        reusedExisting: true,
      };
    }
  }

  const transcript = await getTranscriptForPrompt(pillarId);
  if (!transcript) return { status: "skip", reason: "no-transcript" };

  // Bench: top performers across the brand's clippable formats. Used purely
  // for view-count calibration of the section picker's baseline estimates.
  const benchRows = await db
    .select({
      hook: productionItems.hook,
      title: productionItems.title,
      views: productionItems.views,
      format: productionItems.format,
      platform: productionItems.platform,
    })
    .from(productionItems)
    .innerJoin(
      formats,
      and(
        eq(formats.brand, pillar.brand),
        eq(formats.name, productionItems.format),
        eq(formats.isClippableFormat, true),
      ),
    )
    .where(
      and(
        eq(productionItems.brand, pillar.brand),
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.views),
        isNull(productionItems.deletedAt),
      ),
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(20);

  // Run the Sonnet call WITHOUT holding any DB transaction. This is
  // critical for connection-pool health — see the doc comment above.
  const agentResult = await generateClipSections({
    pillarTitle: pillar.title,
    pillarFormat: pillar.format,
    transcriptSegmentsMarkdown: transcript.segmentsMarkdown,
    transcriptWords: transcript.words,
    transcriptSegments: transcript.segments,
    durationSec: transcript.durationSec,
    benchHooks: benchRows.map((r) => ({
      hook: r.hook,
      title: r.title,
      views: r.views,
      format: r.format,
      platform: r.platform as string[] | null,
    })),
  });

  // Short transaction: re-check live batch (someone else may have won
  // the race while we were calling Sonnet), then either return their
  // batch + drop ours or kill the prior batch (force path) + insert.
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ batchId: clipSections.batchId })
      .from(clipSections)
      .where(
        and(eq(clipSections.pillarId, pillarId), isNull(clipSections.killedAt)),
      )
      .limit(1);

    if (existing && !opts.force) {
      // Lost the race. Return the winner's batch (we discard our agent
      // output — rare in practice).
      const counted = await tx
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(clipSections)
        .where(eq(clipSections.batchId, existing.batchId));
      return {
        status: "ok" as const,
        sectionsCreated: counted[0]?.n ?? 0,
        batchId: existing.batchId,
        reusedExisting: true,
      };
    }

    if (opts.force) {
      // Mark prior batch killed (cascade-deletes derived clip_ideas).
      await tx
        .update(clipSections)
        .set({
          killedAt: new Date(),
          killedByUserId: opts.killedByUserId ?? null,
        })
        .where(
          and(
            eq(clipSections.pillarId, pillarId),
            isNull(clipSections.killedAt),
          ),
        );
    }

    const batchId = randomUUID();
    const inserted = await tx
      .insert(clipSections)
      .values(
        agentResult.sections.map((s) => ({
          pillarId,
          batchId,
          startSec: s.startSec.toFixed(3),
          endSec: s.endSec.toFixed(3),
          transcriptAnchorQuote: s.transcriptAnchorQuote,
          transcriptAnchorStartSec:
            s.transcriptAnchorStartSec != null
              ? s.transcriptAnchorStartSec.toFixed(3)
              : null,
          topic: s.topic,
          summary: s.summary,
          themeTags: s.themeTags,
          estimatedViews: s.estimatedViewsBaseline,
          promptVersion: SECTION_PROMPT_VERSION,
          generatedBy: SECTION_GENERATED_BY,
          modelUsage: agentResult.modelUsage,
        })),
      )
      .returning({ id: clipSections.id });

    return {
      status: "ok" as const,
      sectionsCreated: inserted.length,
      batchId,
      reusedExisting: false,
    };
  });

  return result;
}

/**
 * Load the live (non-killed) clip_sections batch for a pillar. Returns
 * empty array when no batch exists yet — caller should call
 * `detectClipSectionsForPillar` first to create one.
 */
export interface LiveClipSection {
  id: string;
  startSec: number;
  endSec: number;
  transcriptAnchorQuote: string;
  transcriptAnchorStartSec: number | null;
  topic: string;
  summary: string;
  themeTags: string[];
  estimatedViewsBaseline: number | null;
  batchId: string;
}

export async function loadLiveSectionsForPillar(
  pillarId: string,
): Promise<LiveClipSection[]> {
  const rows = await db
    .select({
      id: clipSections.id,
      startSec: clipSections.startSec,
      endSec: clipSections.endSec,
      transcriptAnchorQuote: clipSections.transcriptAnchorQuote,
      transcriptAnchorStartSec: clipSections.transcriptAnchorStartSec,
      topic: clipSections.topic,
      summary: clipSections.summary,
      themeTags: clipSections.themeTags,
      estimatedViews: clipSections.estimatedViews,
      batchId: clipSections.batchId,
    })
    .from(clipSections)
    .where(
      and(eq(clipSections.pillarId, pillarId), isNull(clipSections.killedAt)),
    )
    .orderBy(asc(clipSections.startSec));
  return rows.map((r) => ({
    id: r.id,
    startSec: Number(r.startSec),
    endSec: Number(r.endSec),
    transcriptAnchorQuote: r.transcriptAnchorQuote,
    transcriptAnchorStartSec:
      r.transcriptAnchorStartSec != null
        ? Number(r.transcriptAnchorStartSec)
        : null,
    topic: r.topic,
    summary: r.summary,
    themeTags: Array.isArray(r.themeTags) ? (r.themeTags as string[]) : [],
    estimatedViewsBaseline: r.estimatedViews,
    batchId: r.batchId,
  }));
}

// Re-export the transcripts table reference so consumers needing the
// full word array (e.g. the hook writer's anchor re-resolver) can join
// here rather than re-importing the table directly.
export { transcripts };
