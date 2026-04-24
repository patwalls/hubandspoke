import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBrandBySlug, getEnabledBrands } from "@/lib/db/brands";
import { getAccounts, getContentCountsByAccount } from "@/lib/db/accounts";
import { AccountsSettingsContent } from "@/components/settings/accounts-settings";

interface BrandAccountsPageProps {
  params: Promise<{ brand: string }>;
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
}: BrandAccountsPageProps) {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) notFound();

  const [accounts, brands, contentCounts] = await Promise.all([
    getAccounts(),
    getEnabledBrands(),
    getContentCountsByAccount(),
  ]);

  return (
    <AccountsSettingsContent
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
        contentCount: contentCounts.get(a.id) ?? 0,
      }))}
      brands={brands.map((b) => ({ slug: b.slug, label: b.label }))}
      scopeBrandSlug={brand}
      hideHeader
    />
  );
}
