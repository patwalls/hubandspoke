/**
 * The brand's accounts as the design editor's channel elements see them —
 * live from `accounts` (refreshed by account-refresh), never stored in a
 * document.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, brands } from "@/lib/db/schema";
import { resolveChannel, resolveChannelsInDoc, type ChannelInfo } from "@/lib/design-editor/channel";

export async function loadBrandChannels(brandSlug: string): Promise<ChannelInfo[]> {
  const rows = await db
    .select({
      id: accounts.id,
      platform: accounts.platform,
      displayName: accounts.displayName,
      handle: accounts.handle,
      avatarUrl: accounts.avatarUrl,
      followerCount: accounts.followerCount,
      verified: accounts.verified,
      label: brands.label,
    })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(and(eq(brands.slug, brandSlug)))
    .orderBy(desc(accounts.followerCount));
  return rows.map((r) => ({
    accountId: r.id,
    platform: r.platform,
    name: r.displayName ?? r.label ?? r.handle ?? "Channel",
    handle: r.handle,
    // Our durable copy when there is one (a same-origin proxy URL the
    // browser can load); the render task presigns it (`avatarFetchUrl`).
    avatarUrl: r.avatarUrl,
    followerCount: r.followerCount,
    // Our own brand accounts carry the tick on the platforms that show one.
    verified: r.verified ?? true,
  }));
}

export { resolveChannel, resolveChannelsInDoc };
