import { db } from "@/lib/db";
import { accounts, brands, formatChannels, formats } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { PostType } from "@/lib/platform-field-schemas";

// One persisted publishing target on a format: which social account, in what
// post-type shape. post_type is null for the "other" buckets (SS Case Study,
// Paid Ad, etc.) where the production item isn't a canonical social post.
export interface FormatChannelInput {
  accountId: string;
  postType: PostType | null;
}

// Joined shape returned to the UI. The account fields are everything the
// AccountBadge / AccountPostTypePicker need to render without a second query.
export interface FormatChannelWithAccount {
  accountId: string;
  postType: PostType | null;
  account: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    brandSlug: string;
    brandLabel: string;
  };
}

// Reverse of resolveAccount in scripts/backfill-accounts.mjs — given a
// (brand, account, post_type) triple, return the legacy `formats.channels`
// jsonb string. Lets the API keep that column in sync so unmigrated readers
// (formats list page, global search) keep rendering chips without changes.
// Returns null for combinations the legacy model never had a label for.
export function legacyChannelString(
  brandSlug: string,
  account: { platform: string; handle: string },
  postType: string | null
): string | null {
  const platform = account.platform;
  const handle = account.handle.toLowerCase();

  if (brandSlug === "matg") {
    if (platform === "youtube" && postType === "youtube_long") return "YouTube";
    if (platform === "youtube" && postType === "youtube_shorts") return "YouTube Shorts";
    if (platform === "youtube" && postType === "youtube_community") return "YouTube Community";
    if (platform === "instagram" && postType === "instagram_reel") return "Instagram Reel";
    if (platform === "instagram" && postType === "instagram_post") return "Instagram Post";
    if (platform === "instagram" && postType === "instagram_story") return "Instagram Story";
    if (platform === "x") return "X";
    if (platform === "linkedin") return "LinkedIn";
    if (platform === "tiktok") return "TikTok";
    if (platform === "threads") return "Threads";
    return null;
  }

  // starter-story
  if (platform === "youtube" && handle === "starterstory" && postType === "youtube_long") return "YouTube (SS)";
  if (platform === "youtube" && handle === "starterstorybuild" && postType === "youtube_long") return "YouTube (SS Build)";
  if (platform === "youtube" && postType === "youtube_shorts") return "YouTube Shorts";
  if (platform === "youtube" && postType === "youtube_community") return "YouTube Community";

  if (platform === "x" && handle === "starterstory") return "X (Starter Story)";
  if (platform === "x" && handle === "thepatwalls") return "X (Pat Walls)";

  if (platform === "instagram" && postType === "instagram_reel") return "Instagram Reel";
  if (platform === "instagram" && postType === "instagram_post") return "Instagram Post";
  if (platform === "instagram" && postType === "instagram_story") return "Instagram Story";

  if (platform === "linkedin") return "LinkedIn";
  if (platform === "tiktok") return "TikTok";
  if (platform === "threads") return "Threads";
  if (platform === "newsletter") return "Newsletter";

  if (platform === "other" && handle === "ss-case-study") return "SS Case Study";
  if (platform === "other" && handle === "ss-database") return "SS Database";
  if (platform === "other" && handle === "paid-ad") return "Paid Ad";

  return null;
}

// Read all channels for a set of formats in one round-trip. Returns a Map
// keyed by formatId so callers can attach to each format row without an N+1.
export async function getChannelsForFormats(
  formatIds: string[]
): Promise<Map<string, FormatChannelWithAccount[]>> {
  const out = new Map<string, FormatChannelWithAccount[]>();
  if (formatIds.length === 0) return out;
  const rows = await db
    .select({
      formatId: formatChannels.formatId,
      accountId: formatChannels.accountId,
      postType: formatChannels.postType,
      accountPlatform: accounts.platform,
      accountHandle: accounts.handle,
      accountDisplayName: accounts.displayName,
      accountAvatarUrl: accounts.avatarUrl,
      brandSlug: brands.slug,
      brandLabel: brands.label,
    })
    .from(formatChannels)
    .innerJoin(accounts, eq(accounts.id, formatChannels.accountId))
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(inArray(formatChannels.formatId, formatIds));
  for (const r of rows) {
    const arr = out.get(r.formatId) ?? [];
    arr.push({
      accountId: r.accountId,
      postType: (r.postType as PostType | null) ?? null,
      account: {
        id: r.accountId,
        platform: r.accountPlatform,
        handle: r.accountHandle,
        displayName: r.accountDisplayName,
        avatarUrl: r.accountAvatarUrl ?? null,
        brandSlug: r.brandSlug,
        brandLabel: r.brandLabel,
      },
    });
    out.set(r.formatId, arr);
  }
  return out;
}

// Replace a format's channels with `inputs`. Idempotent: deletes existing
// rows then inserts the new set, all inside a single transaction. Also
// updates the legacy formats.channels jsonb mirror so unmigrated consumers
// keep rendering correct chips.
export async function setFormatChannels(
  formatId: string,
  inputs: FormatChannelInput[]
): Promise<void> {
  const accountIds = Array.from(new Set(inputs.map((i) => i.accountId)));
  const accountRows = accountIds.length
    ? await db
        .select({
          id: accounts.id,
          platform: accounts.platform,
          handle: accounts.handle,
          brandSlug: brands.slug,
        })
        .from(accounts)
        .innerJoin(brands, eq(brands.id, accounts.brandId))
        .where(inArray(accounts.id, accountIds))
    : [];
  const accountById = new Map(accountRows.map((a) => [a.id, a]));

  // Build the legacy string mirror in input order so chip ordering on the
  // formats list page matches what the user picked.
  const legacy: string[] = [];
  for (const i of inputs) {
    const a = accountById.get(i.accountId);
    if (!a) continue;
    const s = legacyChannelString(a.brandSlug, a, i.postType);
    if (s && !legacy.includes(s)) legacy.push(s);
  }

  await db.transaction(async (tx) => {
    await tx.delete(formatChannels).where(eq(formatChannels.formatId, formatId));
    if (inputs.length > 0) {
      // Dedupe by (accountId, postType) to satisfy the unique index.
      const seen = new Set<string>();
      const rows: { formatId: string; accountId: string; postType: string | null }[] = [];
      for (const i of inputs) {
        const key = `${i.accountId}|${i.postType ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          formatId,
          accountId: i.accountId,
          postType: i.postType ?? null,
        });
      }
      if (rows.length) await tx.insert(formatChannels).values(rows);
    }
    await tx
      .update(formats)
      .set({ channels: legacy, updatedAt: new Date() })
      .where(eq(formats.id, formatId));
  });
}
