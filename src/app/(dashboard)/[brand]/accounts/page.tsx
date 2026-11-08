import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBrandBySlug, getEnabledBrands } from "@/lib/db/brands";
import { getAccounts, getContentCountsByAccount } from "@/lib/db/accounts";
import { AccountsSettingsContent } from "@/components/settings/accounts-settings";
import {
  platformSupportsBackfill,
  platformSupportsLatest,
} from "@/lib/services/account-content-sync";
import { connectNotice } from "@/lib/services/tiktok-draft/connect-match";

interface BrandAccountsPageProps {
  params: Promise<{ brand: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: BrandAccountsPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Accounts · ${brandConfig.label}` : "Accounts",
  };
}

export default async function BrandAccountsPage({
  params,
  searchParams,
}: BrandAccountsPageProps) {
  const { brand } = await params;
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) notFound();

  const [accounts, brands, contentCounts] = await Promise.all([
    getAccounts(),
    getEnabledBrands(),
    getContentCountsByAccount(),
  ]);

  // Result of the Zernio TikTok connect round-trip (callback/route.ts).
  const connectAccount = accounts.find((a) => a.id === one("account"));
  const notice = connectNotice(
    one("tiktokConnect"),
    connectAccount?.handle,
    one("connectedAs"),
  );

  return (
    <AccountsSettingsContent
      notice={notice}
      accounts={accounts.map((a) => ({
        id: a.id,
        brandSlug: a.brandSlug,
        brandLabel: a.brandLabel,
        platform: a.platform,
        handle: a.handle,
        displayName: a.displayName,
        url: a.url,
        avatarUrl: a.avatarUrl,
        bannerUrl: a.bannerUrl,
        bio: a.bio,
        followerCount: a.followerCount,
        followingCount: a.followingCount,
        postCount: a.postCount,
        totalViews: a.totalViews,
        verified: a.verified,
        location: a.location,
        isActive: a.isActive,
        syncedFromNotion: a.syncedFromNotion,
        lastRefreshedAt: a.lastRefreshedAt ? a.lastRefreshedAt.toISOString() : null,
        lastRefreshError: a.lastRefreshError,
        lastContentSyncAt: a.lastContentSyncAt
          ? a.lastContentSyncAt.toISOString()
          : null,
        lastContentSyncError: a.lastContentSyncError,
        syncSupported: platformSupportsLatest(a.platform),
        backfillSupported: platformSupportsBackfill(a.platform),
        contentCount: contentCounts.get(a.id) ?? 0,
        zernioAccountId: a.zernioAccountId,
      }))}
      brands={brands.map((b) => ({ slug: b.slug, label: b.label }))}
      scopeBrandSlug={brand}
      hideHeader
    />
  );
}
