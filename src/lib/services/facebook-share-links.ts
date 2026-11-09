/**
 * Facebook posts saved with a share link (`facebook.com/share/p/…`).
 *
 * The Share button hands out a link that names no post, so the account sync
 * can never match it to the post it fetched. The saved row stayed at zero
 * views and the sync added a second, format-less row for the same post.
 *
 * Each Facebook sync follows those links first: the row gets the post's real
 * link, so the sync matches it from then on, and any row the sync already made
 * for that post is merged into the saved one.
 */

import { and, desc, eq, isNull, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  canonicalFacebookPostUrl,
  isFacebookShareLink,
  looseUrlKey,
} from "@/lib/platform-url";
import { recordContentChanges } from "@/lib/services/content-revisions";
import { mergeProductionItems } from "@/lib/services/merge-production-items";

/** Bounds the requests one sync makes; a backlog clears over the next syncs. */
export const MAX_SHARE_LINKS_PER_SYNC = 40;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = "HubAndSpoke-LinkResolver/1.0";

/** Follow a share link to the post it points at. Null when it doesn't get to one. */
export async function resolveFacebookShareLink(
  shareUrl: string
): Promise<string | null> {
  let current = shareUrl;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    let location: string | null;
    try {
      const res = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    } catch {
      return null;
    }
    if (!location) return null;
    const next = new URL(location, current).toString();
    if (!isFacebookShareLink(next)) return canonicalFacebookPostUrl(next);
    current = next;
  }
  return null;
}

export interface ShareLinkSweepResult {
  resolved: number;
  merged: number;
  failed: number;
}

export async function reconcileFacebookShareLinks(
  accountId: string
): Promise<ShareLinkSweepResult> {
  const result: ShareLinkSweepResult = { resolved: 0, merged: 0, failed: 0 };

  const candidates = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      thumbnail: productionItems.thumbnail,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.accountId, accountId),
        eq(productionItems.postType, "facebook_post"),
        isNull(productionItems.platformContentId),
        isNull(productionItems.deletedAt),
        like(productionItems.publishedLink, "%facebook.com/share/%")
      )
    )
    .orderBy(desc(productionItems.publishedDate))
    .limit(MAX_SHARE_LINKS_PER_SYNC);
  if (candidates.length === 0) return result;

  // Only rows the sync made are absorbed. A row a person made for the same
  // post holds their work and isn't ours to delete.
  const syncRows = await db
    .select()
    .from(productionItems)
    .where(
      and(
        eq(productionItems.accountId, accountId),
        eq(productionItems.postType, "facebook_post"),
        eq(productionItems.createdVia, "sync:account-content"),
        isNull(productionItems.deletedAt)
      )
    );
  const syncRowByKey = new Map(
    syncRows.map((r) => [looseUrlKey(r.publishedLink), r])
  );

  for (const row of candidates) {
    const shareLink = row.publishedLink;
    if (!isFacebookShareLink(shareLink)) continue;
    const canonical = await resolveFacebookShareLink(shareLink!);
    if (!canonical) {
      result.failed++;
      console.warn(`[facebook-share-links] could not resolve ${shareLink} item=${row.id}`);
      continue;
    }

    const key = looseUrlKey(canonical);
    const twin = syncRowByKey.get(key) ?? null;
    if (twin) {
      const merge = await mergeProductionItems(row.id, twin.id, null, {
        forceKeeperId: row.id,
      });
      if (!merge.success) {
        result.failed++;
        console.error(`[facebook-share-links] merge failed item=${row.id}: ${merge.message}`);
        continue;
      }
      syncRowByKey.delete(key);
      result.merged++;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(productionItems)
        .set({
          publishedLink: canonical,
          // The merge carries views and the content id; the rest of the
          // numbers the sync collected are copied here.
          ...(twin
            ? {
                likes: twin.likes,
                comments: twin.comments,
                viewsEstimated: twin.viewsEstimated,
                lastPerformanceSyncAt: twin.lastPerformanceSyncAt,
                thumbnail: row.thumbnail ?? twin.thumbnail,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, row.id));
      await recordContentChanges({
        tx,
        contentItemId: row.id,
        userId: null,
        source: { kind: "sync", system: "account-content" },
        changes: [
          {
            target: { kind: "production_item_field", field: "publishedLink" },
            from: shareLink,
            to: canonical,
          },
        ],
      });
    });
    result.resolved++;
  }

  console.log(
    `[facebook-share-links] account=${accountId} resolved=${result.resolved} merged=${result.merged} failed=${result.failed}`
  );
  return result;
}
