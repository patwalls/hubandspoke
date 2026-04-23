import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { fetchBrandBySlug, getEnabledBrands } from "@/lib/db/brands";
import { getAccounts } from "@/lib/db/accounts";
import { AccountsSettingsContent } from "@/components/settings/accounts-settings";
import { SettingsPageContent } from "@/components/dashboard/settings-page";

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
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) notFound();

  const [accounts, brands] = await Promise.all([
    getAccounts(),
    getEnabledBrands(),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
          Accounts
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          {brandConfig.label}
        </p>
      </div>

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
        }))}
        brands={brands.map((b) => ({ slug: b.slug, label: b.label }))}
        scopeBrandSlug={brand}
        hideHeader
      />

      <SettingsPageContent
        brand={brand}
        brandLabel={brandConfig.label}
        hideHeader
      />
    </div>
  );
}
