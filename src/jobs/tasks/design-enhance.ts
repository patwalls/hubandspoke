// Worker-only: "Enhance" a design-editor picture — the AI upscale. One
// OpenAI gpt-image-2 edit (~40–70s) redraws the picture at ~2048px with
// clean detail (and optionally a portrait-lens background blur), keeping
// the person and framing; the result is stored in the source video's
// photo library as `design_photos` kind `enhanced`. Model choice and size
// rules: src/lib/design-editor/enhance.ts. Never touches a design document
// — the editor swaps the picture in when it sees the photo.
//
// Bounded: the source download has a 30s timeout, the OpenAI call a 3 min
// one, and both take `helpers.abortSignal` so a deploy's SIGTERM ends the
// task inside graphile's grace window. Not on `media-heavy`: it's one HTTP
// call, no ffmpeg, so it shouldn't wait behind renders.
import type { Task } from "graphile-worker";
import OpenAI, { toFile } from "openai";
import { fetch as undiciFetch } from "undici";
import { imageSize } from "image-size";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { designPhotos } from "@/lib/db/schema";
import { bucketName, buildKey, getPresignedGetUrl, isAppBucket, putObject } from "@/lib/s3";
import { assertPublicUrl, publicOnlyDispatcher } from "@/lib/net/public-url";
import type { ImageSource } from "@/lib/editor/image-source";
import { ENHANCE_MODEL, canEnhance, enhanceOutputSize, enhancePrompt, enhanceSourceKey } from "@/lib/design-editor/enhance";
import { enhancedPhotoRow } from "@/lib/services/design-editor/enhance";

export interface DesignEnhancePayload {
  /** The SOURCE (pillar) item whose library gets the enhanced picture. */
  sourceItemId: string;
  src: ImageSource;
  blur: boolean;
  userId: string | null;
}

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const OPENAI_TIMEOUT_MS = 180_000;

let _openai: OpenAI | null = null;
const openai = () => (_openai ??= new OpenAI());

async function loadSource(src: ImageSource, signal: AbortSignal): Promise<{ buf: Buffer; type: string }> {
  if (!canEnhance(src)) throw new Error("Only stored or https pictures can be enhanced");
  let res: Response | Awaited<ReturnType<typeof undiciFetch>>;
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  if (src.kind === "s3") {
    if (src.bucket && !isAppBucket(src.bucket)) throw new Error("Not one of our buckets");
    res = await fetch(await getPresignedGetUrl(src.key, 600, src.bucket ? { bucket: src.bucket } : undefined), { signal: timeout });
  } else if (src.kind === "url") {
    await assertPublicUrl(src.url);
    res = await undiciFetch(src.url, { signal: timeout, dispatcher: publicOnlyDispatcher });
  } else throw new Error("Unsupported picture");
  if (!res.ok) throw new Error(`Couldn't download the picture (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_SOURCE_BYTES) throw new Error("Picture is over 25 MB");
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  return { buf, type: /^image\/(jpeg|png|webp)$/.test(type) ? type : "image/jpeg" };
}

export const designEnhanceTask: Task = async (rawPayload, helpers) => {
  const { sourceItemId, src, blur, userId } = rawPayload as DesignEnhancePayload;
  const sourceKey = enhanceSourceKey(src, blur);
  if (await enhancedPhotoRow(sourceItemId, sourceKey)) return; // a retry after success

  const t0 = Date.now();
  const { buf, type } = await loadSource(src, helpers.abortSignal ?? new AbortController().signal);
  let dims: { width?: number; height?: number } = {};
  try {
    dims = imageSize(buf);
  } catch {
    throw new Error("That file isn't a readable image");
  }
  const size = enhanceOutputSize(dims.width ?? 0, dims.height ?? 0);
  helpers.logger.info(`design-enhance start source=${sourceItemId} blur=${blur} in=${dims.width}x${dims.height} out=${size.width}x${size.height}`);

  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  const result = await openai().images.edit(
    {
      model: ENHANCE_MODEL,
      image: await toFile(buf, `picture.${ext}`, { type }),
      prompt: enhancePrompt(blur),
      // gpt-image-2 takes any multiple-of-16 size; the SDK's enum predates it.
      size: `${size.width}x${size.height}` as "1024x1024",
      quality: "high",
      output_format: "jpeg",
      output_compression: 92,
    },
    { timeout: OPENAI_TIMEOUT_MS, maxRetries: 1, signal: helpers.abortSignal },
  );
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("The enhancer returned no picture");
  const out = Buffer.from(b64, "base64");
  const outDims = imageSize(out);

  const key = buildKey(sourceItemId, `design-enhanced${blur ? "-blur" : ""}-${Date.now()}.jpg`);
  await putObject(key, out, "image/jpeg");
  // One per picture × mode: a redo replaces the old row (its object stays —
  // a document may still reference it).
  await db.delete(designPhotos).where(and(eq(designPhotos.productionItemId, sourceItemId), eq(designPhotos.kind, "enhanced"), eq(designPhotos.sourceKey, sourceKey)));
  await db.insert(designPhotos).values({
    productionItemId: sourceItemId,
    kind: "enhanced",
    label: blur ? "Enhanced · background blurred" : "Enhanced",
    s3Bucket: bucketName(),
    s3Key: key,
    width: outDims.width ?? size.width,
    height: outDims.height ?? size.height,
    sourceKey,
    createdByUserId: userId,
  });
  helpers.logger.info(`design-enhance done source=${sourceItemId} ${((Date.now() - t0) / 1000).toFixed(1)}s tokens=${result.usage?.total_tokens ?? "?"}`);
};
