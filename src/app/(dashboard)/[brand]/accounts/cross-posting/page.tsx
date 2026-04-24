import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { loadCrossPostFeedData } from "@/lib/services/cross-post-feed-data";
import { CrossPostFeed } from "@/components/dashboard/cross-post-feed";

interface BrandCrossPostingPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: BrandCrossPostingPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandRow = await fetchBrandBySlug(brand);
  return {
    title: brandRow
      ? `Cross posting · ${brandRow.label}`
      : "Cross posting",
  };
}

export default async function BrandCrossPostingPage({
  params,
}: BrandCrossPostingPageProps) {
  const { brand } = await params;
  const brandRow = await fetchBrandBySlug(brand);
  if (!brandRow) notFound();

  const data = await loadCrossPostFeedData(brand);

  return <CrossPostFeed brand={brand} brandLabel={brandRow.label} data={data} />;
}
