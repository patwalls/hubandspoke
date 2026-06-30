import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import { createDescriptProjectFromUrl } from "@/lib/descript";
import { getPresignedGetUrl } from "@/lib/s3";

/** Minimal shape of the fields hasDescriptableMedia / coldImportPillar inspect. */
export interface DescriptableSource {
  id: string;
  descriptProjectId: string | null;
  descriptCompositionId: string | null;
  mediaS3Key: string | null;
  pillarContentItemId: string | null;
}

/** Repost mode also needs to know the source's own seed composition (when
 *  the source's media has already been cold-imported in a prior run). */
export interface RepostableSource extends DescriptableSource {
  descriptSeedCompositionId: string | null;
}

export interface DescriptablePillar {
  id: string;
  title: string | null;
  descriptProjectId: string | null;
  descriptProjectUrl: string | null;
  descriptSeedCompositionId: string | null;
  mediaS3Key: string | null;
}

/**
 * Result of resolving where to cold-import from for a Descript derivative
 * composition. The "import target" is the row whose media is the canonical
 * high-quality source — never a finished derivative's cropped export.
 *
 * - When `source.pillarContentItemId` is set, the source is a derivative
 *   (a Reel, a cross-post, etc.) and its `mediaS3Key` is the final exported
 *   pixels — useless for re-aspecting. The PILLAR is the import target.
 * - When `source.pillarContentItemId` is null, the source IS a pillar
 *   (the original long-form video) — its own media is the right material.
 */
export interface ImportTarget {
  /** The row whose media gets cold-imported into Descript. Either the
   *  pillar row or the source row, depending on whether the source has
   *  an upstream parent. */
  row: {
    id: string;
    title: string | null;
    descriptProjectId: string | null;
    descriptProjectUrl: string | null;
    descriptSeedCompositionId: string | null;
    mediaS3Key: string | null;
  };
  /** Discriminator for diagnostics/logging. */
  kind: "pillar" | "source-as-pillar";
}

/**
 * Pick the row whose media is the canonical Descript-cold-import source.
 * See `ImportTarget` docstring for the rule. Returns null only when the
 * source has an upstream pillar but the pillar wasn't loaded (caller
 * passed null for `pillar`) — that's a precondition violation, not a
 * recoverable state.
 */
export function resolveImportTarget(
  source: DescriptableSource,
  pillar: DescriptablePillar | null,
): ImportTarget | null {
  if (source.pillarContentItemId) {
    if (!pillar) return null;
    return { row: pillar, kind: "pillar" };
  }
  return {
    row: {
      id: source.id,
      title: null,
      descriptProjectId: source.descriptProjectId,
      descriptProjectUrl: null,
      descriptSeedCompositionId: null,
      mediaS3Key: source.mediaS3Key,
    },
    kind: "source-as-pillar",
  };
}

/**
 * Repost-mode analog of `resolveImportTarget`. A repost is same-platform,
 * same-aspect: we never need the pillar's uncropped pixels because we're
 * not re-aspecting. The source's own (already-cropped) media IS the
 * material we want to re-air. Target is always source-as-pillar, even
 * when an upstream pillar exists.
 *
 * Cross-post still goes through `resolveImportTarget` because re-aspecting
 * needs the pillar's higher-resolution / uncropped material.
 */
export function resolveImportTargetForRepost(
  source: RepostableSource,
): ImportTarget {
  return {
    row: {
      id: source.id,
      title: null,
      descriptProjectId: source.descriptProjectId,
      descriptProjectUrl: null,
      descriptSeedCompositionId: source.descriptSeedCompositionId,
      mediaS3Key: source.mediaS3Key,
    },
    kind: "source-as-pillar",
  };
}

