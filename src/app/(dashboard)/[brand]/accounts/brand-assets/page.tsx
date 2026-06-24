import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { db } from "@/lib/db";
import { brandWatermarks } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
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

  const watermarks = await db
    .select({
      id: brandWatermarks.id,
      fileName: brandWatermarks.fileName,
      sizeBytes: brandWatermarks.sizeBytes,
      createdAt: brandWatermarks.createdAt,
    })
    .from(brandWatermarks)
    .where(eq(brandWatermarks.brandId, brandConfig.id))
    .orderBy(desc(brandWatermarks.createdAt));

  return (
    <BrandAssetsSettings
      brand={brand}
      brandLabel={brandConfig.label}
      initialWatermarks={watermarks.map((w) => ({
        ...w,
        createdAt: w.createdAt.toISOString(),
      }))}
      initialGuidelines={brandConfig.brandGuidelines ?? null}
    />
  );
}
