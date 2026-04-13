import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ContentReport } from "@/components/dashboard/content-report";
import { MATGDashboard } from "@/components/dashboard/matg-dashboard";
import { BRANDS } from "@/lib/config/brands";

interface BrandPageProps {
  params: Promise<{ brand: string }>;
}

export default async function BrandDashboardPage({ params }: BrandPageProps) {
  const { brand } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);

  if (!brandConfig) {
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
      <ContentReport />
    </Suspense>
  );
}
