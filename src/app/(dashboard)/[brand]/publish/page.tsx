import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getReadyToPublish } from "@/lib/publish/ready";
import { ReadyToPublish } from "@/components/dashboard/ready-to-publish";

interface BrandPublishPageProps {
  params: Promise<{ brand: string }>;
  searchParams: Promise<{ focus?: string }>;
}

export async function generateMetadata({
  params,
}: BrandPublishPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Publish · ${brandConfig.label}` : "Publish",
  };
}

export default async function BrandPublishPage({
  params,
  searchParams,
}: BrandPublishPageProps) {
  const { brand } = await params;
  const { focus } = await searchParams;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig || brand === "all") {
    notFound();
  }
  const items = await getReadyToPublish(brand);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="mb-2 text-xl font-semibold text-foreground">Publish</h1>
      <ReadyToPublish brand={brand} items={items} focusId={focus ?? null} />
    </div>
  );
}
