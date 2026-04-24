import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ContentReport } from "@/components/dashboard/content-report";
import { MATGDashboard } from "@/components/dashboard/matg-dashboard";
import { fetchBrandBySlug } from "@/lib/db/brands";

interface BrandPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({ params }: BrandPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandRow = await fetchBrandBySlug(brand);
  return { title: brandRow ? `Dashboard · ${brandRow.label}` : "Dashboard" };
}

export default async function BrandDashboardPage({ params }: BrandPageProps) {
  const { brand } = await params;
  const brandRow = await fetchBrandBySlug(brand);

  if (!brandRow) {
    notFound();
  }

  if (brand === "matg") {
    return <MATGDashboard />;
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <ContentReport brand={brand} />
    </Suspense>
  );
}
