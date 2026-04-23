import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { FormatsPageContent } from "@/components/dashboard/formats-page";

interface FormatsPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({ params }: FormatsPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return { title: brandConfig ? `Formats · ${brandConfig.label}` : "Formats" };
}

export default async function BrandFormatsPage({ params }: FormatsPageProps) {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);

  if (!brandConfig) {
    notFound();
  }

  return <FormatsPageContent brand={brand} />;
}
