import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getAccountsForBrand } from "@/lib/db/accounts";
import { CrossPostRulesPageContent } from "@/components/dashboard/cross-post-rules-page";

interface CrossPostRulesPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: CrossPostRulesPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandRow = await fetchBrandBySlug(brand);
  return {
    title: brandRow
      ? `Cross-post rules · ${brandRow.label}`
      : "Cross-post rules",
  };
}

export default async function BrandCrossPostRulesPage({
  params,
}: CrossPostRulesPageProps) {
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
    />
  );
}
