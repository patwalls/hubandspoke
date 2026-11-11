/**
 * Enhance (AI upscale) for design-editor pictures: request + status. The
 * work happens on the worker (`design-enhance`, ~1 minute per picture —
 * past the 30s router limit), the result lands in the source video's photo
 * library as `design_photos` kind `enhanced`, keyed by `enhanceSourceKey`
 * so the same picture enhanced the same way is made once and reused by
 * every post from that video. Pure rules: lib/design-editor/enhance.ts.
 */
import { createHash } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designPhotos } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import type { ImageSource } from "@/lib/editor/image-source";
import { enhanceSourceKey } from "@/lib/design-editor/enhance";
import { toPhoto, type DesignPhoto } from "./photos";

export type EnhanceStatus =
  | { state: "done"; photo: DesignPhoto }
  | { state: "pending" }
  | { state: "failed"; error: string }
  | { state: "none" };

export const ENHANCE_MAX_ATTEMPTS = 2;

export function enhanceJobKey(sourceItemId: string, sourceKey: string): string {
  return `design-enhance:${sourceItemId}:${createHash("sha1").update(sourceKey).digest("hex").slice(0, 16)}`;
}

export async function enhancedPhotoRow(sourceItemId: string, sourceKey: string) {
  const [row] = await db
    .select()
    .from(designPhotos)
    .where(and(eq(designPhotos.productionItemId, sourceItemId), eq(designPhotos.kind, "enhanced"), eq(designPhotos.sourceKey, sourceKey)))
    .orderBy(desc(designPhotos.createdAt))
    .limit(1);
  return row ?? null;
}

export async function enhanceStatus(sourceItemId: string, src: ImageSource, blur: boolean): Promise<EnhanceStatus> {
  const sourceKey = enhanceSourceKey(src, blur);
  const row = await enhancedPhotoRow(sourceItemId, sourceKey);
  if (row) return { state: "done", photo: await toPhoto(row) };
  const jobs = (await db.execute(
    sql`SELECT attempts, max_attempts, last_error FROM graphile_worker.jobs WHERE key = ${enhanceJobKey(sourceItemId, sourceKey)} LIMIT 1`,
  )) as unknown as Array<{ attempts: number; max_attempts: number; last_error: string | null }>;
  const job = jobs[0];
  if (!job) return { state: "none" };
  if (job.attempts >= job.max_attempts) return { state: "failed", error: friendlyError(job.last_error) };
  return { state: "pending" };
}

/** Start an enhancement unless it's already made or running. A failed one
 *  is retried (the job key's `replace` resets the dead job). */
export async function requestEnhance(args: { sourceItemId: string; src: ImageSource; blur: boolean; userId: string | null }): Promise<EnhanceStatus> {
  const status = await enhanceStatus(args.sourceItemId, args.src, args.blur);
  if (status.state === "done" || status.state === "pending") return status;
  await enqueue(
    "design-enhance",
    { sourceItemId: args.sourceItemId, src: args.src, blur: args.blur, userId: args.userId },
    { jobKey: enhanceJobKey(args.sourceItemId, enhanceSourceKey(args.src, args.blur)), jobKeyMode: "replace", maxAttempts: ENHANCE_MAX_ATTEMPTS },
  );
  return { state: "pending" };
}

/** The first line of a worker error, minus the stack. */
function friendlyError(lastError: string | null): string {
  const first = (lastError ?? "").split("\n")[0].replace(/^Error:\s*/, "").trim();
  return first.slice(0, 240) || "The enhancer failed";
}
