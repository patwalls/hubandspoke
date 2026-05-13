import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  createCanvaAutofill,
  fetchCanvaAutofillJob,
  uploadCanvaAssetAndWait,
} from "@/lib/canva";
import { extractCanvaSlideText } from "@/lib/canva-text-extractor";
import { getPresignedGetUrl } from "@/lib/s3";
import { recordToolAction } from "@/lib/services/content-events";

export interface CanvaCreateCopyPayload {
  productionItemId: string;
  brandTemplateId: string;
  /** Optional override. When unset (the normal case from
   *  /api/production-items/[id]/repurpose), the task extracts text fields
   *  from the pillar transcript via Claude. Setting this skips extraction —
   *  used by manual redrives that want to feed handcrafted copy. */
  textFields?: Record<string, string>;
  /** Set after the first invocation creates the autofill job. */
  jobId?: string;
  /** Epoch ms. Set on the first invocation; carried forward across re-enqueues. */
  deadlineAt?: number;
}

// Empty 5s poll cadence + 5min total — Canva autofill jobs typically settle
// in 5-15 seconds in our smoke runs. 5min is the cliff we throw past so a
// stuck job surfaces as a worker failure rather than silently churning.
const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 5 * 60 * 1000;

/**
 * Run a single phase of the Canva "create autofilled copy from a brand
 * template" flow. Two phases compressed into one task:
 *
 *   1. First invocation (no jobId in payload): create the autofill job
 *      against Canva, stamp `canva_autofill_job_id` on the productionItem,
 *      then re-enqueue ourselves with `jobId` set + a 5s delay.
 *
 *   2. Subsequent invocations: poll the job once. On success, write the
 *      design id + edit URL back to the productionItem, clear the in-flight
 *      job-id pointer, and emit a `recordToolAction("canva", "design_created")`
 *      event so the activity feed picks it up. On failure, throw so
 *      graphile-worker retries with exponential backoff. On in-progress,
 *      re-enqueue with another 5s delay if still inside the deadline.
 *
 * Each invocation stays under 1s of synchronous work + one HTTP call so
 * SIGTERM during a deploy can never catch us mid-step. The job's row-lock
 * never leaks even if Heroku kills the dyno.
 */