/**
 * Returns true when the derivative-create task has a viable path to a
 * unique Descript composition for this source. Two ways:
 *
 * 1. The source already has its own composition — we duplicate it directly.
 * 2. The IMPORT TARGET (pillar if source is a derivative, source itself
 *    if source is a pillar) has a Descript project + seed composition,
 *    OR has archived media we can cold-import.
 *
 * Source-side `mediaS3Key` is INTENTIONALLY ignored when the source has an
 * upstream pillar — a finished Reel's media is the wrong input for any
 * Descript work because it's already-cropped pixels. If the pillar has no
 * Descript context AND no media, the cross-post / repost can't produce a
 * meaningful Descript composition; the route returns 400 and the UI
 * surfaces the `blocked_needs_pillar_media` state.
 */
export function hasDescriptableMedia(
  source: DescriptableSource,
  pillar: DescriptablePillar | null,
): boolean {
  if (source.descriptCompositionId) return true;
  const target = resolveImportTarget(source, pillar);
  if (!target) return false;
  if (target.row.descriptProjectId && target.row.descriptSeedCompositionId)
    return true;
  if (target.row.mediaS3Key) return true;
  return false;
}

/**
 * Repost-side defense-in-depth: a same-platform repost only needs one of
 *   - source's own Descript composition (duplicate in-place),
 *   - source's own archived video (`mediaS3Key`, cold-import + duplicate
 *     the seed), OR
 *   - source's own archived carousel images (`production_item_media`
 *     rows — mirrored to the repost by `seedRepostContent`, no Descript
 *     work needed).
 *
 * No pillar involvement, ever. The route's pre-gate calls
 * `checkRepostReadiness` first; this is the equivalent of
 * `hasDescriptableMedia` for the task's defensive check.
 *
 * `hasCarouselMedia` MUST be passed by the caller (Drizzle is async,
 * this is sync). The two routes that call this already invoke
 * `hasAnyCarouselRow(source.id)` for their pre-enrichment branch — pass
 * the same boolean through.
 */
export function hasDescriptableMediaForRepost(
  source: DescriptableSource,
  hasCarouselMedia = false,
): boolean {
  if (source.descriptCompositionId) return true;
  if (source.mediaS3Key) return true;
  if (hasCarouselMedia) return true;
  return false;
}

/** Why a cross-post / repost is blocked. Stable identifiers shared with
 *  the BlockedReason union in descript-derivative-create and the
 *  descript-status route. Surfaced verbatim in route 400 messages and
 *  the pill's per-reason label. */
export type CrossPostReadinessReason =
  | "needs_pillar_media"
  | "needs_transcript";

export type CrossPostReadiness =
  | { ok: true }
  | { ok: false; reason: CrossPostReadinessReason; detail: string };

/**
 * Stronger gate than `hasDescriptableMedia` — also requires word-level
 * Whisper transcripts on both ends when the task would have to anchor
 * the source's segment in the target's transcript.
 *
 * **No live route calls this as of the cross-post algorithm rework
 * (2026-05-18).** Cross-post and repost both gate on `checkRepostReadiness`
 * (source's own media is the cross-post material — re-aspecting from a
 * pillar transcript was over-engineering for a niche re-clip workflow).
 * Kept exported as the implementation behind `descript-derivative-create`'s
 * legacy `mode: "cross-post"` branch (which still runs for in-queue jobs
 * predating the `mode` field) and a possible future "Re-clip from pillar"
 * action that would actually need the pillar-anchored cut.
 *
 * Decisions:
 *   - Source has its own composition (Case 1 in derivative-create) → OK,
 *     no transcript needed (we duplicate in-place; no segment search).
 *   - Source is itself a pillar (no upstream parent) and has media → OK,
 *     no transcript needed (we cold-import the source's own media; the
 *     anchor search is degenerate — source IS target).
 *   - Source has an upstream pillar → BOTH source and target (the pillar)
 *     must have word-level transcripts. Otherwise refuse with
 *     `needs_transcript`.
 *   - No path to a composition at all → refuse with `needs_pillar_media`.
 *
 * One DB hit (the `IN (...)` transcript existence check) when applicable.
 * Skipped entirely when source has its own composition.
 */
