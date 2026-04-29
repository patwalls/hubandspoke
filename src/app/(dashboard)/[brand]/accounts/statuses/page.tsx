import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getBrandStatuses } from "@/lib/db/brand-statuses";
import { BrandStatusesSettings } from "@/components/settings/brand-statuses-settings";

interface BrandStatusesPageProps {
  params: Promise<{ brand: string }>;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: BrandStatusesPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Statuses · ${brandConfig.label}` : "Statuses",
  };
}

export default async function BrandStatusesPage({
  params,
}: BrandStatusesPageProps) {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) notFound();

  const initial = await getBrandStatuses(brand);

  return (
    <BrandStatusesSettings
      brand={brand}
      brandLabel={brandConfig.label}
      initial={initial.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        position: r.position,
        isPipelineColumn: r.isPipelineColumn,
        isProtected: r.isProtected,
      }))}
    />
  );
}
