import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getAccounts } from "@/lib/db/accounts";
import { getEnabledBrands } from "@/lib/db/brands";
import { AccountsSettingsContent } from "@/components/settings/accounts-settings";

export const metadata: Metadata = { title: "Accounts · Settings" };
export const dynamic = "force-dynamic";

export default async function AccountsSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const accounts = await getAccounts();
  const brands = await getEnabledBrands();

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
      }))}
      brands={brands.map((b) => ({ slug: b.slug, label: b.label }))}
    />
  );
}
