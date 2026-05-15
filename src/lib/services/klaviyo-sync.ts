/**
 * Klaviyo campaign discovery — pulls Sent email campaigns from Klaviyo and
 * upserts them as `production_items` of post_type='newsletter'. Mirrors the
 * shape of `account-content-sync.ts` for any other channel: select-by-id,
 * upsert with insert-only fields preserved across runs.
 *
 * Body / preview text / metrics are deliberately NOT fetched here. Discovery
 * inserts a minimal row; the existing `enrichment-sweep` (newsletter enricher)
 * fills body + preview text once, and `performance-decay` refreshes opens /
 * clicks on the decay schedule. Same three-sweep separation every other
 * channel uses.
 */

import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, brands, productionItems } from "@/lib/db/schema";
import { resolveEditor } from "@/lib/services/assignees";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { recordItemCreated } from "@/lib/services/item-created";
import { fetchKlaviyo, KlaviyoError } from "@/lib/services/klaviyo-client";

// Default lookback when an account has never synced. 7 days is enough to catch
// anything sent during a deploy / brief outage; backfills use the explicit
// `since` opt instead of widening this default.
const DEFAULT_SINCE_LOOKBACK_DAYS = 7;
const PAGE_SIZE = 50;

export interface SyncKlaviyoOpts {
  /** Earliest send_time to fetch. Defaults to `accounts.lastContentSyncAt`
   *  or `now - 7d` if never synced. */
  since?: Date;
  /** Latest send_time to fetch (exclusive). Defaults to now. Backfills set
   *  this to walk fixed windows. */
  until?: Date;
  /** Page-walk safety cap. The sweep doesn't need this; backfills use it
   *  to fail loud if Klaviyo's pagination misbehaves. */
  maxPages?: number;
}

export interface SyncKlaviyoResult {
  accountId: string;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  pagesFetched: number;
  errors: number;
  errorMessage?: string;
  /** IDs of newly created production_items (so the caller can enqueue
   *  per-item enrich + metrics jobs without re-querying). */
  insertedItemIds: string[];
}

interface KlaviyoCampaignAttributes {
  name?: string;
  status?: string;
  send_time?: string | null;
  scheduled_at?: string | null;
  audiences?: {
    included?: string[];
    excluded?: string[];
  };
  send_options?: Record<string, unknown>;
  archived?: boolean;
}

interface KlaviyoCampaign {
  type: "campaign";
  id: string;
  attributes: KlaviyoCampaignAttributes;
}

interface KlaviyoCampaignsResponse {
  data: KlaviyoCampaign[];
  links?: {
    next?: string | null;
  };
}

/**
 * Sync sent email campaigns for one newsletter account. Idempotent on
 * `(account_id, platform_content_id)` — a re-run never duplicates a campaign,
 * just refreshes its `updatedAt`.
 */