export const canvaCreateCopyTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as CanvaCreateCopyPayload;
  const deadlineAt = payload.deadlineAt ?? Date.now() + DEADLINE_MS;

  // First phase: extract slide text from the pillar (skippable via
  // payload.textFields override) and create the autofill job.
  if (!payload.jobId) {
    const [item] = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        pillarContentItemId: productionItems.pillarContentItemId,
      })
      .from(productionItems)
      .where(eq(productionItems.id, payload.productionItemId))
      .limit(1);
    if (!item) {
      helpers.logger.warn(
        `canva-create-copy: production_item ${payload.productionItemId} not found, dropping`,
      );
      return;
    }
    const title = item.title
      ? `${item.title} — IG Post`
      : "IG Post (Canva autofill)";

    let textFields = payload.textFields;
    if (!textFields) {
      const extracted = await extractCanvaSlideText(payload.productionItemId);
      textFields = {
        hook: extracted.hook,
        stack_list: extracted.stack_list,
        cta: extracted.cta,
      };
      helpers.logger.info(
        `canva-create-copy extracted text for item=${payload.productionItemId} hookChars=${extracted.hook.length}`,
      );
    }

    // Hero image (page 1 background). Pull the pillar's poster_s3_key —
    // that's the YouTube thumbnail / scraped cover, which is usually a
    // founder shot for our Business Breakdown pillars. Upload to Canva
    // and reference by asset_id in the autofill payload. Best-effort:
    // a missing poster or a failed upload just means we skip the
    // hero_image field, and the template renders its default placeholder.
    const imageAssetIds: Record<string, string> = {};
    const heroSourceId = item.pillarContentItemId ?? item.id;
    const [heroSource] = await db
      .select({ posterS3Key: productionItems.posterS3Key })
      .from(productionItems)
      .where(eq(productionItems.id, heroSourceId))
      .limit(1);
    if (heroSource?.posterS3Key) {
      try {
        const presignedUrl = await getPresignedGetUrl(heroSource.posterS3Key, 300);
        const imgRes = await fetch(presignedUrl);
        if (!imgRes.ok) {
          throw new Error(`pillar poster fetch HTTP ${imgRes.status}`);
        }
        const buf = Buffer.from(await imgRes.arrayBuffer());
        // Keep the filename short + alphanumeric — Canva's
        // Asset-Upload-Metadata header parser rejected longer UUID-based
        // names with "Invalid upload metadata header" even though shorter
        // names work. Cosmetic field only; not a content gate.
        const shortId = heroSourceId.replace(/-/g, "").slice(0, 8);
        const upload = await uploadCanvaAssetAndWait({
          bytes: buf,
          fileName: `pillar${shortId}.jpg`,
        });
        imageAssetIds.hero_image = upload.assetId;
        helpers.logger.info(
          `canva-create-copy uploaded hero_image asset=${upload.assetId} for item=${payload.productionItemId}`,
        );
      } catch (err) {
        helpers.logger.warn(
          `canva-create-copy: hero_image upload skipped for item=${payload.productionItemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const { jobId } = await createCanvaAutofill({
      brandTemplateId: payload.brandTemplateId,
      title,
      textFields,
      imageAssetIds,
    });

    await db
      .update(productionItems)
      .set({ canvaAutofillJobId: jobId })
      .where(eq(productionItems.id, payload.productionItemId));

    await helpers.addJob(
      "canva-create-copy",
      { ...payload, jobId, deadlineAt },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
    helpers.logger.info(
      `canva-create-copy created job ${jobId} for item ${payload.productionItemId}`,
    );
    return;
  }

  // Second phase: poll.
  const result = await fetchCanvaAutofillJob(payload.jobId);
  if (result.status === "success") {
    const editUrl = result.editUrl ?? null;
    const designId = result.designId ?? null;
    await db
      .update(productionItems)
      .set({
        canvaDesignId: designId,
        canvaEditUrl: editUrl,
        canvaAutofillJobId: null,
      })
      .where(eq(productionItems.id, payload.productionItemId));

    const [item] = await db
      .select({ editorUserId: productionItems.editorUserId })
      .from(productionItems)
      .where(eq(productionItems.id, payload.productionItemId))
      .limit(1);

    await recordToolAction({
      contentItemId: payload.productionItemId,
      userId: item?.editorUserId ?? null,
      tool: "canva",
      action: "design_created",
      status: "success",
      label: "Design ready in Canva",
      url: editUrl,
      meta: {
        brandTemplateId: payload.brandTemplateId,
        ...(result.pageCount ? { pageCount: result.pageCount } : {}),
      },
    });

    // Auto-chain: export the design's pages as PNGs and archive into S3 so
    // the IG-Post simulator on the detail page renders the slides
    // immediately. Idempotent — re-running the export rewrites the same
    // production_item_media rows keyed by index. Fire-and-forget; a failed
    // enqueue must not unwind the design creation.
    if (designId) {
      try {
        await helpers.addJob("canva-export-design", {
          productionItemId: payload.productionItemId,
          designId,
        });
      } catch (err) {
        helpers.logger.warn(
          `canva-create-copy: failed to enqueue canva-export-design for item ${payload.productionItemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    helpers.logger.info(
      `canva-create-copy ok item=${payload.productionItemId} design=${designId} url=${editUrl}`,
    );
    return;
  }

  if (result.status === "failed") {
    // Throw so graphile-worker retries with exponential backoff. Once
    // attempts are exhausted the row will still have canvaAutofillJobId
    // set, which is the operator's signal to investigate.
    throw new Error(
      `Canva autofill job ${payload.jobId} failed: ${result.errorMessage ?? "unknown"}`,
    );
  }

  // In-progress: re-enqueue if still inside the deadline; otherwise blow up.
  if (Date.now() >= deadlineAt) {
    throw new Error(
      `Canva autofill job ${payload.jobId} did not finish before deadline`,
    );
  }
  await helpers.addJob(
    "canva-create-copy",
    { ...payload, deadlineAt },
    { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
  );
};
