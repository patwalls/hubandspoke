import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { BrandAssetsSettings } from "@/components/settings/brand-assets-settings";

interface BrandAssetsPageProps {
  params: Promise<{ brand: string }>;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: BrandAssetsPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Brand Assets · ${brandConfig.label}` : "Brand Assets",
  };
}

export default async function BrandAssetsPage({
  params,
}: BrandAssetsPageProps) {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) notFound();

  return (
    <BrandAssetsSettings
      brand={brand}
      brandLabel={brandConfig.label}
      hasWatermark={!!brandConfig.watermarkS3Key}
      initialGuidelines={brandConfig.brandGuidelines ?? null}
    />
  );
}
