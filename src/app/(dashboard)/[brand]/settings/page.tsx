import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BRANDS } from "@/lib/config/brands";
import { SettingsPageContent } from "@/components/dashboard/settings-page";

interface SettingsPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({ params }: SettingsPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);
  return { title: brandConfig ? `Settings · ${brandConfig.label}` : "Settings" };
}

export default async function BrandSettingsPage({ params }: SettingsPageProps) {
  const { brand } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);

  if (!brandConfig) {
    notFound();
  }

  return <SettingsPageContent brand={brand} brandLabel={brandConfig.label} />;
}
