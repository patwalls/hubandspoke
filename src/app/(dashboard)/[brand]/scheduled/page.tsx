import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getScheduledReviewData } from "@/lib/services/schedule-reconcile/review";
import { ScheduledReview } from "@/components/dashboard/scheduled-review";

interface BrandScheduledPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: BrandScheduledPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Scheduled · ${brandConfig.label}` : "Scheduled",
  };
}

export default async function BrandScheduledPage({
  params,
}: BrandScheduledPageProps) {
  const { brand } = await params;
  const [brandConfig, data] = await Promise.all([
    fetchBrandBySlug(brand),
    getScheduledReviewData(brand),
  ]);

  if (!brandConfig) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="mb-6 text-xl font-semibold text-foreground">Scheduled</h1>
      <ScheduledReview brand={brand} initialData={data} />
    </div>
  );
}
