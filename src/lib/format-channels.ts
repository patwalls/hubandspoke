import { db } from "@/lib/db";
import { accounts, brands, formatChannels } from "@/lib/db/schema";
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
// rows then inserts the new set, all inside a single transaction.
export async function setFormatChannels(
  formatId: string,
  inputs: FormatChannelInput[]
): Promise<void> {
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
  });
}
