import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { QueueView } from "@/components/dashboard/queue-view";
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
  const [brandConfig, session] = await Promise.all([
    fetchBrandBySlug(brand),
    auth(),
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
        isAdmin={session?.user?.role === "admin"}
      />
    </Suspense>
  );
}
