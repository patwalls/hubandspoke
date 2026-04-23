import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { SettingsPageContent } from "@/components/dashboard/settings-page";

interface BrandBoundariesPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: BrandBoundariesPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Boundaries · ${brandConfig.label}` : "Boundaries",
  };
}

export default async function BrandBoundariesPage({
  params,
}: BrandBoundariesPageProps) {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) notFound();

  return (
    <SettingsPageContent
      brand={brand}
      brandLabel={brandConfig.label}
      hideHeader
      section="boundaries"
    />
  );
}
