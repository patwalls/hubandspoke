import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { QueueView } from "@/components/dashboard/queue-view";
import { getClippableFormats, getFormatNameToIdMap } from "@/lib/db/formats";
import { auth } from "@/lib/auth";

interface BrandQueuePageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: BrandQueuePageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Queue · ${brandConfig.label}` : "Queue",
  };
}

export default async function BrandQueuePage({
  params,
}: BrandQueuePageProps) {
  const { brand } = await params;
  const [brandConfig, session, clippableFormats, formatNameToId] =
    await Promise.all([
      fetchBrandBySlug(brand),
      auth(),
      getClippableFormats(brand),
      getFormatNameToIdMap(brand),
    ]);

  if (!brandConfig) {
    notFound();
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <QueueView
        brand={brand}
        initialSource="all"
        clippableFormats={clippableFormats.map((f) => ({
          id: f.id,
          name: f.name,
          slug: f.slug,
        }))}
        formatNameToId={formatNameToId}
        isAdmin={session?.user?.role === "admin"}
      />
    </Suspense>
  );
}
