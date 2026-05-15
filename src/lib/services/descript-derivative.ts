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
 * Returns true when there is *some* path to a Descript composition for this
 * source — either it already has one, its pillar has a seed, or there is
 * media we can cold-import. Used by cross-post/repost routes (server gate),
 * the item detail API (UI button state), and the derivative-create task
 * (re-check before doing work).
 *
 * A source with no composition, no media of its own, and no pillar-with-media
 * cannot be cross-posted or reposted with Descript — the UI disables those
 * actions.
 */
export function hasDescriptableMedia(
  source: DescriptableSource,
  pillar: DescriptablePillar | null,
): boolean {
  if (source.descriptCompositionId) return true;
  if (source.mediaS3Key) return true;
  if (pillar?.descriptProjectId && pillar.descriptSeedCompositionId)
    return true;
  if (pillar?.mediaS3Key) return true;
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
