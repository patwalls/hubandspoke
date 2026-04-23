import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { SettingsPageContent } from "@/components/dashboard/settings-page";

interface BrandGoalsPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: BrandGoalsPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Goals · ${brandConfig.label}` : "Goals",
  };
}

export default async function BrandGoalsPage({ params }: BrandGoalsPageProps) {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) notFound();

  return (
    <SettingsPageContent
      brand={brand}
      brandLabel={brandConfig.label}
      hideHeader
      section="goals"
    />
  );
}
