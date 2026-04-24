import { db } from "@/lib/db";
import { accounts, brands, productionItems, userAccounts } from "@/lib/db/schema";
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

export type Account = typeof accounts.$inferSelect;

// Joined row most of the UI wants: account fields plus the brand slug/label
// so we don't need a second query to render an account pill.
export type AccountWithBrand = Account & {
  brandSlug: string;
  brandLabel: string;
};

export async function getAccounts(): Promise<AccountWithBrand[]> {
  const rows = await db
    .select({
      // Spread every column from accounts — keeps this in sync if we add
      // fields later without having to touch this query.
      account: accounts,
      brandSlug: brands.slug,
      brandLabel: brands.label,
    })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(isNull(accounts.deletedAt))
    .orderBy(asc(brands.label), asc(accounts.platform), asc(accounts.handle));
  return rows.map((r) => ({ ...r.account, brandSlug: r.brandSlug, brandLabel: r.brandLabel }));
}

export async function getAccountsForBrand(
  brandIdOrSlug: string
): Promise<AccountWithBrand[]> {
  // Accept either the uuid id or the slug — caller convenience.
  const isUuid = /^[0-9a-f-]{36}$/i.test(brandIdOrSlug);
  const rows = await db
    .select({ account: accounts, brandSlug: brands.slug, brandLabel: brands.label })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(
      and(
        isUuid ? eq(accounts.brandId, brandIdOrSlug) : eq(brands.slug, brandIdOrSlug),
        isNull(accounts.deletedAt)
      )
    )
    .orderBy(asc(accounts.platform), asc(accounts.handle));
  return rows.map((r) => ({ ...r.account, brandSlug: r.brandSlug, brandLabel: r.brandLabel }));
}

export async function getAccountById(
  id: string
): Promise<AccountWithBrand | null> {
  const [row] = await db
    .select({ account: accounts, brandSlug: brands.slug, brandLabel: brands.label })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)))
    .limit(1);
  if (!row) return null;
  return { ...row.account, brandSlug: row.brandSlug, brandLabel: row.brandLabel };
}

export async function getAccountsByIds(
  ids: string[]
): Promise<AccountWithBrand[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ account: accounts, brandSlug: brands.slug, brandLabel: brands.label })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(and(inArray(accounts.id, ids), isNull(accounts.deletedAt)));
  return rows.map((r) => ({ ...r.account, brandSlug: r.brandSlug, brandLabel: r.brandLabel }));
}

export async function getAccountsForUser(
  userId: string
): Promise<AccountWithBrand[]> {
  const rows = await db
    .select({ account: accounts, brandSlug: brands.slug, brandLabel: brands.label })
    .from(userAccounts)
    .innerJoin(accounts, eq(accounts.id, userAccounts.accountId))
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(and(eq(userAccounts.userId, userId), isNull(accounts.deletedAt)))
    .orderBy(asc(brands.label), asc(accounts.platform), asc(accounts.handle));
  return rows.map((r) => ({ ...r.account, brandSlug: r.brandSlug, brandLabel: r.brandLabel }));
}

/** Used by Notion sync + the MATG sync to resolve an incoming channel label
 *  to the right account row. Case-insensitive on handle; platform is the
 *  canonical key (`youtube` / `instagram` / `x` / etc.). */
export async function findAccount(params: {
  brandSlug: string;
  platform: string;
  handle: string;
}): Promise<Account | null> {
  const [row] = await db
    .select({ account: accounts })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(
      and(
        eq(brands.slug, params.brandSlug),
        eq(accounts.platform, params.platform),
        sql`lower(${accounts.handle}) = ${params.handle.toLowerCase()}`,
        isNull(accounts.deletedAt)
      )
    )
    .limit(1);
  return row?.account ?? null;
}

/** Resolve the single account for a (brand, platform) pair. Returns null if
 *  there's no account or more than one (SS has two X handles, so callers for
 *  that brand should use `findAccount` with an explicit handle). Useful for
 *  syncs where the handle is fixed at integration time (MATG). */
export async function findAccountForBrandPlatform(params: {
  brandSlug: string;
  platform: string;
}): Promise<Account | null> {
  const rows = await db
    .select({ account: accounts })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(
      and(
        eq(brands.slug, params.brandSlug),
        eq(accounts.platform, params.platform),
        isNull(accounts.deletedAt)
      )
    )
    .limit(2);
  if (rows.length !== 1) return null;
  return rows[0].account;
}

/** True if the user has linked the given account to their profile. */
export async function hasLinked(
  userId: string,
  accountId: string
): Promise<boolean> {
  const [row] = await db
    .select({ userId: userAccounts.userId })
    .from(userAccounts)
    .where(
      and(
        eq(userAccounts.userId, userId),
        eq(userAccounts.accountId, accountId)
      )
    )
    .limit(1);
  return Boolean(row);
}

/** Live count of content (production items) per account, excluding
 *  soft-deleted items. One GROUP BY query for the whole table — cheap,
 *  and lets the Accounts UI show "N pieces of content" per row without
 *  N+1 fetches. */
export async function getContentCountsByAccount(): Promise<Map<string, number>> {
  const rows = await db
    .select({ accountId: productionItems.accountId, n: count() })
    .from(productionItems)
    .where(
      and(
        isNotNull(productionItems.accountId),
        isNull(productionItems.deletedAt)
      )
    )
    .groupBy(productionItems.accountId);
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.accountId) map.set(r.accountId, Number(r.n));
  }
  return map;
}
