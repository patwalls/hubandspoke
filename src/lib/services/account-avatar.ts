/**
 * Durable account avatars. Platform avatar URLs expire (Instagram's CDN
 * links rotate within days), so the simulator, the AccountBadge and the
 * design editor's channel element all showed a monogram once they did.
 * `archiveAccountAvatar` copies the picture to S3 and points `avatar_url`
 * at our media proxy; `avatarFetchUrl` turns that back into something a
 * server-side fetch (the render worker) can read.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { getPresignedGetUrl, putObject } from "@/lib/s3";

const PROXY_PREFIX = "/api/media-proxy?key=";
const MAX_BYTES = 8 * 1024 * 1024;

export function isProxiedAvatar(url: string | null | undefined): boolean {
  return !!url && url.startsWith(PROXY_PREFIX);
}

/** The S3 key behind a proxied avatar URL, or null. */
export function proxiedAvatarKey(url: string | null | undefined): string | null {
  if (!isProxiedAvatar(url)) return null;
  return decodeURIComponent(url!.slice(PROXY_PREFIX.length));
}

/** A URL a server-side `fetch` can read: presigned S3 for our copies,
 *  the platform URL otherwise. */
export async function avatarFetchUrl(avatarUrl: string | null | undefined): Promise<string | null> {
  if (!avatarUrl) return null;
  const key = proxiedAvatarKey(avatarUrl);
  return key ? getPresignedGetUrl(key, 3600) : avatarUrl;
}

function keyPrefix(): string {
  return (process.env.HUBANDSPOKE_S3_PREFIX ?? "hubandspoke/uploads").replace(/\/+$/, "");
}

/** Platforms hand out thumbnail-sized avatars (YouTube's `=s68-c-k…`);
 *  the same URL serves bigger sizes on request. Ask for one that still
 *  looks sharp drawn at 100px on a 1080 canvas. */
export function largestAvatarVariant(url: string): string {
  return url.replace(/=s\d+(-[a-z0-9-]+)?$/i, "=s400$1");
}

/**
 * Fetch the platform's avatar and store our copy. Returns the new S3 key,
 * or null when nothing was archived (same source as last time, not an
 * image, unreachable). Never throws — an avatar is not worth failing a
 * refresh over.
 */
export async function archiveAccountAvatar(accountId: string, sourceUrl: string | null | undefined): Promise<string | null> {
  if (!sourceUrl || isProxiedAvatar(sourceUrl)) return null;
  try {
    const [row] = await db.select({ sourceUrl: accounts.avatarSourceUrl, key: accounts.avatarS3Key, avatarUrl: accounts.avatarUrl }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (row?.key && row.sourceUrl === sourceUrl) {
      // Same picture as last time — but the refresh that called us has just
      // written the platform URL back over `avatar_url`; point it at our
      // copy again or every refresh un-proxies the avatar (2026-09-21).
      const proxied = `${PROXY_PREFIX}${encodeURIComponent(row.key)}`;
      if (row.avatarUrl !== proxied) await db.update(accounts).set({ avatarUrl: proxied }).where(eq(accounts.id, accountId));
      return row.key;
    }
    const res = await fetch(largestAvatarVariant(sourceUrl));
    if (!res.ok) return null;
    const type = res.headers.get("content-type")?.split(";")[0] ?? "";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "image/gif" ? "gif" : "jpg";
    const hash = createHash("sha1").update(buf).digest("hex").slice(0, 10);
    const key = `${keyPrefix()}/accounts/${accountId}/avatar-${hash}.${ext}`;
    await putObject(key, buf, type);
    await db
      .update(accounts)
      .set({ avatarS3Key: key, avatarSourceUrl: sourceUrl, avatarUrl: `${PROXY_PREFIX}${encodeURIComponent(key)}`, updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
    return key;
  } catch (err) {
    console.warn(`[account-avatar] archive failed for ${accountId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
