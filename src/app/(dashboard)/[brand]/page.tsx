import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ContentReport } from "@/components/dashboard/content-report";
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
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <h2 className="text-xl font-semibold text-foreground mb-2">MATG</h2>
        <p className="text-muted-foreground max-w-md">
          This brand will be connected to Asana. No data has been synced yet.
        </p>
      </div>
    );
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
