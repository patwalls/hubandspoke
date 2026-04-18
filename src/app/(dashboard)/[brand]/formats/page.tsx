import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BRANDS } from "@/lib/config/brands";
import { FormatsPageContent } from "@/components/dashboard/formats-page";

interface FormatsPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({ params }: FormatsPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);
  return { title: brandConfig ? `Formats · ${brandConfig.label}` : "Formats" };
}

export default async function BrandFormatsPage({ params }: FormatsPageProps) {
  const { brand } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);

  if (!brandConfig) {
    notFound();
  }

  return <FormatsPageContent brand={brand} />;
}
