import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getAccountsForBrand } from "@/lib/db/accounts";
import { CrossPostRulesPageContent } from "@/components/dashboard/cross-post-rules-page";

interface BrandCrossPostingPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: BrandCrossPostingPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandRow = await fetchBrandBySlug(brand);
  return {
    title: brandRow
      ? `Cross posting · ${brandRow.label}`
      : "Cross posting",
  };
}

export default async function BrandCrossPostingPage({
  params,
}: BrandCrossPostingPageProps) {
  const { brand } = await params;
  const brandRow = await fetchBrandBySlug(brand);
  if (!brandRow) notFound();

  // Only pickable accounts — active, non-"other" platforms. The picker's
  // options sort by platform then handle for a predictable order.
  const rawAccounts = await getAccountsForBrand(brand);
  const accounts = rawAccounts
    .filter((a) => a.isActive && a.platform !== "other")
    .map((a) => ({
      id: a.id,
      platform: a.platform,
      handle: a.handle,
      displayName: a.displayName,
      brandLabel: a.brandLabel,
    }));

  return (
    <CrossPostRulesPageContent
      brand={brand}
      brandLabel={brandRow.label}
      accounts={accounts}
      hideHeader
    />
  );
}