export async function checkCrossPostReadiness(
  source: DescriptableSource,
  pillar: DescriptablePillar | null,
): Promise<CrossPostReadiness> {
  // Case 1: source has its own composition — no transcript needed.
  if (source.descriptCompositionId) return { ok: true };

  const target = resolveImportTarget(source, pillar);
  if (!target) {
    return {
      ok: false,
      reason: "needs_pillar_media",
      detail: `source ${source.id} has an upstream pillar ${source.pillarContentItemId} but it didn't load`,
    };
  }

  const targetHasProjectSeed =
    !!target.row.descriptProjectId && !!target.row.descriptSeedCompositionId;
  const targetHasMedia = !!target.row.mediaS3Key;
  if (!targetHasProjectSeed && !targetHasMedia) {
    return {
      ok: false,
      reason: "needs_pillar_media",
      detail: `import target ${target.row.id} (${target.kind}) has no Descript project and no archived media`,
    };
  }

  // When source IS the pillar (no upstream parent), anchor matching is
  // degenerate — source IS target. No transcript required for the cut
  // because the new composition is just a cross-aspect of the same media.
  if (target.kind === "source-as-pillar") return { ok: true };

  // Source is a derivative; we'll need to anchor its spoken content in
  // the target's transcript. Require word-level Whisper transcripts on
  // both ends so `findAnchorInWords` can pin exact timestamps.
  const ids = [source.id, target.row.id];
  const rows = await db
    .select({
      productionItemId: transcripts.productionItemId,
      hasWords: sql<boolean>`${transcripts.words} IS NOT NULL`.as("has_words"),
    })
    .from(transcripts)
    .where(inArray(transcripts.productionItemId, ids));
  const byId = new Map(rows.map((r) => [r.productionItemId, r.hasWords]));
  if (!byId.get(source.id)) {
    return {
      ok: false,
      reason: "needs_transcript",
      detail: `source ${source.id} has no Whisper transcript with word-level timestamps; can't anchor its segment in the pillar`,
    };
  }
  if (!byId.get(target.row.id)) {
    return {
      ok: false,
      reason: "needs_transcript",
      detail: `pillar ${target.row.id} has no Whisper transcript with word-level timestamps; can't search for the source's segment`,
    };
  }
  return { ok: true };
}

/** Why a repost is blocked. Distinct from CrossPostReadinessReason because
 *  repost never depends on the pillar — there's no transcript-anchoring
 *  step, so `needs_transcript` doesn't apply. */
export type RepostReadinessReason = "needs_source_media";

export type RepostReadiness =
  | { ok: true }
  | { ok: false; reason: RepostReadinessReason; detail: string };

/**
 * Repost / cross-post readiness gate. A same-platform repost or a
 * different-platform cross-post only needs the source's own material:
 *   - Source has its own composition → OK (duplicate in-place).
 *   - Source has its own `mediaS3Key` (legacy single-video column) → OK
 *     (cold-import + duplicate the seed on retry; cut range is "full
 *     duration", no anchor search).
 *   - Source has carousel image rows in `production_item_media`
 *     (`hasCarouselMedia=true`) → OK (`seedRepostContent` mirrors the
 *     rows onto the new item, no Descript step required for images).
 *   - None of the above → refuse with `needs_source_media`.
 *
 * The pillar is intentionally never consulted: a Reel's already-cropped
 * pixels ARE the correct repost material when the target aspect is the
 * same. The repost/cross-post routes' pre-gate enrichment step
 * (`enrichSingleItem(..., { withMedia: true })`) usually backfills
 * `mediaS3Key` for video-bearing sources before this is called.
 *
 * `hasCarouselMedia` MUST be passed by the caller — Drizzle is async,
 * this is sync. Both routes already call `hasAnyCarouselRow(source.id)`
 * for the pre-enrichment branch; thread the same value through here.
 * Image-only sources (carousels of photos with no video) failed this
 * gate before 2026-05-21 even though the cross-post flow handled them
 * natively via `seedRepostContent`.
 */
