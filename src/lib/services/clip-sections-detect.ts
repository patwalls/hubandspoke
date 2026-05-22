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

// Hash the pillarId into a stable 32-bit signed integer for use with
// pg_advisory_xact_lock(integer). FNV-1a — cheap, deterministic, fine
// distribution for our use case (serializing concurrent section-detect
// jobs that race on the same pillar).
function pillarLockKey(pillarId: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < pillarId.length; i++) {
    hash ^= pillarId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Map to 32-bit signed range
  return hash | 0;
}

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
 * Concurrency: two workers racing on the same fresh pillar are serialized
 * via a Postgres advisory lock keyed on the pillar id, then re-check
 * inside the transaction. The first caller pays the Sonnet call; the
 * second finds the batch already there and returns it.
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

  // Acquire the advisory lock + re-check inside a transaction so two
  // concurrent jobs can't double-insert.
  const lockKey = pillarLockKey(pillarId);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);

    // Recheck after acquiring the lock.
    if (!opts.force) {
      const [existing] = await tx
        .select({ batchId: clipSections.batchId })
        .from(clipSections)
        .where(
          and(
            eq(clipSections.pillarId, pillarId),
            isNull(clipSections.killedAt),
          ),
        )
        .limit(1);
      if (existing) {
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
    } else {
      // Force re-detect: mark the existing batch's sections as killed
      // (cascade-deletes their derived clip_ideas variants).
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

    // Run the agent OUTSIDE the transaction would be ideal, but
    // graphile-worker tasks are already serialized per-job and the lock
    // here is short-lived (Sonnet call ~10s). Hold it so concurrent jobs
    // don't double-spend.
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
