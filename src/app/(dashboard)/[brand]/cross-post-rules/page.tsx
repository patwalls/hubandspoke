import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BRANDS } from "@/lib/config/brands";
import { channelsForBrand } from "@/lib/config/channels";
import { CrossPostRulesPageContent } from "@/components/dashboard/cross-post-rules-page";

interface CrossPostRulesPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: CrossPostRulesPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);
  return {
    title: brandConfig
      ? `Cross-post rules · ${brandConfig.label}`
      : "Cross-post rules",
  };
}

export default async function BrandCrossPostRulesPage({
  params,
}: CrossPostRulesPageProps) {
  const { brand } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);
  if (!brandConfig) notFound();

  const channels = channelsForBrand(brand);

  return (
    <CrossPostRulesPageContent
      brand={brand}
      brandLabel={brandConfig.label}
      channels={channels}
    />
  );
}
