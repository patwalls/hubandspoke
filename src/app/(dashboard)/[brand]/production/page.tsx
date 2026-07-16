import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { ProductionView } from "@/components/dashboard/production-view";
import { auth } from "@/lib/auth";

interface BrandProductionPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: BrandProductionPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `In Production · ${brandConfig.label}` : "In Production",
  };
}

export default async function BrandProductionPage({
  params,
}: BrandProductionPageProps) {
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
      <ProductionView
        brand={brand}
        currentUserId={session?.user?.id ?? null}
      />
    </Suspense>
  );
}