export async function syncKlaviyoCampaigns(
  accountId: string,
  opts: SyncKlaviyoOpts = {},
): Promise<SyncKlaviyoResult> {
  const [account] = await db
    .select({
      id: accounts.id,
      handle: accounts.handle,
      platform: accounts.platform,
      externalId: accounts.externalId,
      lastContentSyncAt: accounts.lastContentSyncAt,
      brandSlug: brands.slug,
    })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account) throw new Error(`klaviyo-sync: account not found ${accountId}`);
  if (account.platform !== "newsletter") {
    throw new Error(
      `klaviyo-sync: account ${accountId} is platform=${account.platform}, expected newsletter`,
    );
  }
  if (!account.externalId) {
    throw new Error(
      `klaviyo-sync: account ${account.handle} has no external_id (Klaviyo list id)`,
    );
  }

  const result: SyncKlaviyoResult = {
    accountId,
    fetched: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    pagesFetched: 0,
    errors: 0,
    insertedItemIds: [],
  };

  const since =
    opts.since ??
    account.lastContentSyncAt ??
    new Date(Date.now() - DEFAULT_SINCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const until = opts.until ?? new Date();
  const maxPages = opts.maxPages ?? 200;

  try {
    let nextUrl: string | null = buildInitialUrl({
      since,
      until,
      pageSize: PAGE_SIZE,
    });
    let pages = 0;

    while (nextUrl && pages < maxPages) {
      const page: KlaviyoCampaignsResponse | null =
        await fetchKlaviyo<KlaviyoCampaignsResponse>(account, nextUrl);
      pages++;
      result.pagesFetched = pages;
      if (!page) break;

      for (const campaign of page.data) {
        const a = campaign.attributes;
        // Skip drafts / scheduled / cancelled — only "Sent" become items.
        if (a.status !== "Sent") {
          result.skipped++;
          continue;
        }
        // Filter to the account's list. Klaviyo sometimes returns campaigns
        // that target a sibling list / segment; we only ingest the ones
        // explicitly aimed at our list to keep the per-account scope clean.
        const included = a.audiences?.included ?? [];
        if (!included.includes(account.externalId)) {
          result.skipped++;
          continue;
        }
        if (!a.send_time) {
          result.skipped++;
          continue;
        }
        result.fetched++;

        const sentAt = new Date(a.send_time);
        if (Number.isNaN(sentAt.getTime())) {
          result.skipped++;
          continue;
        }

        // Find by (account_id, platform_content_id) — the unique key for our
        // dedup. Same select-then-insert/update shape account-content-sync uses.
        const [existing] = await db
          .select({ id: productionItems.id })
          .from(productionItems)
          .where(
            and(
              eq(productionItems.accountId, accountId),
              eq(productionItems.platformContentId, campaign.id),
            ),
          )
          .limit(1);

        const subject = (a.name ?? "").trim() || "(untitled campaign)";
        const publishedDate = sentAt.toISOString().slice(0, 10);
        // No public "view in browser" URL is exposed by the Klaviyo API on
        // the campaign object. We use the dashboard URL so the published-
        // link pill in the UI takes operators to the campaign in Klaviyo.
        // Enrichment will overwrite this if a better URL is recoverable.
        const dashboardUrl = `https://www.klaviyo.com/campaign/${campaign.id}/reports`;

        if (existing) {
          // Update only mutable fields; preserve insert-only columns
          // (createdVia, accountId, sourceType, etc.). Re-affirm the
          // klaviyoListId in case the audience changed.
          await db
            .update(productionItems)
            .set({
              title: subject,
              publishedDate,
              publishedAt: sentAt,
              status: "Published",
              klaviyoListId: account.externalId,
              updatedAt: new Date(),
            })
            .where(eq(productionItems.id, existing.id));
          result.updated++;
          continue;
        }

        const editorUserId = await resolveEditor({
          brand: account.brandSlug,
          format: null,
        });

        const [inserted] = await db
          .insert(productionItems)
          .values({
            title: subject,
            brand: account.brandSlug,
            status: "Published",
            sourceType: "original",
            postType: "newsletter",
            accountId,
            platform: ["Newsletter"],
            platformContentId: campaign.id,
            publishedLink: dashboardUrl,
            publishedDate,
            publishedAt: sentAt,
            klaviyoListId: account.externalId,
            isExternal: false,
            editorUserId,
            utmCampaign: await generateUtmCampaign(subject),
            createdVia: "sync:klaviyo",
          })
          .returning({ id: productionItems.id });

        if (inserted) {
          result.insertedItemIds.push(inserted.id);
          result.created++;
          try {
            await recordItemCreated(db, {
              itemId: inserted.id,
              source: "sync:klaviyo",
              actorUserId: null,
              format: null,
              sourceType: "original",
              postType: "newsletter",
            });
          } catch (err) {
            console.error(
              "[sync:klaviyo] recordItemCreated failed",
              err instanceof Error ? err.message : err,
            );
          }
        }
      }

      nextUrl = page.links?.next ?? null;
    }

    await db
      .update(accounts)
      .set({
        lastContentSyncAt: new Date(),
        lastContentSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  } catch (err) {
    result.errors++;
    const msg = err instanceof Error ? err.message : String(err);
    result.errorMessage = msg;
    await db
      .update(accounts)
      .set({
        lastContentSyncAt: new Date(),
        lastContentSyncError: msg.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
    if (err instanceof KlaviyoError) {
      console.error(
        `[sync:klaviyo] account=${accountId} ${err.path} ${err.status}: ${msg}`,
      );
    } else {
      console.error(`[sync:klaviyo] account=${accountId} failed:`, err);
    }
  }

  return result;
}

function buildInitialUrl(args: {
  since: Date;
  until: Date;
  pageSize: number;
}): string {
  // Klaviyo's campaigns endpoint REQUIRES a filter on messages.channel.
  // Combine with status=Sent and the scheduled_at window — `send_time` is
  // not a filterable field on this resource (the API hard-rejects with
  // "filterable fields are: archived, created_at, id, messages.channel,
  // name, scheduled_at, status, updated_at"). For Sent campaigns
  // scheduled_at and send_time are equal, so the window means the same
  // thing in practice. Sort oldest-first so we ingest catch-up batches in
  // chronological order — easier to reason about than newest-first when
  // something fails mid-page. ISO timestamps must NOT be quoted in
  // Klaviyo's filter language; quoting causes a 400.
  const filter = [
    'equals(messages.channel,"email")',
    'equals(status,"Sent")',
    `greater-or-equal(scheduled_at,${args.since.toISOString()})`,
    `less-than(scheduled_at,${args.until.toISOString()})`,
  ].join(",");
  const params = new URLSearchParams({
    filter: `and(${filter})`,
    sort: "scheduled_at",
    "page[size]": String(args.pageSize),
  });
  return `/campaigns?${params.toString()}`;
}

/**
 * List newsletter accounts active for the cron sweep. Filtered to those with
 * an `externalId` (the Klaviyo list id) — accounts without one are
 * un-syncable (no list to filter on) and should surface a config error
 * rather than silently fail every tick.
 */
export async function selectNewsletterAccountsForSync(): Promise<
  Array<{ id: string; handle: string; externalId: string }>
> {
  const rows = await db
    .select({
      id: accounts.id,
      handle: accounts.handle,
      externalId: accounts.externalId,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.platform, "newsletter"),
        eq(accounts.isActive, true),
        isNull(accounts.deletedAt),
        isNotNull(accounts.externalId),
      ),
    )
    .orderBy(asc(accounts.createdAt));
  // Type narrowing: isNotNull guarantees externalId is non-null at runtime
  // but the type inferred by drizzle still includes null. Cast explicitly.
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    externalId: r.externalId as string,
  }));
}