export function checkRepostReadiness(
  source: DescriptableSource,
  hasCarouselMedia = false,
): RepostReadiness {
  if (source.descriptCompositionId) return { ok: true };
  if (source.mediaS3Key) return { ok: true };
  if (hasCarouselMedia) return { ok: true };
  return {
    ok: false,
    reason: "needs_source_media",
    detail: `source ${source.id} has no Descript composition, no archived video, and no carousel image rows to mirror`,
  };
}

/**
 * Load the pillar for a source item. Returns null if the source has no
 * pillar_content_item_id (i.e. the source IS a pillar, or it's an orphan).
 */
export async function loadPillarForSource(
  source: Pick<DescriptableSource, "pillarContentItemId">,
): Promise<DescriptablePillar | null> {
  if (!source.pillarContentItemId) return null;
  const [pillar] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      descriptProjectId: productionItems.descriptProjectId,
      descriptProjectUrl: productionItems.descriptProjectUrl,
      descriptSeedCompositionId: productionItems.descriptSeedCompositionId,
      mediaS3Key: productionItems.mediaS3Key,
    })
    .from(productionItems)
    .where(eq(productionItems.id, source.pillarContentItemId))
    .limit(1);
  return pillar ?? null;
}

export interface ColdImportResult {
  jobId: string;
  projectId: string;
  projectUrl: string | null;
  /** True if we actually kicked off a new import. False if another caller
   *  already imported the pillar between our read and our write — in that
   *  case `projectId` reflects the pillar's existing project. */
  imported: boolean;
}

/**
 * Cold-import a pillar's media into Descript: presign the S3 URL, call
 * `createDescriptProjectFromUrl`, and stamp the pillar's project_id +
 * project_url + descript_imported_at. The new composition's id arrives
 * async — callers should enqueue `descript-clip-resolve` with
 * `importMode: true` and `pillarItemId: pillar.id` so the resolver fills in
 * the pillar's `descript_seed_composition_id`.
 *
 * Re-entrancy: uses SELECT … FOR UPDATE to serialize on the pillar row, so
 * two parallel callers don't both import. Whichever transaction lands
 * second sees `descript_project_id` already set and returns `imported:false`
 * with the existing project info.
 */
export async function coldImportPillar(args: {
  pillarId: string;
}): Promise<ColdImportResult> {
  return await db.transaction(async (tx) => {
    const [pillar] = await tx
      .select({
        id: productionItems.id,
        title: productionItems.title,
        descriptProjectId: productionItems.descriptProjectId,
        descriptProjectUrl: productionItems.descriptProjectUrl,
        mediaS3Key: productionItems.mediaS3Key,
        mediaS3Bucket: productionItems.mediaS3Bucket,
      })
      .from(productionItems)
      .where(eq(productionItems.id, args.pillarId))
      .for("update")
      .limit(1);

    if (!pillar) {
      throw new Error(`coldImportPillar: pillar ${args.pillarId} not found`);
    }

    if (pillar.descriptProjectId) {
      return {
        jobId: "",
        projectId: pillar.descriptProjectId,
        projectUrl: pillar.descriptProjectUrl,
        imported: false,
      };
    }

    if (!pillar.mediaS3Key) {
      throw new Error(
        `coldImportPillar: pillar ${args.pillarId} has no mediaS3Key to import`,
      );
    }

    const presigned = await getPresignedGetUrl(pillar.mediaS3Key, 3600, {
      bucket: pillar.mediaS3Bucket ?? undefined,
    });
    const projectName = pillar.title ?? `Pillar ${pillar.id.slice(0, 8)}`;
    const importRes = await createDescriptProjectFromUrl({
      projectName,
      mediaUrl: presigned,
    });

    await tx
      .update(productionItems)
      .set({
        descriptProjectId: importRes.project_id,
        descriptProjectUrl: importRes.project_url,
        descriptImportedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(productionItems.id, pillar.id));

    return {
      jobId: importRes.job_id,
      projectId: importRes.project_id,
      projectUrl: importRes.project_url,
      imported: true,
    };
  });
}
