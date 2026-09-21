/**
 * A brand's logo library — what "Add a logo" offers in the clip and design
 * editors. Three sources, one list:
 *   1. built-in wordmarks shipped in public/watermarks (Starter Story only —
 *      they are that brand's marks);
 *   2. the brand's account avatars (the durable S3 copy account-refresh keeps,
 *      see account-avatar.ts) — the round profile mark of each channel;
 *   3. uploads, kept per brand in `brand_logos` so a logo uploaded once is
 *      there for every post and both editors.
 * Every entry is an `ImageCandidate`: a durable `src` for the document plus a
 * browser-loadable preview URL.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { imageSize } from "image-size";
import { db } from "@/lib/db";
import { accounts, brandLogos, brands } from "@/lib/db/schema";
import { bucketName, getPresignedGetUrl, keyPrefix, putObject } from "@/lib/s3";
import { BRAND_WORDMARKS, type BrandLogo } from "@/lib/design-editor/brand-assets";
import type { DesignImageSource } from "@/lib/design-editor/doc";

export type { BrandLogo };

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function listBrandLogos(brand: string): Promise<BrandLogo[]> {
  const out: BrandLogo[] = [];
  if (brand === "starter-story") {
    for (const w of BRAND_WORDMARKS) out.push({ ...w, id: null, group: "wordmark" });
  }
  const avatars = await db
    .select({ platform: accounts.platform, handle: accounts.handle, key: accounts.avatarS3Key })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(and(eq(brands.slug, brand), isNotNull(accounts.avatarS3Key)))
    .orderBy(accounts.platform, accounts.handle);
  for (const a of avatars) {
    if (!a.key) continue;
    const src: DesignImageSource = { kind: "s3", bucket: null, key: a.key };
    out.push({ id: null, group: "avatar", label: `@${a.handle} (${a.platform})`, src, previewUrl: `/api/media-proxy?key=${encodeURIComponent(a.key)}` });
  }
  const uploads = await db.select().from(brandLogos).where(eq(brandLogos.brand, brand)).orderBy(desc(brandLogos.createdAt));
  for (const u of uploads) {
    out.push({
      id: u.id,
      group: "upload",
      label: u.label,
      src: { kind: "s3", bucket: u.s3Bucket, key: u.s3Key },
      previewUrl: await getPresignedGetUrl(u.s3Key, 4 * 3600, { bucket: u.s3Bucket }),
    });
  }
  return out;
}

export class BrandLogoUploadError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BrandLogoUploadError";
  }
}

export async function uploadBrandLogo(args: { brand: string; file: File; userId: string | null }): Promise<BrandLogo> {
  const { file } = args;
  if (!ALLOWED.has(file.type)) throw new BrandLogoUploadError("Use a PNG (transparent works best), JPG or WebP", 415);
  if (file.size > MAX_BYTES) throw new BrandLogoUploadError("Image is over 10 MB", 413);
  const buf = Buffer.from(await file.arrayBuffer());
  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(buf);
  } catch {
    throw new BrandLogoUploadError("That file isn't a readable image", 415);
  }
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const base = (file.name || "logo").replace(/\.[^.]+$/, "");
  const safe = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "logo";
  const key = `${keyPrefix()}/brand-logos/${args.brand}/${crypto.randomUUID()}-${safe}.${ext}`;
  await putObject(key, buf, file.type);
  const [row] = await db
    .insert(brandLogos)
    .values({ brand: args.brand, label: base, s3Bucket: bucketName(), s3Key: key, width: dims.width ?? null, height: dims.height ?? null, createdByUserId: args.userId })
    .returning();
  return {
    id: row.id,
    group: "upload",
    label: row.label,
    src: { kind: "s3", bucket: row.s3Bucket, key: row.s3Key },
    previewUrl: await getPresignedGetUrl(row.s3Key, 4 * 3600, { bucket: row.s3Bucket }),
  };
}

/** Remove an upload from the library. The object stays in S3: a clip or
 *  design that already placed the logo must keep rendering. */
export async function deleteBrandLogo(args: { brand: string; id: string }): Promise<boolean> {
  const [row] = await db
    .delete(brandLogos)
    .where(and(eq(brandLogos.id, args.id), eq(brandLogos.brand, args.brand)))
    .returning({ id: brandLogos.id });
  return !!row;
}
