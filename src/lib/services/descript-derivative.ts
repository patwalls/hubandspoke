import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
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

    const presigned = await getPresignedGetUrl(pillar.mediaS3Key, 3600);
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
