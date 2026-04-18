import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BRANDS } from "@/lib/config/brands";
import { ContentView } from "@/components/dashboard/content-view";

interface BrandContentPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({ params }: BrandContentPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);
  return { title: brandConfig ? `Content · ${brandConfig.label}` : "Content" };
}

export default async function BrandContentPage({ params }: BrandContentPageProps) {
  const { brand } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);

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
      <ContentView brand={brand} />
    </Suspense>
  );
}
