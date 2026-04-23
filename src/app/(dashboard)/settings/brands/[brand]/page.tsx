import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { SettingsPageContent } from "@/components/dashboard/settings-page";

interface BrandSettingsPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: BrandSettingsPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Settings · ${brandConfig.label}` : "Settings",
  };
}

export default async function BrandSettingsPage({
  params,
}: BrandSettingsPageProps) {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);

  if (!brandConfig) {
    notFound();
  }

  return <SettingsPageContent brand={brand} brandLabel={brandConfig.label} />;
}
